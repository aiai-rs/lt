require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { PrismaClient } = require('@prisma/client');
const { Telegraf, Markup } = require('telegraf');
const cors = require('cors');
const webpush = require('web-push');

// ==========================================
// 1. 初始化服务器与配置
// ==========================================
const app = express();
const prisma = new PrismaClient();

// 增加 Payload 限制，防止上传大图报错
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors({ origin: "*" })); // 允许跨域

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8, // 100MB 限制
    pingTimeout: 60000,     // 心跳超时
    pingInterval: 25000     // 心跳间隔
});

// 环境变量配置
const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_GROUP_ID = '-1003091925643'; 
const ADMIN_DEFAULT_PASS = "123456"; /

// 内存数据存储 (在线状态/防刷屏)
const onlineUsers = new Set();
const socketAutoReplyHistory = new Set(); 

// Web Push 配置 (如果配置了密钥)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.VAPID_EMAIL || 'mailto:admin@example.com',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
    console.log("✅ Web Push 推送服务已就绪");
}

// ==========================================
// 2. 辅助工具函数 & 话术
// ==========================================

const generateShortId = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

const isCambodiaWorkingTime = () => {
    // 柬埔寨时间 = UTC + 7
    const now = new Date();
    const utcHours = now.getUTCHours();
    const cambodiaHours = (utcHours + 7) % 24;
    // 上班时间：13:00 - 23:00
    return cambodiaHours >= 13 && cambodiaHours < 23;
};

// 自动回复话术
const WELCOME_MESSAGE = `👋 您好！
这里是汇盈国际业务员。

👨‍💻 业务员正在与您连接...你可以正常发送消息
我们将教您如何正确使用 Telegram 与老板直接沟通。

⏰ 业务员上班时间 (柬埔寨时间):
下午 13:00 - 晚上 23:00`;

const REST_MESSAGE = `💤 当前是休息时间 (柬埔寨 13:00-23:00 以外)。
有事请留言，业务员上班后会第一时间回复你！`;

// ==========================================
// 3. Telegram Bot 完整逻辑
// ==========================================
let bot = null;

