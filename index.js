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
const io = new Server(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8,
    pingTimeout: 60000,
    pingInterval: 25000
});
const prisma = new PrismaClient();

// 内存数据
const onlineUsers = new Set();
// 记录哪些Socket连接已经收到过“休息中”的自动回复，避免刷屏
const socketAutoReplyHistory = new Set();

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_GROUP_ID = '-1003091925643'; // 建议放入 .env

// --- 业务逻辑配置 ---
const WELCOME_MESSAGE = `👋 您好！
这是一个教学演示界面。

👨‍💻 业务员正在与您连接...
我们将教您如何正确使用 Telegram 与老板直接沟通。

⏰ 业务员上班时间 (柬埔寨时间):
下午 13:00 - 晚上 23:00`;

const REST_MESSAGE = `💤 当前是休息时间 (柬埔寨 13:00-23:00 以外)。
有事请留言，业务员上班后会第一时间回复您！`;

// 检查是否在柬埔寨工作时间 (UTC+7, 13:00-23:00)
const isCambodiaWorkingTime = () => {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const cambodiaHours = (utcHours + 7) % 24; // 修正跨天问题
    return cambodiaHours >= 13 && cambodiaHours < 23;
};

let bot = null;
const generateShortId = () => Math.floor(100000 + Math.random() * 900000).toString();

if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    console.log("🤖 Bot 启动...");
    bot.on(['my_chat_member', 'new_chat_members', 'message'], async (ctx, next) => {
        if (ctx.chat.type === 'private') return next();
        if (String(ctx.chat.id) !== ALLOWED_GROUP_ID) {
            try { await ctx.leaveChat(); } catch(e){}
            return;
        }
        return next();
    });
    bot.start(async (ctx) => {
        if (String(ctx.chat.id) !== ALLOWED_GROUP_ID) return;
        ctx.reply(`✅ 系统在线\n绑定群组: \`${ALLOWED_GROUP_ID}\``);
    });
    bot.hears(/^删除\s+(\d+)$/, (ctx) => {
        if (String(ctx.chat.id) !== ALLOWED_GROUP_ID) return;
        const targetId = ctx.match[1];
        ctx.reply(`⚠️ 确认删除 ${targetId}?`, Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', 'cancel'), Markup.button.callback('✅ 确认', `del_${targetId}`)]]));
    });
    bot.action(/del_(.+)/, async (ctx) => {
        const targetId = ctx.match[1];
        try {
            await prisma.user.delete({ where: { id: targetId } });
            io.emit('admin_user_deleted', targetId);
            io.to(targetId).emit('force_logout');
            onlineUsers.delete(targetId);
            io.to('admin_room').emit('user_status_change', { userId: targetId, online: false });
            await ctx.editMessageText(`🗑️ 用户 ${targetId} 已删除`);
        } catch (e) { await ctx.editMessageText("❌ 删除失败"); }
    });
    bot.action('cancel', async (ctx) => { await ctx.editMessageText("已取消"); });
    bot.launch().catch(e => console.error(e));
}

// API
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
            include: { messages: { take: 1, orderBy: { createdAt: 'desc' } }, _count: { select: { messages: true } } }
        });
        res.json(users);
    } catch (e) { res.json([]); }
});

app.get('/api/history/:userId', async (req, res) => {
    try {
        const msgs = await prisma.message.findMany({ where: { userId: req.params.userId }, orderBy: { createdAt: 'asc' } });
        res.json(msgs);
    } catch(e) { res.json([]); }
});

app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));

