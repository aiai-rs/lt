require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { PrismaClient } = require('@prisma/client');
const { Telegraf, Markup } = require('telegraf');
const cors = require('cors');
const webpush = require('web-push');

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
const socketAutoReplyHistory = new Set();

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_GROUP_ID = '-1003091925643';

// --- Web Push 初始化 ---
// 直接读取 Render 环境变量
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.VAPID_EMAIL || 'mailto:admin@huiying.com',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
    console.log("✅ Web Push 服务启动成功 (Keys Loaded)");
} else {
    console.error("❌ 严重错误: 环境变量未配置 VAPID Keys，推送功能将失效！");
}

// 业务配置
const WELCOME_MESSAGE = `👋 您好！
这里是汇盈国际业务员。

👨‍💻 业务员正在与您连接...你可以正常发送消息
我们将教您如何正确使用 Telegram 与老板直接沟通。

⏰ 业务员上班时间 (柬埔寨时间):
下午 13:00 - 晚上 23:00`;

const REST_MESSAGE = `💤 当前是休息时间 (柬埔寨 13:00-23:00 以外)。
有事请留言，业务员上班后会第一时间回复你！`;

const isCambodiaWorkingTime = () => {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const cambodiaHours = (utcHours + 7) % 24;
    return cambodiaHours >= 13 && cambodiaHours < 23;
};

let bot = null;
const generateShortId = () => Math.floor(100000 + Math.random() * 900000).toString();

if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    console.log("🤖 Bot 启动...");

    bot.use(async (ctx, next) => {
        if (ctx.chat && (ctx.chat.type === 'private' || String(ctx.chat.id) !== ALLOWED_GROUP_ID)) {
             if(ctx.chat.type !== 'private') try { await ctx.leaveChat(); } catch(e){}
             return;
        }
        return next();
    });

    bot.start((ctx) => ctx.reply(`✅ 系统在线\n绑定群组: \`${ALLOWED_GROUP_ID}\`\n输入 /bz 查看指令`));

    bot.command('bz', (ctx) => {
        ctx.reply(`🛠️ **机器人指令帮助**
/bz - 显示此帮助信息
/ck - 查看当前用户列表 & 数据概览 (含删除按钮)
/sjkqk - ⚠️ 清空整个数据库 (慎用)
/zc  - 
/删除 ID - 删除指定用户
        `, { parse_mode: 'Markdown' });
    });

    // --- 数据核弹 (已包含清空订阅) ---
    bot.command('sjkqk', (ctx) => {
        ctx.reply('⚠️ 高危操作警告 ⚠️\n此操作将删除所有用户、聊天记录和**推送订阅**，且不可恢复！\n\n请确认：', 
            Markup.inlineKeyboard([
                [Markup.button.callback('❌ 取消', 'cancel')],
                [Markup.button.callback('💥 确认清空所有数据', 'confirm_clear_all')]
            ])
        );
    });

    bot.action('confirm_clear_all', async (ctx) => {
        try {
            await prisma.pushSubscription.deleteMany({}); // 清空订阅
            await prisma.message.deleteMany({});
            await prisma.user.deleteMany({});
            
            io.emit('admin_db_cleared');
            io.emit('force_logout_all');
            onlineUsers.clear();
            await ctx.editMessageText("💥 数据库已完全重置\n所有数据（含订阅）已清除，系统如新。");
        } catch (e) {
            await ctx.editMessageText(`❌ 清空失败: ${e.message}`);
        }
    });

    bot.command('ck', async (ctx) => {
        try {
            const userCount = await prisma.user.count();
            const msgCount = await prisma.message.count();
            const subCount = await prisma.pushSubscription.count();
            const users = await prisma.user.findMany({
                take: 10,
                orderBy: { updatedAt: 'desc' },
                include: { _count: { select: { messages: true } } }
            });

            let text = `📊 数据概览\n👥 总用户: ${userCount}\n📡 推送订阅: ${subCount}\n💬 总消息: ${msgCount}\n\n📝 最近活跃用户 (Top 10):\n`;
            const buttons = [];

            users.forEach(u => {
                const boss = u.bossId || '无';
                text += `🆔 \`${u.id}\` | 👤 ${boss} | 💬 ${u._count.messages}\n`;
                buttons.push([Markup.button.callback(`🗑️ 删除 ${u.id}`, `del_${u.id}`)]);
            });

            buttons.push([Markup.button.callback('❌ 关闭', 'cancel')]);

            await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
        } catch (e) {
            ctx.reply("❌ 查询失败");
        }
    });

    bot.command('zc', async (ctx) => {
        const p = ctx.message.text.split(/\s+/)[1];
        if(!p) return ctx.reply("❌ 用法: ");
        await prisma.globalConfig.upsert({ where: { key: 'admin_password' }, update: { value: p }, create: { key: 'admin_password', value: p } });
        io.emit('force_admin_relogin');
        ctx.reply("✅ ");
    });

    bot.action(/del_(.+)/, async (ctx) => {
        const targetId = ctx.match[1];
        try {
            await prisma.user.delete({ where: { id: targetId } });
            io.emit('admin_user_deleted', targetId);
            io.to(targetId).emit('force_logout');
            onlineUsers.delete(targetId);
            io.to('admin_room').emit('user_status_change', { userId: targetId, online: false });
            await ctx.answerCbQuery(`用户 ${targetId} 已删除`);
            await ctx.reply(`🗑️ 用户 \`${targetId}\` 数据已抹除`, { parse_mode: 'Markdown' });
        } catch (e) { await ctx.answerCbQuery("删除失败"); }
    });

    bot.action('cancel', async (ctx) => { await ctx.deleteMessage(); });
    bot.launch().catch(e => console.error(e));
}

