require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { PrismaClient } = require('@prisma/client');
const { Telegraf, Markup } = require('telegraf'); 
const cors = require('cors');

// ================= 系统配置 =================
const app = express();
app.use(cors());
// 开启大文件支持 (50MB) 以防止图片上传报错
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const server = http.createServer(app);
// Socket 配置：允许跨域，设置最大缓冲为 100MB
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 
});
const prisma = new PrismaClient();

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
// 🔥 唯一允许的群组 ID (铁血规则)
const ALLOWED_GROUP_ID = '-1003091925643';

let bot = null;

// 生成 6 位随机数字 ID
const generateShortId = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// ================= Bot 机器人逻辑 =================
if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    console.log("🤖 机器人系统初始化...");

    // 1. 全局中间件：群组白名单检测
    bot.on(['my_chat_member', 'new_chat_members', 'message'], async (ctx, next) => {
        const chatId = String(ctx.chat.id);
        const type = ctx.chat.type;

        // 私聊允许 (用于设置密码等敏感操作)
        if (type === 'private') {
            return next();
        }

        // 群聊检测：如果不是指定群，直接退出
        if (chatId !== ALLOWED_GROUP_ID) {
            console.log(`❌ 拒绝服务非法群组: ${chatId}`);
            try {
                await ctx.reply("🚫 本机器人仅服务于特定群组，正在退出...");
                await ctx.leaveChat();
            } catch(e) {
                console.error("退群失败:", e);
            }
            return; // 终止后续操作
        }

        // 合法群组，放行
        return next();
    });

    // 2. /bz 帮助指令
    bot.command('bz', (ctx) => {
        ctx.reply(`🛠 **系统指令清单**\n\n` +
                  `/ck - 查看服务器数据状态\n` +
                  `/zc [密码] - 修改后台登录密码\n` +
                  `/sjkqk - 💥 清空所有数据库\n` +
                  `删除 [ID] - 删除指定用户 (例: 删除 888888)\n` +
                  `/start - 激活本群通知`);
    });

    // 3. /start 启动与绑定
    bot.start(async (ctx) => {
        // 双重校验：只在私聊或白名单群响应
        if (ctx.chat.type !== 'private' && String(ctx.chat.id) !== ALLOWED_GROUP_ID) return;

        ctx.reply(`✅ **系统已连接**\n\n🛡️ 当前运行环境安全\n📍 绑定通知群组: \`${ALLOWED_GROUP_ID}\`\n\n所有客户消息将实时推送到此群。`);
    });

    // 4. 中文指令 "删除 123456"
    bot.hears(/^删除\s+(\d+)$/, (ctx) => {
        // 再次校验群组权限
        if (String(ctx.chat.id) !== ALLOWED_GROUP_ID && ctx.chat.type !== 'private') return;
        
        const targetId = ctx.match[1];
        ctx.reply(`⚠️ **高危操作确认**\n\n您申请删除用户: \`${targetId}\`\n该操作不可恢复，是否继续？`, 
            Markup.inlineKeyboard([
                [
                    Markup.button.callback('❌ 取消操作', 'cancel_act'), 
                    Markup.button.callback('✅ 确认删除', `confirm_del_${targetId}`)
                ]
            ])
        );
    });

    // 5. 确认删除回调
    bot.action(/confirm_del_(.+)/, async (ctx) => {
        const targetId = ctx.match[1];
        try {
            await prisma.user.delete({ where: { id: targetId } });
            // 通知前端移除
            io.emit('admin_user_deleted', targetId);
            // 强制踢该用户下线
            io.to(targetId).emit('force_logout');
            
            await ctx.editMessageText(`🗑️ **操作成功**\n用户 \`${targetId}\` 及其聊天记录已彻底删除。`, { parse_mode: 'Markdown' });
        } catch (e) {
            await ctx.editMessageText("❌ 删除失败：用户可能不存在或数据库繁忙。");
        }
    });

    // 6. 取消回调
    bot.action('cancel_act', async (ctx) => {
        await ctx.editMessageText("🛡️ 操作已取消，数据安全。");
    });

    // 7. /sjkqk 清库指令
    bot.command('sjkqk', (ctx) => {
        if (String(ctx.chat.id) !== ALLOWED_GROUP_ID && ctx.chat.type !== 'private') return;
        
        ctx.reply('⚠️ **严重警告：清空数据库**\n\n此操作将删除所有用户和消息记录！\n确定要执行吗？', 
            Markup.inlineKeyboard([
                [Markup.button.callback('❌ 立刻取消', 'cancel_act'), Markup.button.callback('✅ 确认清空', 'confirm_clear_all')]
            ])
        );
    });

    // 8. 确认清库回调
    bot.action('confirm_clear_all', async (ctx) => {
        try {
            await prisma.message.deleteMany({});
            await prisma.user.deleteMany({});
            
            // 发送全局广播
            io.emit('admin_db_cleared');
            io.emit('force_logout_all'); // 踢掉所有人
            
            await ctx.editMessageText("💥 **数据库已格式化**\n系统已重置为初始状态。");
        } catch (e) {
            await ctx.editMessageText("❌ 清库失败，请检查日志。");
        }
    });

    // 9. /ck 查状态
    bot.command('ck', async (ctx) => {
        try {
            const u = await prisma.user.count();
            const m = await prisma.message.count();
            ctx.reply(`📊 **实时数据监控**\n\n👤 活跃用户: ${u}\n💬 消息总数: ${m}`);
        } catch (e) {
            ctx.reply("❌ 数据库连接异常");
        }
    });

    // 10. /zc 改密码 (含强制踢人)
    bot.command('zc', async (ctx) => {
        const p = ctx.message.text.split(/\s+/)[1];
        if(!p) return ctx.reply("❌ 格式错误，请发送: /zc 新密码");
        
        try {
            await prisma.globalConfig.upsert({ 
                where: { key: 'admin_password' }, 
                update: { value: p }, 
                create: { key: 'admin_password', value: p } 
            });
            
            // 🔥 核心安全机制：改密码后踢掉所有在线管理员
            io.emit('force_admin_relogin');
            
            ctx.reply(`✅ **密码已更新**\n新密码: ||${p}||\n\n已强制所有后台管理员下线。`, { parse_mode: 'MarkdownV2' });
        } catch (e) {
            ctx.reply("❌ 密码保存失败");
        }
    });

    // 启动 Bot
    bot.launch().catch(e => console.error("Bot启动失败:", e));
    
    // 优雅退出处理
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ================= API 接口区域 =================

