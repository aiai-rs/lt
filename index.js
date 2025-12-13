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

// 内存中维护在线用户 Set
const onlineUsers = new Set();

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_GROUP_ID = '-1003091925643'; // 建议放入 env

let bot = null;
const generateShortId = () => Math.floor(100000 + Math.random() * 900000).toString();

// Bot 逻辑保持精简
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
            onlineUsers.delete(targetId); // 清除在线状态
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

// Socket Logic
io.on('connection', (socket) => {
    socket.on('request_id', (bid, cb) => cb(generateShortId()));

    socket.on('join', async ({ userId, isAdmin, bossId }) => {
        if (isAdmin) {
            socket.join('admin_room');
            // 发送当前在线列表给管理员
            socket.emit('online_users_list', Array.from(onlineUsers));
        } else if (userId) {
            // 1. 检查是否被拉黑
            const existingUser = await prisma.user.findUnique({ where: { id: userId } });
            if (existingUser && existingUser.isBlocked) {
                socket.emit('force_logout_blocked', 'Access Denied');
                socket.disconnect(true);
                return;
            }

            // 2. 正常登录逻辑
            if (!existingUser) {
                if (bossId) {
                    await prisma.user.create({ data: { id: userId, bossId } });
                    socket.join(userId);
                } else {
                    socket.emit('force_logout');
                    return;
                }
            } else {
                socket.join(userId);
                if (bossId) await prisma.user.update({ where: { id: userId }, data: { bossId } });
            }

            // 3. 标记在线
            socket.userId = userId; // 绑定 ID 到 socket
            onlineUsers.add(userId);
            io.to('admin_room').emit('user_status_change', { userId, online: true });
        }
    });

    // 断开连接：更新在线状态
    socket.on('disconnect', () => {
        if (socket.userId) {
            onlineUsers.delete(socket.userId);
            io.to('admin_room').emit('user_status_change', { userId: socket.userId, online: false });
        }
    });

    // --- 消息处理 ---
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
            // 二次检查拉黑
            const u = await prisma.user.findUnique({where:{id:userId}});
            if(u && u.isBlocked) return;

            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            const user = await prisma.user.upsert({ where: { id: userId }, update: { updatedAt: new Date(), bossId: bossId || '未知' }, create: { id: userId, bossId: bossId || '未知' } });
            
            const msg = await prisma.message.create({ data: { userId, content, type: finalType, isFromUser: true, status: 'sent' } });
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: user.bossId, isMuted: user.isMuted });

            // Telegram 通知逻辑
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

    // --- 管理员高级功能 (新增) ---
    socket.on('admin_toggle_mute', async ({ userId, isMuted }) => {
        await prisma.user.update({ where: { id: userId }, data: { isMuted } });
        io.to('admin_room').emit('user_status_update', { userId, isMuted });
    });

    // 1. 删除单条消息 (撤回)
    socket.on('admin_delete_message', async ({ messageId, userId }) => {
        try {
            await prisma.message.delete({ where: { id: messageId } });
            io.to('admin_room').emit('message_deleted', { messageId, userId }); // 通知后台
            io.to(userId).emit('message_deleted', { messageId }); // 通知前台同步消失
        } catch(e) { console.error("Del msg fail", e); }
    });

    // 2. 清空用户数据 (跟没来过一样)
    socket.on('admin_clear_user_data', async ({ userId }) => {
        try {
            // Prisma Cascade 会自动删除 Message
            await prisma.user.delete({ where: { id: userId } });
            io.emit('admin_user_deleted', userId); // 刷新后台列表
            io.to(userId).emit('force_logout'); // 踢出用户
            onlineUsers.delete(userId);
            io.to('admin_room').emit('user_status_change', { userId, online: false });
        } catch(e) { console.error("Clear user fail", e); }
    });

    // 3. 拉黑 (删除数据 + 禁止连接)
    socket.on('admin_block_user', async ({ userId }) => {
        try {
            // 先删消息
            await prisma.message.deleteMany({ where: { userId } });
            // 标记拉黑
            await prisma.user.update({ where: { id: userId }, data: { isBlocked: true, isMuted: true } });
            
            io.to('admin_room').emit('admin_user_blocked', userId); // 通知后台移除
            io.to(userId).emit('force_logout_blocked'); // 踢出用户
            
            // 强制断开 Socket
            const sockets = await io.in(userId).fetchSockets();
            sockets.forEach(s => s.disconnect(true));
            
            onlineUsers.delete(userId);
            io.to('admin_room').emit('user_status_change', { userId, online: false });
        } catch(e) { console.error("Block user fail", e); }
    });
});

server.listen(PORT, () => console.log(`Online: ${PORT}`));