// --- API ---

app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    const c = await prisma.globalConfig.findUnique({ where: { key: 'admin_password' } });
    const valid = (c && c.value) || process.env.ADMIN_PASSWORD || "123456";
    res.json({ success: password === valid });
});

// 给前端提供公钥 (从环境变量读取)
app.get('/api/vapid-key', (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// 保存订阅
app.post('/api/subscribe', async (req, res) => {
    const { userId, subscription } = req.body;
    if (!userId || !subscription || !subscription.endpoint) return res.status(400).json({});
    
    try {
        await prisma.pushSubscription.upsert({
            where: { endpoint: subscription.endpoint },
            update: { userId, keys: subscription.keys },
            create: { userId, endpoint: subscription.endpoint, keys: subscription.keys }
        });
        res.status(201).json({ success: true });
    } catch (e) {
        console.error('Sub Error:', e);
        res.status(500).json({});
    }
});

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
        const formatted = users.map(u => ({
            ...u,
            unreadCount: u._count.messages
        }));
        res.json(formatted);
    } catch (e) { res.json([]); }
});

app.get('/api/history/:userId', async (req, res) => {
    try {
        const msgs = await prisma.message.findMany({ where: { userId: req.params.userId }, orderBy: { createdAt: 'asc' } });
        res.json(msgs);
    } catch(e) { res.json([]); }
});

app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));

// --- Socket ---
io.on('connection', (socket) => {
    socket.on('request_id', (bid, cb) => cb(generateShortId()));

    socket.on('join', async ({ userId, isAdmin, bossId }) => {
        if (isAdmin) {
            socket.join('admin_room');
            socket.emit('online_users_list', Array.from(onlineUsers));
        } else if (userId) {
            const existingUser = await prisma.user.findUnique({ where: { id: userId } });
            if (existingUser && existingUser.isBlocked) {
                socket.emit('force_logout_blocked');
                socket.disconnect(true);
                return;
            }
            if (!existingUser) {
                if (bossId) {
                    await prisma.user.create({ data: { id: userId, bossId } });
                    socket.join(userId);
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
                const count = await prisma.message.count({ where: { userId } });
                if(count === 0) {
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
            socketAutoReplyHistory.delete(socket.id);
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
            io.to('admin_room').emit('admin_messages_read_sync', { userId });
        } else {
            await prisma.message.updateMany({ where: { userId, isFromUser: false, status: { not: 'read' } }, data: { status: 'read' } });
            io.to('admin_room').emit('admin_messages_read', { userId });
        }
    });

    socket.on('send_message', async ({ userId, content, type, bossId }) => {
        try {
            const u = await prisma.user.findUnique({where:{id:userId}});
            if(u && u.isBlocked) { socket.emit('force_logout_blocked'); socket.disconnect(true); return; }

            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            const user = await prisma.user.upsert({ where: { id: userId }, update: { updatedAt: new Date(), bossId: bossId || '未知' }, create: { id: userId, bossId: bossId || '未知' } });
            
            const msg = await prisma.message.create({ data: { userId, content, type: finalType, isFromUser: true, status: 'sent' } });
            
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: user.bossId, isMuted: user.isMuted });

            if (!isCambodiaWorkingTime()) {
                if (!socketAutoReplyHistory.has(socket.id)) {
                    const autoReply = await prisma.message.create({ data: { userId, content: REST_MESSAGE, type: 'text', isFromUser: false, status: 'sent' } });
                    setTimeout(() => {
                        socket.emit('receive_message', autoReply);
                        io.to('admin_room').emit('admin_receive_message', { ...autoReply, bossId: 'System_Auto', isMuted: user.isMuted });
                    }, 1000);
                    socketAutoReplyHistory.add(socket.id);
                }
            }

            if (bot && !user.isMuted) {
                const conf = await prisma.globalConfig.findUnique({ where: { key: 'notification_switch' } });
                if (!conf || conf.value === 'on') {
                    try {
                        let mention = (bossId && bossId!=='未知') ? `@${bossId.replace('@','')}` : '';
                        const txt = finalType === 'image' ? "📷 [图片]" : content.substring(0, 100);
                        await bot.telegram.sendMessage(ALLOWED_GROUP_ID, `${mention} 🔔 消息\nID: \`${userId}\`\n内容: ${txt}`, { 
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

            // >>>>> Web Push 核心发送逻辑 >>>>>
            if (process.env.VAPID_PUBLIC_KEY) {
                const subs = await prisma.pushSubscription.findMany({ where: { userId: targetUserId } });
                const payload = JSON.stringify({
                    title: '新消息提醒',
                    body: finalType === 'image' ? '[发来一张图片]' : (content.length > 30 ? content.substring(0, 30) + '...' : content),
                    url: '/' 
                });

                subs.forEach(sub => {
                    webpush.sendNotification(sub.keys ? { endpoint: sub.endpoint, keys: sub.keys } : sub.endpoint, payload)
                    .catch(error => {
                        if (error.statusCode === 404 || error.statusCode === 410) {
                            prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(()=>{});
                        }
                    });
                });
            }
            // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<

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
            await prisma.pushSubscription.deleteMany({ where: { userId } }); // 清空该用户订阅
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
            await prisma.pushSubscription.deleteMany({ where: { userId } }); // 拉黑也清空订阅
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