if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    console.log("🤖 Telegram Bot 正在启动...");

    // 中间件：群组权限校验
    bot.use(async (ctx, next) => {
        // 如果是在群组发消息，必须是在指定的管理群
        if (ctx.chat && ctx.chat.type !== 'private') {
            if (String(ctx.chat.id) !== ALLOWED_GROUP_ID) {
                console.log(`⚠️ 检测到非法群组调用: ${ctx.chat.id}，正在退出...`);
                try { await ctx.leaveChat(); } catch(e) {}
                return;
            }
        }
        return next();
    });

    // 指令：开始
    bot.start((ctx) => {
        ctx.reply(`✅ 汇盈客服系统在线\n绑定群组: \`${ALLOWED_GROUP_ID}\`\n输入 /bz 查看所有指令`);
    });

    // 指令：帮助 /bz
    bot.command('bz', (ctx) => {
        ctx.reply(`🛠️ **管理员指令全集**
/bz - 显示此帮助
/ck - 查看用户列表 & 数据统计
/sjkqk - ⚠️ **暴力清空数据库** (慎用)
/zc 密码 - 修改后台登录密码
/del ID - 强制删除指定用户
        `, { parse_mode: 'Markdown' });
    });

    // 指令：清空数据库 /sjkqk (保留你要求的暴力逻辑)
    bot.command('sjkqk', (ctx) => {
        ctx.reply('⚠️ **高危警告：核弹级操作** ⚠️\n\n此操作将执行以下删除：\n1. ❌ 所有聊天记录\n2. ❌ 所有用户账号 (ID将失效)\n3. ❌ 所有推送订阅\n\n**所有用户将立即掉线！**\n确定执行吗？', 
            Markup.inlineKeyboard([
                [Markup.button.callback('❌ 取消', 'cancel')],
                [Markup.button.callback('💥 确认全部清空', 'confirm_clear_all')]
            ])
        );
    });

    // 动作：执行清空
    bot.action('confirm_clear_all', async (ctx) => {
        try {
            console.log("🚨 执行全库清空操作...");
            await prisma.pushSubscription.deleteMany({});
            await prisma.message.deleteMany({});
            await prisma.user.deleteMany({}); // 这里会删除所有用户ID
            
            // 通知所有 Socket 客户端
            io.emit('admin_db_cleared');
            io.emit('force_logout_all');
            
            onlineUsers.clear();
            await ctx.editMessageText("💥 **数据库已成功重置**\n所有数据已永久抹除，系统已初始化。");
        } catch (e) {
            console.error("清空失败:", e);
            await ctx.editMessageText(`❌ 清空失败: ${e.message}`);
        }
    });

    // 指令：注册/修改密码 /zc
    bot.command('zc', async (ctx) => {
        const password = ctx.message.text.split(/\s+/)[1];
        if(!password) return ctx.reply("❌ 用法: /zc 新密码");
        
        try {
            await prisma.globalConfig.upsert({
                where: { key: 'admin_password' },
                update: { value: password },
                create: { key: 'admin_password', value: password }
            });
            io.emit('force_admin_relogin'); // 让后台管理员重新登录
            ctx.reply(`✅ 管理员密码已更新为: \`${password}\``, { parse_mode: 'Markdown' });
        } catch(e) {
            ctx.reply("❌ 密码修改失败");
        }
    });

    // 指令：查看数据 /ck
    bot.command('ck', async (ctx) => {
        try {
            const userCount = await prisma.user.count();
            const msgCount = await prisma.message.count();
            const subCount = await prisma.pushSubscription.count();
            
            // 获取最近活跃用户
            const users = await prisma.user.findMany({
                take: 10,
                orderBy: { updatedAt: 'desc' },
                include: { _count: { select: { messages: true } } }
            });

            let text = `📊 **系统状态统计**\n👥 总用户数: ${userCount}\n📡 推送订阅: ${subCount}\n💬 总消息数: ${msgCount}\n\n📝 **最近活跃用户 (Top 10):**\n`;
            const buttons = [];

            users.forEach(u => {
                const boss = u.bossId || '无';
                text += `🆔 \`${u.id}\` | 👤 ${boss} | 💬 ${u._count.messages}\n`;
                buttons.push([Markup.button.callback(`🗑️ 删除 ${u.id}`, `del_${u.id}`)]);
            });

            buttons.push([Markup.button.callback('❌ 关闭列表', 'cancel')]);

            await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
        } catch (e) {
            console.error(e);
            ctx.reply("❌ 查询数据库失败");
        }
    });

    // 动作：删除用户
    bot.action(/del_(.+)/, async (ctx) => {
        const targetId = ctx.match[1];
        try {
            await prisma.user.delete({ where: { id: targetId } }); // 级联删除消息
            
            // Socket 通知
            io.emit('admin_user_deleted', targetId);
            io.to(targetId).emit('force_logout');
            
            onlineUsers.delete(targetId);
            io.to('admin_room').emit('user_status_change', { userId: targetId, online: false });
            
            await ctx.answerCbQuery(`用户 ${targetId} 已删除`);
            await ctx.reply(`🗑️ 用户 \`${targetId}\` 及其所有记录已移除`, { parse_mode: 'Markdown' });
        } catch (e) {
            await ctx.answerCbQuery("删除失败或用户不存在");
        }
    });

    bot.action('cancel', async (ctx) => { await ctx.deleteMessage(); });
    
    bot.launch().then(() => console.log("✅ Bot 已连接 Telegram API")).catch(e => console.error("❌ Bot 启动失败:", e));
}

// ==========================================
// 4. Express API 路由
// ==========================================

