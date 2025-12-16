require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { PrismaClient } = require('@prisma/client');
const { Telegraf, Markup } = require('telegraf');
const cors = require('cors');
const webpush = require('web-push');

// 初始化应用
const app = express();
const prisma = new PrismaClient();

// 基础中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors({ origin: "*" })); 

const server = http.createServer(app);

// Socket.IO 配置
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e8,
    transports: ['websocket', 'polling'], 
    pingTimeout: 20000,
    pingInterval: 10000
});

// === 环境变量配置 (Render) ===
const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;

// 1. 管理群 ID (必须在 Render 设置 ALLOWED_GROUP_ID)
const ALLOWED_GROUP_ID = process.env.ALLOWED_GROUP_ID; 

// 2. 机器人白名单 (必须在 Render 设置 ALLOWED_BOT_USERS, 用逗号分隔)
const ALLOWED_BOT_USERS = (process.env.ALLOWED_BOT_USERS || '')
    .split(',')
    .map(id => Number(id.trim()))
    .filter(id => !isNaN(id));

// 内存状态
const onlineUsers = new Set();
const socketAutoReplyHistory = new Set(); 

// Web Push 配置
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    try {
        webpush.setVapidDetails(
            process.env.VAPID_EMAIL || 'mailto:admin@huiying.com',
            process.env.VAPID_PUBLIC_KEY,
            process.env.VAPID_PRIVATE_KEY
        );
    } catch (error) {
        console.error("Web Push Config Error:", error.message);
    }
}

// === 业务工具函数 ===

const generateShortId = () => Math.floor(100000 + Math.random() * 900000).toString();

// 强制断开用户
const forceDisconnectUser = async (targetId) => {
    try {
        const sockets = await io.in(targetId).fetchSockets();
        if (sockets.length > 0) {
            sockets.forEach(s => {
                s.emit('force_disconnect'); 
                s.disconnect(true);            
            });
        }
        onlineUsers.delete(targetId);
        io.to('admin_room').emit('user_status_change', { userId: targetId, online: false });
    } catch (e) {
        console.error(`Disconnect error ${targetId}:`, e);
    }
};

// 柬埔寨时间判断 (UTC+7)
const isCambodiaWorkingTime = () => {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const cambodiaHours = (utcHours + 7) % 24;
    return cambodiaHours >= 13 && cambodiaHours < 23;
};

const WELCOME_MESSAGE = `👋 您好！\n这里是汇盈国际业务员。\n\n👨‍💻 业务员正在与您连接...你可以正常发送消息\n我们将教您如何正确使用 Telegram 与老板直接沟通。\n\n⏰ 业务员上班时间 (柬埔寨时间):\n下午 13:00 - 晚上 23:00`;
const REST_MESSAGE = `💤 当前是休息时间 (柬埔寨 13:00-23:00 以外)。\n有事请留言，业务员上班后会第一时间回复你！\n\n⚠️ 为避免收不到回复通知，建议您点击页面下方的“APP”或“开启通知”按钮安装应用。`;

