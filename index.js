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

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_GROUP_ID = '-1003091925643'; 

let bot = null;
const generateShortId = () => Math.floor(100000 + Math.random() * 900000).toString();

if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    console.log("🤖 Bot 启动中...");

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
        ctx.reply(`✅ 系统正常 (群ID: ${ALLOWED_GROUP_ID})`);
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
            io.to(targetId).emit('force_logout'); // 🔥 立即踢人
            await ctx.editMessageText(`🗑️ 用户 ${targetId} 已删除`);
        } catch (e) { await ctx.editMessageText("❌ 删除失败"); }
    });

    bot.action('cancel', async (ctx) => { await ctx.editMessageText("已取消"); });

    bot.command('sjkqk', (ctx) => {
        if (String(ctx.chat.id) !== ALLOWED_GROUP_ID) return;
        ctx.reply('⚠️ 确定清空所有数据？', Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', 'cancel'), Markup.button.callback('✅ 确认', 'clear_all')]]));
    });

    bot.action('clear_all', async (ctx) => {
        try {
            await prisma.message.deleteMany({});
            await prisma.user.deleteMany({});
            io.emit('admin_db_cleared');
            io.emit('force_logout_all');
            await ctx.editMessageText("💥 数据库已清空");
        } catch (e) { await ctx.editMessageText("❌ 失败"); }
    });

    bot.command('zc', async (ctx) => {
        const p = ctx.message.text.split(/\s+/)[1];
        if(!p) return ctx.reply("用法: /zc 密码");
        await prisma.globalConfig.upsert({ where: { key: 'admin_password' }, update: { value: p }, create: { key: 'admin_password', value: p } });
        io.emit('force_admin_relogin');
        ctx.reply("✅ 密码已改，管理员需重登");
    });

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

app.post('/api/admin/notification', async (req, res) => {
    await prisma.globalConfig.upsert({ where: { key: 'notification_switch' }, update: { value: req.body.status }, create: { key: 'notification_switch', value: req.body.status } });
    res.json({ success: true });
});
app.get('/api/admin/notification', async (req, res) => {
    const c = await prisma.globalConfig.findUnique({ where: { key: 'notification_switch' } });
    res.json({ status: c ? c.value : 'on' });
});

app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));

// Socket
io.on('connection', (socket) => {
    socket.on('request_id', (bid, cb) => cb(generateShortId()));

    // 🔥 核心鉴权：加入房间时检查用户是否存在
    socket.on('join', async ({ userId, isAdmin, bossId }) => {
        if (isAdmin) {
            socket.join('admin_room');
        } else if (userId) {
            // 🔥 强校验：如果数据库里没有这个ID，说明被删了，强制踢出
            // 只有当 bossId 存在（初次登录）时才允许 upsert，否则纯 join 必须查库
            const userExists = await prisma.user.findUnique({ where: { id: userId } });
            
            if (!userExists) {
                // 如果是新用户注册流程(带着bossId来的)，允许创建
                if (bossId) {
                    await prisma.user.create({ data: { id: userId, bossId } });
                    socket.join(userId);
                } else {
                    // 如果只是凭缓存ID想进来，但数据库没记录 -> 踢！
                    socket.emit('force_logout');
                    return;
                }
            } else {
                socket.join(userId);
                if (bossId) await prisma.user.update({ where: { id: userId }, data: { bossId } });
            }
        }
    });

    // 正在输入
    socket.on('typing', ({ targetId, isTyping }) => {
        io.to(targetId).emit('display_typing', { isTyping });
    });

    // 标记已读
    socket.on('mark_read', async ({ userId }) => {
        // 更新数据库中该用户发的所有消息为 'read'
        await prisma.message.updateMany({
            where: { userId: userId, isFromUser: true, status: { not: 'read' } },
            data: { status: 'read' }
        });
        // 通知用户端变绿勾
        io.to(userId).emit('messages_read_update');
    });

    socket.on('admin_toggle_mute', async ({ userId, isMuted }) => {
        await prisma.user.update({ where: { id: userId }, data: { isMuted } });
        io.to('admin_room').emit('user_status_update', { userId, isMuted });
    });

    socket.on('send_message', async ({ userId, content, type, bossId }) => {
        try {
            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            // 确保用户存在
            const user = await prisma.user.upsert({ 
                where: { id: userId }, 
                update: { updatedAt: new Date(), bossId: bossId || '未知' }, 
                create: { id: userId, bossId: bossId || '未知' } 
            });
            // 状态默认为 sent
            const msg = await prisma.message.create({ 
                data: { userId, content, type: finalType, isFromUser: true, status: 'sent' } 
            });

            // 广播
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: user.bossId, isMuted: user.isMuted });
            
            // 收到后立刻变为 delivered (送达) 并回传给用户
            // (实际生产中这里可以不做数据库更新，直接socket回执，为了简单先这样)
            // io.to(userId).emit('message_status_update', { tempId, status: 'delivered' }); 

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
        } catch (e) { console.error(e); }
    });

    socket.on('admin_reply', async ({ targetUserId, content, type, tempId }) => {
        try {
            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            const userExists = await prisma.user.findUnique({ where: { id: targetUserId } });
            if (!userExists) await prisma.user.create({ data: { id: targetUserId, bossId: 'SystemRestore' } });

            const msg = await prisma.message.create({ 
                data: { userId: targetUserId, content, type: finalType, isFromUser: false, status: 'read' } // 管理员发的默认已读
            });
            
            io.to(targetUserId).emit('receive_message', msg);
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: 'System', tempId });
        } catch (e) { console.error(e); }
    });
});

server.listen(PORT, () => console.log(`Online: ${PORT}`));