// 📌 核心修复：找回账号验证接口
app.post('/api/user/check', async (req, res) => {
    try {
        const { userId } = req.body;
        console.log(`🔍 收到用户验证请求: ${userId}`);
        
        if (!userId) return res.json({ exists: false });
        
        const user = await prisma.user.findUnique({ where: { id: userId } });
        console.log(`✅ 验证结果: ${!!user ? '存在' : '不存在'}`);
        
        res.json({ exists: !!user });
    } catch (e) {
        console.error("❌ 验证接口出错:", e);
        res.status(500).json({ exists: false });
    }
});

// 📌 管理员登录接口 (你之前有的)
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    try {
        const config = await prisma.globalConfig.findUnique({ where: { key: 'admin_password' } });
        const validPassword = (config && config.value) || ADMIN_DEFAULT_PASS;
        
        if (password === validPassword) {
            res.json({ success: true });
        } else {
            res.json({ success: false });
        }
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// 📌 获取 VAPID Key
app.get('/api/vapid-key', (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// 📌 订阅推送
app.post('/api/subscribe', async (req, res) => {
    const { userId, subscription } = req.body;
    if (!userId || !subscription || !subscription.endpoint) {
        return res.status(400).json({ error: '无效的订阅数据' });
    }
    try {
        await prisma.pushSubscription.upsert({
            where: { endpoint: subscription.endpoint },
            update: { userId, keys: subscription.keys },
            create: { userId, endpoint: subscription.endpoint, keys: subscription.keys }
        });
        res.status(201).json({ success: true });
    } catch (e) {
        console.error("订阅失败:", e);
        res.status(500).json({});
    }
});

// 📌 获取历史记录
app.get('/api/history/:userId', async (req, res) => {
    try {
        const msgs = await prisma.message.findMany({ 
            where: { userId: req.params.userId }, 
            orderBy: { createdAt: 'asc' } 
        });
        res.json(msgs);
    } catch(e) { 
        res.json([]); 
    }
});

// 📌 获取管理员用户列表
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { updatedAt: 'desc' },
            include: { 
                messages: { take: 1, orderBy: { createdAt: 'desc' } }, 
                _count: { 
                    select: { 
                        messages: { where: { isFromUser: true, status: 'sent' } } 
                    } 
                } 
            }
        });
        
        // 格式化数据给前端
        const formattedUsers = users.map(u => ({
            id: u.id,
            bossId: u.bossId,
            updatedAt: u.updatedAt,
            lastMessage: u.messages[0] ? u.messages[0].content : '',
            lastMessageType: u.messages[0] ? u.messages[0].type : 'text',
            unreadCount: u._count.messages,
            isBlocked: u.isBlocked,
            isMuted: u.isMuted,
            isOnline: onlineUsers.has(u.id)
        }));
        
        res.json(formattedUsers);
    } catch (e) { 
        res.status(500).json([]); 
    }
});

// 📌 托管后台页面 (如果有的话)
app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/admin.html');
});