// === Telegram Bot 核心逻辑 ===
let bot = null;
if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    
    // 中间件：处理所有消息 (监控 + 鉴权)
    bot.use(async (ctx, next) => {
        // --- 1. 强制监控通知 (Priority 1) ---
        // 只要不是机器人在管理群里发的消息，统统记录并通知
        try {
            const currentChatId = String(ctx.chat?.id);
            // 确保 ALLOWED_GROUP_ID 已设置，且当前消息不是来自管理群本身 (防止死循环)
            if (ALLOWED_GROUP_ID && currentChatId !== ALLOWED_GROUP_ID && ctx.from) {
                const { id, username, first_name, last_name } = ctx.from;
                const fullName = `${first_name || ''} ${last_name || ''}`.trim();
                const userMsg = ctx.message?.text || (ctx.message?.photo ? '[图片]' : '[非文本消息]');
                
                // 获取当前时间 (柬埔寨时间)
                const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Phnom_Penh' });

                const alertMsg = `🚨 **新访问监控报警**\n` +
                                 `⏰ 时间: \`${time}\`\n` +
                                 `👤 姓名: ${fullName}\n` +
                                 `📛 用户名: @${username || '无'}\n` +
                                 `🆔 ID: \`${id}\`\n` +
                                 `💬 发送内容: ${userMsg}`;

                // 立即发送到管理群
                await ctx.telegram.sendMessage(ALLOWED_GROUP_ID, alertMsg, { parse_mode: 'Markdown' });
            }
        } catch (e) {
            console.error("Monitor Error:", e.message); // 仅记录报错，不中断流程
        }

        // --- 2. 权限拦截 (Priority 2) ---
        
        // 如果是在群组里使用，必须是指定的管理群
        if (ctx.chat && ctx.chat.type !== 'private' && String(ctx.chat.id) !== ALLOWED_GROUP_ID) {
            try { await ctx.leaveChat(); } catch(e) {}
            return; // 退出，不响应
        }

        // 如果是私聊，检查白名单
        if (ctx.chat && ctx.chat.type === 'private') {
            // 如果 ALLOWED_BOT_USERS 设置了，且用户不在列表中 -> 拒绝服务
            if (ALLOWED_BOT_USERS.length > 0 && !ALLOWED_BOT_USERS.includes(ctx.from.id)) {
                return; // 默默忽略，不响应指令
            }
        }

        // 验证通过，继续执行后续指令 (/bz, /ck 等)
        return next();
    });

    bot.start((ctx) => ctx.reply(`✅ System Online`));

    // [指令] /bz - 帮助菜单
    bot.command('bz', (ctx) => {
        ctx.reply(`🛠 **管理员指令全集**
/bz - 显示此帮助
/ck - 查看用户列表 & 数据统计
/sjkqk - ⚠️ **暴力清空数据库** (慎用)
/zc 密码 - 修改后台登录密码
/del ID - 强制删除指定用户
        `, { parse_mode: 'Markdown' });
    });

    // [指令] /ck - 查看统计
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

            let text = `📊 **系统状态统计**\n👥 总用户数: ${userCount}\n📡 推送订阅: ${subCount}\n💬 总消息数: ${msgCount}\n\n📝 **最近活跃 (Top 10):**\n`;
            const buttons = [];

            users.forEach(u => {
                const boss = u.bossId || '无';
                text += `🆔 \`${u.id}\` | 👤 ${boss} | 💬 ${u._count.messages}\n`;
                buttons.push([Markup.button.callback(`🗑 删除 ${u.id}`, `del_${u.id}`)]);
            });
            buttons.push([Markup.button.callback('❌ 关闭列表', 'cancel')]);

            await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
        } catch (e) {
            ctx.reply("❌ 数据库查询失败");
        }
    });

    // [指令] /zc - 修改密码
    bot.command('zc', async (ctx) => {
        const password = ctx.message.text.split(/\s+/)[1];
        if(!password) return ctx.reply("❌ 用法: /zc 新密码");
        try {
            await prisma.globalConfig.upsert({
                where: { key: 'admin_password' },
                update: { value: password },
                create: { key: 'admin_password', value: password }
            });
            io.emit('force_admin_relogin');
            ctx.reply(`✅ 管理员密码已更新为: \`${password}\``, { parse_mode: 'Markdown' });
        } catch(e) {
            ctx.reply("❌ 修改失败");
        }
    });

    // [指令] /sjkqk - 核弹清空
    bot.command('sjkqk', (ctx) => {
        ctx.reply('⚠️ **核弹警告：全库清空** ⚠️\n\n将删除：\n1. 所有聊天记录\n2. 所有用户账号\n3. 所有订阅\n\n确定执行？', 
            Markup.inlineKeyboard([
                [Markup.button.callback('❌ 取消', 'cancel')],
                [Markup.button.callback('💥 确认全部删除', 'confirm_clear_all')]
            ])
        );
    });

    bot.action('confirm_clear_all', async (ctx) => {
        try {
            await prisma.pushSubscription.deleteMany({});
            await prisma.message.deleteMany({});
            await prisma.user.deleteMany({});
            
            io.emit('admin_db_cleared');
            io.emit('force_logout_all');
            
            const sockets = await io.fetchSockets();
            sockets.forEach(s => s.disconnect(true));

            onlineUsers.clear();
            await ctx.editMessageText("💥 **数据库已彻底格式化**");
        } catch (e) {
            await ctx.editMessageText(`❌ Error: ${e.message}`);
        }
    });

    // 按钮动作：删除用户
    bot.action(/del_(.+)/, async (ctx) => {
        const targetId = ctx.match[1];
        try {
            await prisma.message.deleteMany({ where: { userId: targetId } });
            await prisma.user.delete({ where: { id: targetId } });
            await forceDisconnectUser(targetId);
            io.emit('admin_user_deleted', targetId);
            await ctx.answerCbQuery(`已删除 ${targetId}`);
            await ctx.reply(`🗑 用户 \`${targetId}\` 数据已销毁。`, { parse_mode: 'Markdown' });
        } catch (e) {
            await ctx.answerCbQuery("失败");
        }
    });

    bot.action('cancel', async (ctx) => { await ctx.deleteMessage(); });
    bot.launch().catch(e => console.error("Bot Error:", e));
}

// === Express API 接口 ===

app.post('/api/user/check', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.json({ exists: false });
        const user = await prisma.user.findUnique({ where: { id: userId } });
        res.json({ exists: !!user });
    } catch (e) { res.status(500).json({ exists: false }); }
});

