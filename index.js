require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { PrismaClient } = require('@prisma/client');
const { Telegraf, Markup } = require('telegraf'); 
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 });
const prisma = new PrismaClient();

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;

let bot = null;

// 生成纯数字ID
const generateShortId = () => Math.floor(100000 + Math.random() * 900000).toString();

if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    console.log("🤖 Bot 启动中...");

    // 1. 帮助指令 /bz
    bot.command('bz', (ctx) => {
        ctx.reply(`🛠 **机器人指令大全**\n\n` +
                  `/ck - 查看数据统计\n` +
                  `/zc [密码] - 修改网页后台密码\n` +
                  `/sjkqk - 清空所有聊天数据\n` +
                  `删除 [ID] - 删除指定用户 (例如: 删除 888888)\n` +
                  `/start - 重新绑定通知群组`);
    });

    // 2. 启动 & 绑定通知
    bot.start(async (ctx) => {
        const chatId = String(ctx.chat.id);
        console.log(`📡 收到 /start, 绑定 ID: ${chatId}`);
        try {
            await prisma.globalConfig.upsert({
                where: { key: 'admin_tg_id' },
                update: { value: chatId },
                create: { key: 'admin_tg_id', value: chatId }
            });
            await prisma.globalConfig.upsert({
                where: { key: 'notification_switch' },
                update: { value: 'on' }, // 默认开启
                create: { key: 'notification_switch', value: 'on' }
            });
            ctx.reply(`✅ **绑定成功！**\n当前会话 ID: \`${chatId}\`\n新消息将推送到这里。\n请输入 /bz 查看指令。`, { parse_mode: 'Markdown' });
        } catch (e) {
            console.error("绑定失败:", e);
            ctx.reply("❌ 数据库错误，绑定失败。");
        }
    });

    // 3. 监听中文删除指令
    bot.hears(/^删除\s+(\d+)$/, (ctx) => {
        const targetId = ctx.match[1];
        ctx.reply(`⚠️ **确认删除用户 ${targetId}?**\n所有记录将永久丢失。`, 
            Markup.inlineKeyboard([
                [Markup.button.callback('❌ 取消', 'cancel_act'), Markup.button.callback('✅ 确认删除', `confirm_del_${targetId}`)]
            ])
        );
    });

    bot.action(/confirm_del_(.+)/, async (ctx) => {
        const targetId = ctx.match[1];
        try {
            await prisma.user.delete({ where: { id: targetId } });
            io.emit('admin_user_deleted', targetId);
            io.to(targetId).emit('force_logout');
            await ctx.editMessageText(`🗑️ 用户 \`${targetId}\` 已彻底删除。`, { parse_mode: 'Markdown' });
        } catch (e) { await ctx.editMessageText("❌ 删除失败 (用户可能不存在)"); }
    });

    bot.action('cancel_act', async (ctx) => {
        await ctx.editMessageText("🛡️ 操作已取消");
    });

    // 4. 清库指令
    bot.command('sjkqk', (ctx) => {
        ctx.reply('⚠️ **高能预警**\n\n确定要清空所有用户和消息吗？', 
            Markup.inlineKeyboard([
                [Markup.button.callback('❌ 取消', 'cancel_act'), Markup.button.callback('✅ 确认清空', 'confirm_clear_all')]
            ])
        );
    });

    // 5. 确认清库回调 (修复无效问题)
    bot.action('confirm_clear_all', async (ctx) => {
        console.log("执行清库操作...");
        try {
            // 只删数据，不删配置(如密码/TGID)
            await prisma.message.deleteMany({});
            await prisma.user.deleteMany({});
            io.emit('admin_db_cleared');
            io.emit('force_logout_all');
            await ctx.editMessageText("💥 **数据库已重置**\n所有数据已清除，配置项保留。");
        } catch (e) {
            console.error(e);
            await ctx.editMessageText("❌ 清库失败，请检查日志。");
        }
    });

    bot.command('ck', async (ctx) => {
        try {
            const u = await prisma.user.count();
            const m = await prisma.message.count();
            ctx.reply(`📊 用户: ${u}\n💬 消息: ${m}`);
        } catch (e) { ctx.reply("❌ DB Error"); }
    });

    bot.command('zc', async (ctx) => {
        const p = ctx.message.text.split(/\s+/)[1];
        if(!p) return ctx.reply("❌ 用法: /zc 新密码");
        await prisma.globalConfig.upsert({ where: { key: 'admin_password' }, update: { value: p }, create: { key: 'admin_password', value: p } });
        ctx.reply("✅ 密码已更新");
    });

    bot.launch().catch(e => console.error("Bot Launch Error:", e));
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ================= API =================
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    const c = await prisma.globalConfig.findUnique({ where: { key: 'admin_password' } });
    const valid = (c && c.value) || process.env.ADMIN_PASSWORD || "123456";
    res.json({ success: password === valid });
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { updatedAt: 'desc' },
            include: { messages: { take: 1, orderBy: { createdAt: 'desc' } } }
        });
        res.json(users);
    } catch (e) { res.json([]); }
});

