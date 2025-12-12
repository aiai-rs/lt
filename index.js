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
const ALLOWED_GROUP_ID = '-1003091925643'; 

let bot = null;

const generateShortId = () => Math.floor(100000 + Math.random() * 900000).toString();

if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    console.log("🤖 Bot 启动中...");

    bot.on(['my_chat_member', 'new_chat_members', 'message'], async (ctx, next) => {
        const chatId = String(ctx.chat.id);
        const type = ctx.chat.type;
        if (type === 'private') return next();
        
        if (chatId !== ALLOWED_GROUP_ID) {
            try { await ctx.leaveChat(); } catch(e){}
            return;
        }
        return next();
    });

    bot.start(async (ctx) => {
        if (ctx.chat.type !== 'private' && String(ctx.chat.id) !== ALLOWED_GROUP_ID) return;
        ctx.reply(`✅ **系统正常**\n绑定群组: \`${ALLOWED_GROUP_ID}\``);
    });

    bot.hears(/^删除\s+(\d+)$/, (ctx) => {
        if (String(ctx.chat.id) !== ALLOWED_GROUP_ID && ctx.chat.type !== 'private') return;
        const targetId = ctx.match[1];
        ctx.reply(`⚠️ 确认删除用户 ${targetId}?`, Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', 'cancel'), Markup.button.callback('✅ 确认', `del_${targetId}`)]]));
    });

    bot.action(/del_(.+)/, async (ctx) => {
        const targetId = ctx.match[1];
        try {
            await prisma.user.delete({ where: { id: targetId } });
            io.emit('admin_user_deleted', targetId);
            io.to(targetId).emit('force_logout');
            await ctx.editMessageText(`🗑️ 用户 ${targetId} 已删除`);
        } catch (e) { await ctx.editMessageText("❌ 失败"); }
    });

    bot.action('cancel', async (ctx) => { await ctx.editMessageText("已取消"); });

    bot.command('sjkqk', (ctx) => {
        if (String(ctx.chat.id) !== ALLOWED_GROUP_ID && ctx.chat.type !== 'private') return;
        ctx.reply('⚠️ 确定清空所有数据？', Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', 'cancel'), Markup.button.callback('✅ 确认清空', 'clear_all')]]));
    });

    // 🔥 核心清库逻辑：删库 + 踢人
    bot.action('clear_all', async (ctx) => {
        try {
            await prisma.message.deleteMany({});
            await prisma.user.deleteMany({});
            
            // 通知后台刷新
            io.emit('admin_db_cleared');
            // 🔥 强制踢出所有前端用户
            io.emit('force_logout_all');
            
            await ctx.editMessageText("💥 数据库已清空，所有用户已强制下线。");
        } catch (e) { 
            console.error(e);
            await ctx.editMessageText("❌ 失败，请查看日志"); 
        }
    });

    bot.command('zc', async (ctx) => {
        const p = ctx.message.text.split(/\s+/)[1];
        if(!p) return ctx.reply("❌ 用法: /zc 密码");
        await prisma.globalConfig.upsert({ where: { key: 'admin_password' }, update: { value: p }, create: { key: 'admin_password', value: p } });
        io.emit('force_admin_relogin'); 
        ctx.reply("✅ 密码已更新，管理员需重新登录。");
    });

    bot.command('ck', async (ctx) => {
        const u = await prisma.user.count();
        ctx.reply(`📊 用户: ${u}`);
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

// Socket
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

    // 🔥 修复点：先建用户，再存消息
    socket.on('send_message', async ({ userId, content, type, bossId }) => {
        try {
            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            
            // 1. 🔥 必须先确保用户存在！否则外键报错！
            const user = await prisma.user.upsert({ 
                where: { id: userId }, 
                update: { updatedAt: new Date(), bossId: bossId || '未知' }, 
                create: { id: userId, bossId: bossId || '未知' } 
            });

            // 2. 🔥 用户存在了，现在存消息
            const msg = await prisma.message.create({ 
                data: { userId, content, type: finalType, isFromUser: true } 
            });

            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: user.bossId, isMuted: user.isMuted });

            if (bot && !user.isMuted) {
                const switchConfig = await prisma.globalConfig.findUnique({ where: { key: 'notification_switch' } });
                if (!switchConfig || switchConfig.value === 'on') {
                    try {
                        let mention = (bossId && bossId!=='未知') ? `@${bossId.replace('@','')}` : '';
                        const txt = finalType === 'image' ? "📷 [图片]" : content.substring(0, 100);
                        
                        await bot.telegram.sendMessage(ALLOWED_GROUP_ID, `${mention} 🔔 **新消息**\n----------------\n👤 ID: \`${userId}\`\n🏷️ 来源: ${bossId}\n💬 内容: ${txt}`, { 
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([[Markup.button.callback(`🗑️ 删除 ${userId}`, `del_${userId}`)]])
                        });
                    } catch(e) { console.error("TG发送失败", e.message); }
                }
            }
        } catch (e) {
            console.error("send_message error:", e);
        }
    });

    // 🔥 修复点：回复消息也防崩
    socket.on('admin_reply', async ({ targetUserId, content, type, tempId }) => {
        try {
            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            
            // 1. 确保用户还在 (防止删了之后又回复导致崩溃)
            const userExists = await prisma.user.findUnique({ where: { id: targetUserId } });
            if (!userExists) {
                // 如果用户不存在，可以创建一个占位符，或者直接不存消息
                // 这里选择重建用户以保证消息能发出去
                await prisma.user.create({ data: { id: targetUserId, bossId: 'SystemRestore' } });
            }

            // 2. 存消息
            const msg = await prisma.message.create({ 
                data: { userId: targetUserId, content, type: finalType, isFromUser: false } 
            });
            
            io.to(targetUserId).emit('receive_message', msg);
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: 'System', tempId });
        } catch (e) {
            console.error("admin_reply error:", e);
        }
    });
});

server.listen(PORT, () => console.log(`Online: ${PORT}`));