app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    try {
        const config = await prisma.globalConfig.findUnique({ where: { key: 'admin_password' } });
        const validPassword = (config && config.value) || process.env.ADMIN_PASSWORD;
        res.json({ success: password === validPassword });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/vapid-key', (req, res) => res.json({ publicKey: process.env.VAPID_PUBLIC_KEY }));

app.post('/api/subscribe', async (req, res) => {
    const { userId, subscription } = req.body;
    if (!userId || !subscription?.endpoint) return res.status(400).json({});
    try {
        await prisma.pushSubscription.upsert({
            where: { endpoint: subscription.endpoint },
            update: { userId, keys: subscription.keys },
            create: { userId, endpoint: subscription.endpoint, keys: subscription.keys }
        });
        res.status(201).json({ success: true });
    } catch (e) { res.status(500).json({}); }
});

app.get('/api/history/:userId', async (req, res) => {
    try {
        const msgs = await prisma.message.findMany({ where: { userId: req.params.userId }, orderBy: { createdAt: 'asc' } });
        res.json(msgs);
    } catch(e) { res.json([]); }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { updatedAt: 'desc' },
            include: { 
                messages: { take: 1, orderBy: { createdAt: 'desc' } }, 
                _count: { select: { messages: { where: { isFromUser: true, status: 'sent' } } } } 
            }
        });
        const formattedUsers = users.map(u => ({
            id: u.id,
            bossId: u.bossId,
            updatedAt: u.updatedAt,
            lastMessage: u.messages[0] ? u.messages[0].content : '',
            lastMessageType: u.messages[0] ? u.messages[0].type : 'text',
            unreadCount: u._count.messages,
            isBlocked: u.isBlocked,
            isMuted: u.isMuted
        }));
        res.json(formattedUsers);
    } catch (e) { res.status(500).json([]); }
});

app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));

// === Socket.IO 核心逻辑 ===