// ==========================================
// 5. Socket.io 核心业务逻辑
// ==========================================
io.on('connection', (socket) => {
    console.log(`🔌 新连接: ${socket.id}`);

    // 生成随机 ID
    socket.on('request_id', (bid, cb) => {
        const newId = generateShortId();
        console.log(`🆕 生成新ID: ${newId}`);
        cb(newId);
    });

    // 加入聊天
    socket.on('join', async ({ userId, isAdmin, bossId }) => {
        if (isAdmin) {
            socket.join('admin_room');
            socket.emit('online_users_list', Array.from(onlineUsers));
            console.log(`👨‍💼 管理员加入`);
        } else if (userId) {
            // 检查用户
            const existingUser = await prisma.user.findUnique({ where: { id: userId } });
            
            // 拉黑检查
            if (existingUser && existingUser.isBlocked) {
                socket.emit('force_logout_blocked');
                socket.disconnect(true);
                return;
            }

            if (!existingUser) {
                // 新用户注册逻辑
                if (bossId && bossId !== 'SystemRestore') {
                    console.log(`✨ 新用户注册: ${userId} -> ${bossId}`);
                    await prisma.user.create({ data: { id: userId, bossId: bossId } });
                    
                    socket.join(userId);
                    
                    // 发送欢迎语
                    const welcomeMsg = await prisma.message.create({
                        data: { userId, content: WELCOME_MESSAGE, type: 'text', isFromUser: false, status: 'sent' }
                    });
                    socket.emit('receive_message', welcomeMsg);
                } else {
                    // ID不存在 且 不是注册模式 -> 踢出 (找回失败逻辑)
                    console.log(`🚫 非法登录尝试: ${userId}`);
                    socket.emit('force_logout');
                    return;
                }
            } else {
                // 老用户登录
                console.log(`🔙 用户回归: ${userId}`);
                socket.join(userId);
                
                // 更新 BossID (除非是找回模式)
                if (bossId && bossId !== 'SystemRestore') {
                    await prisma.user.update({ where: { id: userId }, data: { bossId } });
                }
            }
            
            socket.userId = userId;
            onlineUsers.add(userId);
            // 通知管理员该用户上线
            io.to('admin_room').emit('user_status_change', { userId, online: true });
        }
    });

    // 断开连接
    socket.on('disconnect', () => {
        if (socket.userId) {
            console.log(`🔌 用户下线: ${socket.userId}`);
            onlineUsers.delete(socket.userId);
            socketAutoReplyHistory.delete(socket.id);
            io.to('admin_room').emit('user_status_change', { userId: socket.userId, online: false });
        }
    });

    // 正在输入
    socket.on('typing', ({ targetId, isTyping }) => {
        if (targetId === 'admin') {
            const rooms = Array.from(socket.rooms);
            const uid = rooms.find(r => r !== socket.id);
            if(uid) io.to('admin_room').emit('user_typing', { userId: uid, isTyping });
        } else {
            io.to(targetId).emit('display_typing', { isTyping });
        }
    });

    // 标记已读
    socket.on('mark_read', async ({ userId, isAdmin }) => {
        if (isAdmin) {
            await prisma.message.updateMany({ where: { userId, isFromUser: true, status: { not: 'read' } }, data: { status: 'read' } });
            io.to(userId).emit('messages_read_update');
            io.to('admin_room').emit('admin_messages_read_sync', { userId });
        } else {
            await prisma.message.updateMany({ where: { userId, isFromUser: false, status: { not: 'read' } }, data: { status: 'read' } });
            io.to('admin_room').emit('admin_messages_read', { userId });
        }
    });

    // 用户发送消息
    socket.on('send_message', async ({ userId, content, type, bossId }) => {
        try {
            // 安全检查
            const u = await prisma.user.findUnique({where:{id:userId}});
            if(u && u.isBlocked) { socket.emit('force_logout_blocked'); return; }

            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            
            // 确保用户存在
            const user = await prisma.user.upsert({ 
                where: { id: userId }, 
                update: { updatedAt: new Date(), bossId: bossId || '未知' }, 
                create: { id: userId, bossId: bossId || '未知' } 
            });
            
            // 存入数据库
            const msg = await prisma.message.create({ 
                data: { userId, content, type: finalType, isFromUser: true, status: 'sent' } 
            });
            
            // 推送给管理员
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: user.bossId, isMuted: user.isMuted });

            // 自动回复逻辑 (非工作时间)
            if (!isCambodiaWorkingTime()) {
                if (!socketAutoReplyHistory.has(socket.id)) {
                    const autoReply = await prisma.message.create({ 
                        data: { userId, content: REST_MESSAGE, type: 'text', isFromUser: false, status: 'sent' } 
                    });
                    setTimeout(() => {
                        socket.emit('receive_message', autoReply);
                        io.to('admin_room').emit('admin_receive_message', { ...autoReply, bossId: 'System_Auto', isMuted: user.isMuted });
                    }, 1000);
                    socketAutoReplyHistory.add(socket.id);
                }
            }

            // Telegram 机器人通知
            if (bot && !user.isMuted) {
                const conf = await prisma.globalConfig.findUnique({ where: { key: 'notification_switch' } });
                const isNotifyOn = !conf || conf.value === 'on';
                
                if (isNotifyOn) {
                    try {
                        let mention = (bossId && bossId!=='未知') ? `@${bossId.replace('@','')}` : '';
                        const txt = finalType === 'image' ? "📷 [图片]" : content.substring(0, 100);
                        
                        await bot.telegram.sendMessage(ALLOWED_GROUP_ID, `${mention} 🔔 **新消息**\nID: \`${userId}\`\n内容: ${txt}`, { 
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([[Markup.button.callback(`🗑️ 删除此人`, `del_${userId}`)]])
                        });
                    } catch(e) { console.error("TG通知失败:", e.message); }
                }
            }
        } catch(e) { console.error("发送失败:", e); }
    });

    // 管理员回复消息
    socket.on('admin_reply', async ({ targetUserId, content, type, tempId }) => {
        try {
            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            // 确保用户存在
            const userExists = await prisma.user.findUnique({ where: { id: targetUserId } });
            if (!userExists) await prisma.user.create({ data: { id: targetUserId, bossId: 'SystemRestore' } });

            const msg = await prisma.message.create({ 
                data: { userId: targetUserId, content, type: finalType, isFromUser: false, status: 'sent' } 
            });
            
            io.to(targetUserId).emit('receive_message', msg);
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: 'System', tempId });

            // Web Push 推送
            if (process.env.VAPID_PUBLIC_KEY) {
                const subs = await prisma.pushSubscription.findMany({ where: { userId: targetUserId } });
                const payload = JSON.stringify({
                    title: '新消息提醒',
                    body: finalType === 'image' ? '[发来一张图片]' : (content.length > 30 ? content.substring(0, 30) + '...' : content),
                    url: '/' 
                });
                
                subs.forEach(sub => {
                    webpush.sendNotification(
                        sub.keys ? { endpoint: sub.endpoint, keys: sub.keys } : sub.endpoint, 
                        payload
                    ).catch(error => {
                        if (error.statusCode === 404 || error.statusCode === 410) {
                            prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(()=>{});
                        }
                    });
                });
            }
        } catch(e) { console.error(e); }
    });

    // --- 管理员操作指令监听 ---

    // 1. 切换静音
    socket.on('admin_toggle_mute', async ({ userId, isMuted }) => {
        await prisma.user.update({ where: { id: userId }, data: { isMuted } });
        io.to('admin_room').emit('user_status_update', { userId, isMuted });
    });

    // 2. 删除单条消息
    socket.on('admin_delete_message', async ({ messageId, userId }) => {
        try {
            await prisma.message.delete({ where: { id: messageId } });
            io.to('admin_room').emit('message_deleted', { messageId, userId });
            io.to(userId).emit('message_deleted', { messageId });
        } catch(e) {}
    });

    // 3. 删除用户 (清空数据)
    socket.on('admin_clear_user_data', async ({ userId }) => {
        try {
            await prisma.user.delete({ where: { id: userId } }); // 级联删除消息
            io.emit('admin_user_deleted', userId);
            io.to(userId).emit('force_logout');
            onlineUsers.delete(userId);
            io.to('admin_room').emit('user_status_change', { userId, online: false });
        } catch(e) {}
    });

    // 4. 拉黑用户
    socket.on('admin_block_user', async ({ userId }) => {
        try {
            // 清空记录
            await prisma.message.deleteMany({ where: { userId } });
            await prisma.pushSubscription.deleteMany({ where: { userId } });
            // 标记拉黑
            await prisma.user.update({ where: { id: userId }, data: { isBlocked: true, isMuted: true } });
            
            io.to('admin_room').emit('admin_user_blocked', userId);
            io.to(userId).emit('force_logout_blocked');
            
            // 强制断开 Socket
            const sockets = await io.in(userId).fetchSockets();
            sockets.forEach(s => s.disconnect(true));
            
            onlineUsers.delete(userId);
            io.to('admin_room').emit('user_status_change', { userId, online: false });
        } catch(e) {}
    });
});

// 启动监听
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