// Socket
io.on('connection', (socket) => {
    socket.on('request_id', (bid, cb) => cb(generateShortId()));

    socket.on('join', async ({ userId, isAdmin, bossId }) => {
        if (isAdmin) {
            socket.join('admin_room');
            socket.emit('online_users_list', Array.from(onlineUsers));
        } else if (userId) {
            // 🛑 核心修改：严格检查拉黑状态
            const existingUser = await prisma.user.findUnique({ where: { id: userId } });
            
            if (existingUser && existingUser.isBlocked) {
                // 如果被拉黑，直接发消息通知前端并在服务端断开
                socket.emit('force_logout_blocked', 'Access Denied');
                socket.disconnect(true);
                return;
            }

            if (!existingUser) {
                if (bossId) {
                    await prisma.user.create({ data: { id: userId, bossId } });
                    socket.join(userId);
                    // 🎉 新用户：发送欢迎语
                    const welcomeMsg = await prisma.message.create({
                        data: { userId, content: WELCOME_MESSAGE, type: 'text', isFromUser: false, status: 'sent' }
                    });
                    socket.emit('receive_message', welcomeMsg);
                } else {
                    socket.emit('force_logout');
                    return;
                }
            } else {
                socket.join(userId);
                if (bossId) await prisma.user.update({ where: { id: userId }, data: { bossId } });
                
                // 如果是老用户但没有消息（比如被清空过），也可以补发欢迎语
                const msgCount = await prisma.message.count({ where: { userId } });
                if (msgCount === 0) {
                    const welcomeMsg = await prisma.message.create({
                        data: { userId, content: WELCOME_MESSAGE, type: 'text', isFromUser: false, status: 'sent' }
                    });
                    socket.emit('receive_message', welcomeMsg);
                }
            }

            socket.userId = userId;
            onlineUsers.add(userId);
            io.to('admin_room').emit('user_status_change', { userId, online: true });
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId) {
            onlineUsers.delete(socket.userId);
            socketAutoReplyHistory.delete(socket.id); // 清除该连接的自动回复记录
            io.to('admin_room').emit('user_status_change', { userId: socket.userId, online: false });
        }
    });

    socket.on('typing', ({ targetId, isTyping }) => {
        if (targetId === 'admin') {
            const rooms = Array.from(socket.rooms);
            const uid = rooms.find(r => r !== socket.id);
            if(uid) io.to('admin_room').emit('user_typing', { userId: uid, isTyping });
        } else {
            io.to(targetId).emit('display_typing', { isTyping });
        }
    });

    socket.on('mark_read', async ({ userId, isAdmin }) => {
        if (isAdmin) {
            await prisma.message.updateMany({ where: { userId, isFromUser: true, status: { not: 'read' } }, data: { status: 'read' } });
            io.to(userId).emit('messages_read_update');
        } else {
            await prisma.message.updateMany({ where: { userId, isFromUser: false, status: { not: 'read' } }, data: { status: 'read' } });
            io.to('admin_room').emit('admin_messages_read', { userId });
        }
    });

    socket.on('send_message', async ({ userId, content, type, bossId }) => {
        try {
            // 🛑 二次检查拉黑
            const u = await prisma.user.findUnique({where:{id:userId}});
            if(u && u.isBlocked) {
                socket.emit('force_logout_blocked');
                socket.disconnect(true);
                return;
            }

            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            const user = await prisma.user.upsert({ where: { id: userId }, update: { updatedAt: new Date(), bossId: bossId || '未知' }, create: { id: userId, bossId: bossId || '未知' } });
            
            const msg = await prisma.message.create({ data: { userId, content, type: finalType, isFromUser: true, status: 'sent' } });
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: user.bossId, isMuted: user.isMuted });

            // 🤖 自动回复逻辑：休息时间
            if (!isCambodiaWorkingTime()) {
                // 检查当前Socket连接是否已经发送过休息提示
                if (!socketAutoReplyHistory.has(socket.id)) {
                    const autoReply = await prisma.message.create({
                        data: { userId, content: REST_MESSAGE, type: 'text', isFromUser: false, status: 'sent' }
                    });
                    // 延迟1秒发送，看起来更自然
                    setTimeout(() => {
                        socket.emit('receive_message', autoReply);
                        io.to('admin_room').emit('admin_receive_message', { ...autoReply, bossId: 'System_Auto', isMuted: user.isMuted });
                    }, 1000);
                    socketAutoReplyHistory.add(socket.id); // 标记已发送
                }
            }

            if (bot && !user.isMuted) {
                const conf = await prisma.globalConfig.findUnique({ where: { key: 'notification_switch' } });
                if (!conf || conf.value === 'on') {
                    try {
                        let mention = (bossId && bossId!=='未知') ? `@${bossId.replace('@','')}` : '';
                        const txt = finalType === 'image' ? "📷 [图片]" : content.substring(0, 100);
                        await bot.telegram.sendMessage(ALLOWED_GROUP_ID, `${mention} 🔔 **消息**\nID: \`${userId}\`\n内容: ${txt}`, { 
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([[Markup.button.callback(`🗑️ 删除`, `del_${userId}`)]])
                        });
                    } catch(e) {}
                }
            }
        } catch(e) { console.error(e); }
    });

    socket.on('admin_reply', async ({ targetUserId, content, type, tempId }) => {
        try {
            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            const userExists = await prisma.user.findUnique({ where: { id: targetUserId } });
            if (!userExists) await prisma.user.create({ data: { id: targetUserId, bossId: 'SystemRestore' } });

            const msg = await prisma.message.create({ data: { userId: targetUserId, content, type: finalType, isFromUser: false, status: 'sent' } });
            io.to(targetUserId).emit('receive_message', msg);
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: 'System', tempId });
        } catch(e) { console.error(e); }
    });

    socket.on('admin_toggle_mute', async ({ userId, isMuted }) => {
        await prisma.user.update({ where: { id: userId }, data: { isMuted } });
        io.to('admin_room').emit('user_status_update', { userId, isMuted });
    });

    socket.on('admin_delete_message', async ({ messageId, userId }) => {
        try {
            await prisma.message.delete({ where: { id: messageId } });
            io.to('admin_room').emit('message_deleted', { messageId, userId });
            io.to(userId).emit('message_deleted', { messageId });
        } catch(e) {}
    });

    socket.on('admin_clear_user_data', async ({ userId }) => {
        try {
            await prisma.user.delete({ where: { id: userId } });
            io.emit('admin_user_deleted', userId);
            io.to(userId).emit('force_logout');
            onlineUsers.delete(userId);
            io.to('admin_room').emit('user_status_change', { userId, online: false });
        } catch(e) {}
    });

    socket.on('admin_block_user', async ({ userId }) => {
        try {
            await prisma.message.deleteMany({ where: { userId } });
            await prisma.user.update({ where: { id: userId }, data: { isBlocked: true, isMuted: true } });
            io.to('admin_room').emit('admin_user_blocked', userId);
            io.to(userId).emit('force_logout_blocked');
            const sockets = await io.in(userId).fetchSockets();
            sockets.forEach(s => s.disconnect(true));
            onlineUsers.delete(userId);
            io.to('admin_room').emit('user_status_change', { userId, online: false });
        } catch(e) {}
    });
});

server.listen(PORT, () => console.log(`Online: ${PORT}`));