// 1. 管理员登录
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    try {
        const c = await prisma.globalConfig.findUnique({ where: { key: 'admin_password' } });
        // 默认密码兜底：123456
        const valid = (c && c.value) || process.env.ADMIN_PASSWORD || "123456";
        
        if (password === valid) {
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, msg: "密码错误" });
        }
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// 2. 获取用户列表 (带消息计数统计)
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { updatedAt: 'desc' },
            include: {
                messages: { 
                    take: 1, 
                    orderBy: { createdAt: 'desc' } 
                },
                // 🔥 关键：统计该用户的消息总条数
                _count: { 
                    select: { messages: true } 
                } 
            }
        });
        res.json(users);
    } catch (e) { res.json([]); }
});

// 3. 获取聊天记录
app.get('/api/history/:userId', async (req, res) => {
    try {
        const msgs = await prisma.message.findMany({ 
            where: { userId: req.params.userId }, 
            orderBy: { createdAt: 'asc' } 
        });
        res.json(msgs);
    } catch (e) { res.json([]); }
});

// 4. 通知开关 API
app.get('/api/admin/notification', async (req, res) => {
    const c = await prisma.globalConfig.findUnique({ where: { key: 'notification_switch' } });
    res.json({ status: c ? c.value : 'on' });
});
app.post('/api/admin/notification', async (req, res) => {
    const { status } = req.body;
    await prisma.globalConfig.upsert({ 
        where: { key: 'notification_switch' }, 
        update: { value: status }, 
        create: { key: 'notification_switch', value: status } 
    });
    res.json({ success: true });
});

// 5. 托管前端页面
app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/admin.html');
});

// ================= Socket.io 实时通讯 =================
io.on('connection', (socket) => {
    
    // 1. 分配 ID
    socket.on('request_id', (bid, cb) => cb(generateShortId()));

    // 2. 加入房间
    socket.on('join', ({ userId, isAdmin, bossId }) => {
        if(isAdmin) {
            socket.join('admin_room');
        } else if(userId) {
            socket.join(userId);
            // 记录用户来源
            if(bossId) {
                prisma.user.upsert({
                    where:{id:userId}, 
                    update:{bossId}, 
                    create:{id:userId, bossId}
                }).catch(()=>{});
            }
        }
    });

    // 3. 静音开关
    socket.on('admin_toggle_mute', async ({ userId, isMuted }) => {
        try {
            await prisma.user.update({ where: { id: userId }, data: { isMuted } });
            io.to('admin_room').emit('user_status_update', { userId, isMuted });
        } catch(e) {}
    });

    // 4. 🔥 接收用户消息 (核心逻辑)
    socket.on('send_message', async ({ userId, content, type, bossId }) => {
        let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
        
        // 存入数据库
        const msg = await prisma.message.create({ 
            data: { userId, content, type: finalType, isFromUser: true } 
        });
        
        // 更新用户时间
        const user = await prisma.user.upsert({ 
            where: { id: userId }, 
            update: { updatedAt: new Date(), bossId: bossId || '未知' }, 
            create: { id: userId, bossId: bossId || '未知' } 
        });

        // 推送给前端 (Admin UI)
        io.to('admin_room').emit('admin_receive_message', { 
            ...msg, 
            bossId: user.bossId, 
            isMuted: user.isMuted 
        });

        // 🔥 TG 通知逻辑 (强制发送到 ALLOWED_GROUP_ID)
        if (bot && !user.isMuted) {
            const switchConfig = await prisma.globalConfig.findUnique({ where: { key: 'notification_switch' } });
            // 全局开关检查
            if (!switchConfig || switchConfig.value === 'on') {
                try {
                    let mention = (bossId && bossId!=='未知') ? `@${bossId.replace('@','')}` : '';
                    const txt = finalType === 'image' ? "📷 [图片]" : content.substring(0, 100);
                    
                    // 强制推送到白名单群
                    await bot.telegram.sendMessage(ALLOWED_GROUP_ID, `${mention} 🔔 **新消息**\n----------------\n👤 ID: \`${userId}\`\n🏷️ 来源: ${bossId}\n💬 内容: ${txt}`, { 
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback(`🗑️ 删除此用户`, `confirm_del_${userId}`)]
                        ])
                    });
                } catch(e) {
                    console.error("TG发送失败: 可能Bot未在白名单群组中", e.message);
                }
            }
        }
    });

    // 5. 管理员回复 (丝滑模式支持)
    socket.on('admin_reply', async ({ targetUserId, content, type, tempId }) => {
        let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
        
        const msg = await prisma.message.create({ 
            data: { userId: targetUserId, content, type: finalType, isFromUser: false } 
        });
        
        // 发给用户
        io.to(targetUserId).emit('receive_message', msg);
        
        // 广播回后台 (带 tempId 以便去重)
        io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: 'System', tempId });
    });
});

// ================= 服务启动 =================
server.listen(PORT, () => {
    console.log(`🚀 服务已启动，监听端口: ${PORT}`);
});