io.on('connection', (socket) => {
    const { userId, bossId } = socket.handshake.query;

    if (userId) {
        socket.join(userId);
        socket.userId = userId;
        onlineUsers.add(userId);
        io.to('admin_room').emit('user_status_change', { userId, online: true });
    }

    socket.on('request_id', (bid, cb) => {
        if (typeof bid === 'function') { cb = bid; bid = null; }
        if (typeof cb === 'function') cb(generateShortId());
    });

    socket.on('join', async ({ userId, isAdmin, bossId }) => {
        if (isAdmin) {
            socket.join('admin_room');
            socket.emit('online_users_list', Array.from(onlineUsers));
        } else if (userId) {
            try {
                const existingUser = await prisma.user.findUnique({ where: { id: userId } });
                if (existingUser && existingUser.isBlocked) {
                    socket.emit('force_logout_blocked');
                    socket.disconnect(true);
                    return;
                }

                if (!existingUser) {
                    if (bossId && bossId !== 'SystemRestore') {
                        await prisma.user.create({ data: { id: userId, bossId: bossId } });
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
                    if (bossId && bossId !== 'SystemRestore' && existingUser.bossId !== bossId) {
                        await prisma.user.update({ where: { id: userId }, data: { bossId } });
                    }
                }
                
                socket.userId = userId;
                onlineUsers.add(userId);
                io.to('admin_room').emit('user_status_change', { userId, online: true });
            } catch(e) { console.error("Join Error:", e); }
        }
    });

    socket.on('disconnect', async () => {
        if (socket.userId) {
            onlineUsers.delete(socket.userId);
            socketAutoReplyHistory.delete(socket.id);
            try {
                await prisma.user.update({
                    where: { id: socket.userId },
                    data: { updatedAt: new Date() }
                });
            } catch(e) {}
            io.to('admin_room').emit('user_status_change', { userId: socket.userId, online: false });
        }
    });

    socket.on('typing', ({ targetId, isTyping }) => {
        if (targetId === 'admin') {
            const uid = socket.userId;
            if(uid) io.to('admin_room').emit('user_typing', { userId: uid, isTyping });
        } else {
            io.to(targetId).emit('display_typing', { isTyping });
        }
    });

    socket.on('mark_read', async ({ userId, isAdmin }) => {
        try {
            if (isAdmin) {
                await prisma.message.updateMany({ where: { userId, isFromUser: true, status: { not: 'read' } }, data: { status: 'read' } });
                io.to(userId).emit('messages_read_update');
                io.to('admin_room').emit('admin_messages_read_sync', { userId });
            } else {
                await prisma.message.updateMany({ where: { userId, isFromUser: false, status: { not: 'read' } }, data: { status: 'read' } });
                io.to('admin_room').emit('admin_messages_read', { userId });
            }
        } catch(e) {}
    });

    socket.on('send_message', async (data) => {
        const { userId, content, type, bossId, tempId } = data; 
        try {
            const user = await prisma.user.findUnique({ where: { id: userId } });
            if (!user || user.isBlocked) { 
                socket.emit('force_logout_blocked'); 
                socket.disconnect(true); 
                return; 
            }

            if (bossId && bossId !== '未知' && user.bossId !== bossId) {
                await prisma.user.update({ where: { id: userId }, data: { bossId } });
            }

            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            const msg = await prisma.message.create({ 
                data: { userId, content, type: finalType, isFromUser: true, status: 'sent' } 
            });
            
            socket.emit('receive_message', { ...msg, tempId });
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: user.bossId, isMuted: user.isMuted });

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

            // Telegram 消息转发
            if (bot && !user.isMuted) {
                const conf = await prisma.globalConfig.findUnique({ where: { key: 'notification_switch' } });
                if (!conf || conf.value === 'on') {
                    try {
                        let mention = (bossId && bossId!=='未知') ? `@${bossId.replace('@','')}` : '';
                        const txt = finalType === 'image' ? "📷 [图片]" : content.substring(0, 100);
                        if (ALLOWED_GROUP_ID) {
                            await bot.telegram.sendMessage(ALLOWED_GROUP_ID, `${mention} 🔔 **新消息**\nID: \`${userId}\`\n内容: ${txt}`, { 
                                parse_mode: 'Markdown',
                                ...Markup.inlineKeyboard([[Markup.button.callback(`🗑 删除此人`, `del_${userId}`)]])
                            });
                        }
                    } catch(e) {}
                }
            }
        } catch(e) {}
    });

    socket.on('admin_reply', async ({ targetUserId, content, type, tempId }) => {
        try {
            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            const userExists = await prisma.user.findUnique({ where: { id: targetUserId } });
            if (!userExists) await prisma.user.create({ data: { id: targetUserId, bossId: 'SystemRestore' } });

            const msg = await prisma.message.create({ 
                data: { userId: targetUserId, content, type: finalType, isFromUser: false, status: 'sent' } 
            });
            
            io.to(targetUserId).emit('receive_message', msg);
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: 'System', tempId });

            if (process.env.VAPID_PUBLIC_KEY) {
                const subs = await prisma.pushSubscription.findMany({ where: { userId: targetUserId } });
                const payload = JSON.stringify({
                    title: '新消息提醒',
                    body: finalType === 'image' ? '[发来一张图片]' : (content.length > 30 ? content.substring(0, 30) + '...' : content),
                    url: '/' 
                });
                subs.forEach(sub => {
                    webpush.sendNotification(sub.keys ? { endpoint: sub.endpoint, keys: sub.keys } : sub.endpoint, payload).catch(error => {
                        if (error.statusCode === 404 || error.statusCode === 410) prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(()=>{});
                    });
                });
            }
        } catch(e) {}
    });

    socket.on('admin_toggle_mute', async ({ userId, isMuted }) => {
        try {
            await prisma.user.update({ where: { id: userId }, data: { isMuted } });
            io.to('admin_room').emit('user_status_update', { userId, isMuted });
        } catch(e) {}
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
            await prisma.message.deleteMany({ where: { userId } });
            await prisma.user.delete({ where: { id: userId } });
            await forceDisconnectUser(userId);
            io.emit('admin_user_deleted', userId);
        } catch(e) {}
    });

    socket.on('admin_block_user', async ({ userId }) => {
        try {
            await prisma.message.deleteMany({ where: { userId } });
            await prisma.pushSubscription.deleteMany({ where: { userId } });
            await prisma.user.delete({ where: { id: userId } });
            await forceDisconnectUser(userId);
            io.emit('admin_user_blocked', userId); 
            io.emit('admin_user_deleted', userId); 
        } catch(e) {}
    });

    socket.on('admin_merge_user', async ({ oldId, newId }) => {
        try {
            const oldUser = await prisma.user.findUnique({ where: { id: oldId } });
            if (!oldUser) {
                socket.emit('merge_result', { success: false, msg: `❌ 找不到旧账号: ${oldId}` });
                return;
            }
            await prisma.message.updateMany({ where: { userId: oldId }, data: { userId: newId } });
            await prisma.pushSubscription.updateMany({ where: { userId: oldId }, data: { userId: newId } });
            await prisma.user.delete({ where: { id: oldId } });

            socket.emit('merge_result', { success: true, msg: `✅ 合并成功！${oldId} -> ${newId}` });
            
            io.to('admin_room').emit('admin_user_deleted', oldId);
            io.to(newId).emit('messages_read_update'); 
        } catch (e) {
            socket.emit('merge_result', { success: false, msg: `❌ 系统错误: ${e.message}` });
        }
    });
});

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