app.get('/api/history/:userId', async (req, res) => {
    const msgs = await prisma.message.findMany({ where: { userId: req.params.userId }, orderBy: { createdAt: 'asc' } });
    res.json(msgs);
});

// 通知开关 API
app.get('/api/admin/notification', async (req, res) => {
    const c = await prisma.globalConfig.findUnique({ where: { key: 'notification_switch' } });
    res.json({ status: c ? c.value : 'on' });
});
app.post('/api/admin/notification', async (req, res) => {
    const { status } = req.body;
    await prisma.globalConfig.upsert({ where: { key: 'notification_switch' }, update: { value: status }, create: { key: 'notification_switch', value: status } });
    res.json({ success: true });
});

app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));

// ================= Socket =================
io.on('connection', (socket) => {
    socket.on('request_id', (bid, cb) => cb(generateShortId()));

    socket.on('join', ({ userId, isAdmin, bossId }) => {
        if(isAdmin) socket.join('admin_room');
        else if(userId) {
            socket.join(userId);
            if(bossId) prisma.user.upsert({where:{id:userId}, update:{bossId}, create:{id:userId, bossId}}).catch(()=>{});
        }
    });

    socket.on('admin_toggle_mute', async ({ userId, isMuted }) => {
        await prisma.user.update({ where: { id: userId }, data: { isMuted } });
        io.to('admin_room').emit('user_status_update', { userId, isMuted });
    });

    // 🔥 核心消息处理 (TG通知诊断重点)
    socket.on('send_message', async ({ userId, content, type, bossId }) => {
        let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
        
        // 1. 存库
        const msg = await prisma.message.create({ data: { userId, content, type: finalType, isFromUser: true } });
        
        // 2. 更新用户 (必须拿到最新的 isMuted 状态)
        const user = await prisma.user.upsert({
            where: { id: userId },
            update: { updatedAt: new Date(), bossId: bossId || '未知' },
            create: { id: userId, bossId: bossId || '未知' }
        });

        // 3. 推送前端
        io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: user.bossId, isMuted: user.isMuted });

        // 4. 🔥 TG 通知强逻辑
        if (bot) {
            // 4.1 全局开关检查
            const switchConfig = await prisma.globalConfig.findUnique({ where: { key: 'notification_switch' } });
            const isGlobalOn = !switchConfig || switchConfig.value === 'on';

            if (isGlobalOn) {
                // 4.2 单人静音检查
                if (!user.isMuted) {
                    try {
                        const config = await prisma.globalConfig.findUnique({ where: { key: 'admin_tg_id' } });
                        if (config && config.value) {
                            let mention = (bossId && bossId!=='未知') ? `@${bossId.replace('@','')}` : '';
                            const txt = finalType === 'image' ? "📷 [图片]" : content.substring(0, 100);
                            
                            // 发送！
                            await bot.telegram.sendMessage(config.value, `${mention} 🔔 **新消息**\n----------------\n👤 ID: \`${userId}\`\n🏷️ 来源: ${bossId}\n💬: ${txt}`, { 
                                parse_mode: 'Markdown',
                                ...Markup.inlineKeyboard([[Markup.button.callback(`🗑️ 删除 ${userId}`, `confirm_del_${userId}`)]])
                            });
                            console.log(`✅ TG通知已发送给 ${config.value}`);
                        } else {
                            console.log("❌ TG发送失败: 未找到 admin_tg_id (请执行 /start)");
                        }
                    } catch (e) {
                        console.error("❌ TG发送报错:", e.message);
                    }
                } else {
                    console.log(`🔕 用户 ${userId} 已静音，跳过通知`);
                }
            } else {
                console.log("🔕 全局通知已关闭");
            }
        }
    });

    // 🔥 丝滑回复修复：透传 tempId
    socket.on('admin_reply', async ({ targetUserId, content, type, tempId }) => { // 接收 tempId
        let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
        
        const msg = await prisma.message.create({ 
            data: { userId: targetUserId, content, type: finalType, isFromUser: false } 
        });

        // 广播时带回 tempId，前端即可去重
        const payload = { ...msg, bossId: 'System', tempId }; 
        
        io.to(targetUserId).emit('receive_message', msg);
        io.to('admin_room').emit('admin_receive_message', payload);
    });
});

server.listen(PORT, () => console.log(`System Online: ${PORT}`));
