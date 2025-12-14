require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { PrismaClient } = require('@prisma/client');
const { Telegraf, Markup } = require('telegraf');
const cors = require('cors');
const webpush = require('web-push');

// ==========================================
// 1. 系统初始化与配置
// ==========================================
const app = express();
const prisma = new PrismaClient();

// 增加 Payload 限制，防止上传大图报错 (50MB)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 允许所有跨域请求
app.use(cors({ origin: "*" })); 

const server = http.createServer(app);

// Socket.IO 初始化配置
const io = new Server(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8, // 100MB 限制
    pingTimeout: 60000,     // 心跳超时 60秒
    pingInterval: 25000     // 心跳间隔 25秒
});

// 环境变量配置读取
const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_GROUP_ID = '-1003091925643'; // 你的TG管理群组ID

// 内存数据存储 (用于在线状态维护和防刷屏)
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
        console.log("✅ Web Push 推送服务已启动");
    } catch (error) {
        console.error("❌ Web Push 配置错误:", error.message);
    }
}

// ==========================================
// 2. 辅助工具函数 & 业务逻辑
// ==========================================

// 生成 6 位随机短 ID
const generateShortId = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// 强制断开指定用户的所有连接 (核心功能)
const forceDisconnectUser = async (targetId) => {
    try {
        // 获取该用户房间内的所有 socket 连接
        const sockets = await io.in(targetId).fetchSockets();
        if (sockets.length > 0) {
            console.log(`🔌 正在强制断开用户 ${targetId} 的 ${sockets.length} 个连接...`);
            sockets.forEach(s => {
                s.emit('force_disconnect'); // 通知前端显示“会话结束”
                s.disconnect(true);         // 物理断开
            });
        }
        onlineUsers.delete(targetId);
        // 通知后台该用户下线
        io.to('admin_room').emit('user_status_change', { userId: targetId, online: false });
    } catch (e) {
        console.error(`断开用户 ${targetId} 失败:`, e);
    }
};

// 柬埔寨时间判断 (UTC+7)
const isCambodiaWorkingTime = () => {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const cambodiaHours = (utcHours + 7) % 24;
    return cambodiaHours >= 13 && cambodiaHours < 23;
};

const WELCOME_MESSAGE = `👋 您好！
这里是汇盈国际业务员。

👨‍💻 业务员正在与您连接...你可以正常发送消息
我们将教您如何正确使用 Telegram 与老板直接沟通。

⏰ 业务员上班时间 (柬埔寨时间):
下午 13:00 - 晚上 23:00`;

const REST_MESSAGE = `💤 当前是休息时间 (柬埔寨 13:00-23:00 以外)。
有事请留言，业务员上班后会第一时间回复你！`;

// ==========================================
// 3. Telegram Bot 完整逻辑 (管理端)
// ==========================================
let bot = null;

if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    console.log("🤖 Telegram Bot 正在启动...");

    bot.use(async (ctx, next) => {
        if (ctx.chat && ctx.chat.type !== 'private') {
            if (String(ctx.chat.id) !== ALLOWED_GROUP_ID) {
                try { await ctx.leaveChat(); } catch(e) {}
                return;
            }
        }
        return next();
    });

    bot.start((ctx) => {
        ctx.reply(`✅ 汇盈客服系统在线\n绑定群组: \`${ALLOWED_GROUP_ID}\`\n输入 /bz 查看所有指令`);
    });

    bot.command('bz', (ctx) => {
        ctx.reply(`🛠️ **管理员指令全集**
/bz - 显示此帮助
/ck - 查看用户列表 & 数据统计
/sjkqk - ⚠️ **暴力清空数据库** (慎用)
/zc 密码 - 修改后台登录密码
/del ID - 强制删除指定用户
        `, { parse_mode: 'Markdown' });
    });

    // 暴力清空数据库
    bot.command('sjkqk', (ctx) => {
        ctx.reply('⚠️ **高危警告：核弹级操作** ⚠️\n\n此操作将执行以下删除：\n1. ❌ 所有聊天记录\n2. ❌ 所有用户账号 (ID将失效)\n3. ❌ 所有推送订阅\n\n**所有用户将立即掉线且无法找回记录！**\n确定执行吗？', 
            Markup.inlineKeyboard([
                [Markup.button.callback('❌ 取消', 'cancel')],
                [Markup.button.callback('💥 确认全部清空', 'confirm_clear_all')]
            ])
        );
    });

    bot.action('confirm_clear_all', async (ctx) => {
        try {
            console.log("🚨 正在执行全库清空操作...");
            await prisma.pushSubscription.deleteMany({});
            await prisma.message.deleteMany({});
            await prisma.user.deleteMany({});
            
            // 通知所有前端踢下线
            io.emit('admin_db_cleared');
            io.emit('force_logout_all');
            
            // 物理断开所有连接
            const sockets = await io.fetchSockets();
            sockets.forEach(s => s.disconnect(true));

            onlineUsers.clear();
            await ctx.editMessageText("💥 **数据库已成功重置**\n所有数据已永久抹除，系统已初始化。");
        } catch (e) {
            console.error("清空失败:", e);
            await ctx.editMessageText(`❌ 清空失败: ${e.message}`);
        }
    });

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
            ctx.reply("❌ 密码修改失败，数据库错误");
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
            ctx.reply("❌ 查询数据库失败");
        }
    });

    // TG 删除用户 (联动断线)
    bot.action(/del_(.+)/, async (ctx) => {
        const targetId = ctx.match[1];
        try {
            await prisma.message.deleteMany({ where: { userId: targetId } });
            await prisma.user.delete({ where: { id: targetId } });
            
            // 🚨 核心：立即断开连接
            await forceDisconnectUser(targetId);
            
            io.emit('admin_user_deleted', targetId);
            await ctx.answerCbQuery(`用户 ${targetId} 已删除`);
            await ctx.reply(`🗑️ 用户 \`${targetId}\` 及其所有记录已移除，连接已强制中断。`, { parse_mode: 'Markdown' });
        } catch (e) {
            await ctx.answerCbQuery("删除失败或用户不存在");
        }
    });

    bot.action('cancel', async (ctx) => { await ctx.deleteMessage(); });
    bot.launch().then(() => console.log("✅ Bot 已连接 Telegram API")).catch(e => console.error("❌ Bot 启动失败:", e));
}

// ==========================================
// 4. Express API 路由接口
// ==========================================

// 📌 [新增] 检查用户是否存在 (配合前端找回功能)
app.post('/api/check-user', async (req, res) => {
    const { userId } = req.body;
    try {
        if (!userId) return res.json({ exists: false });
        const user = await prisma.user.findUnique({ where: { id: userId } });
        // 用户存在且未被拉黑
        if (user && !user.isBlocked) {
            res.json({ exists: true });
        } else {
            res.json({ exists: false });
        }
    } catch (e) {
        res.status(500).json({ error: "Check failed" });
    }
});

// 📌 找回账号验证 (兼容旧版接口)
app.post('/api/user/check', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.json({ exists: false });
        const user = await prisma.user.findUnique({ where: { id: userId } });
        res.json({ exists: !!user });
    } catch (e) {
        res.status(500).json({ exists: false });
    }
});

// 📌 管理员登录
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    try {
        const config = await prisma.globalConfig.findUnique({ where: { key: 'admin_password' } });
        const validPassword = (config && config.value) || process.env.ADMIN_PASSWORD;
        if (validPassword && password === validPassword) {
            res.json({ success: true });
        } else {
            res.json({ success: false });
        }
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/vapid-key', (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', async (req, res) => {
    const { userId, subscription } = req.body;
    if (!userId || !subscription || !subscription.endpoint) return res.status(400).json({ error: '无效数据' });
    try {
        await prisma.pushSubscription.upsert({
            where: { endpoint: subscription.endpoint },
            update: { userId, keys: subscription.keys },
            create: { userId, endpoint: subscription.endpoint, keys: subscription.keys }
        });
        res.status(201).json({ success: true });
    } catch (e) {
        res.status(500).json({});
    }
});

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
            isMuted: u.isMuted,
            isOnline: onlineUsers.has(u.id)
        }));
        
        res.json(formattedUsers);
    } catch (e) { 
        res.status(500).json([]); 
    }
});

app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/admin.html');
});

// ==========================================
// 5. Socket.io 核心业务逻辑
// ==========================================
io.on('connection', (socket) => {
    
    // 📌 [新增] 直接从 URL 参数获取用户 ID (配合新前端)
    const { userId, bossId } = socket.handshake.query;

    console.log(`🔌 连接接入: ${socket.id}, UserID: ${userId || '无'}`);

    // 如果携带了 ID，直接加入房间并标记在线
    if (userId) {
        socket.join(userId);
        socket.userId = userId;
        onlineUsers.add(userId);
        io.to('admin_room').emit('user_status_change', { userId, online: true });
    }

    // [事件] 请求生成新 ID (注册流程)
    socket.on('request_id', (cb) => {
        const newId = generateShortId();
        console.log(`🆕 分配新ID: ${newId}`);
        cb(newId);
    });

    // [事件] 加入房间 (保留旧版逻辑兼容)
    socket.on('join', async ({ userId, isAdmin, bossId }) => {
        if (isAdmin) {
            socket.join('admin_room');
            socket.emit('online_users_list', Array.from(onlineUsers));
        } else if (userId) {
            const existingUser = await prisma.user.findUnique({ where: { id: userId } });
            
            // 如果被拉黑，踢出
            if (existingUser && existingUser.isBlocked) {
                socket.emit('force_logout_blocked');
                socket.disconnect(true);
                return;
            }

            if (!existingUser) {
                // 只有 SystemRestore 或带 BossID 的才允许注册，防止乱入
                if (bossId && bossId !== 'SystemRestore') {
                    await prisma.user.create({ data: { id: userId, bossId: bossId } });
                    const welcomeMsg = await prisma.message.create({
                        data: { userId, content: WELCOME_MESSAGE, type: 'text', isFromUser: false, status: 'sent' }
                    });
                    socket.emit('receive_message', welcomeMsg);
                } else {
                    // 没有正确信息的，拒绝连接
                    socket.emit('force_disconnect'); 
                    socket.disconnect(true);
                    return;
                }
            } else {
                 if (bossId && bossId !== 'SystemRestore') {
                    await prisma.user.update({ where: { id: userId }, data: { bossId } });
                }
            }
            
            socket.join(userId);
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

    // [事件] 发送消息
    socket.on('send_message', async (data) => {
        const { userId, content, type, bossId, tempId } = data; // tempId 是前端乐观更新用的
        try {
            // 🚨 核心安全检查：发送前先查用户是否存在
            const user = await prisma.user.findUnique({ where: { id: userId } });
            
            // 如果用户不存在（被删了），或者被拉黑了
            if (!user || user.isBlocked) {
                socket.emit('force_disconnect'); // 告诉前端重置
                socket.disconnect(true); // 物理切断
                return; // 结束执行
            }

            // 更新用户信息（如 BossID）
            if (bossId && bossId !== '未知' && user.bossId !== bossId) {
                await prisma.user.update({ where: { id: userId }, data: { bossId } });
            }

            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            
            // 存入数据库
            const msg = await prisma.message.create({ 
                data: { userId, content, type: finalType, isFromUser: true, status: 'sent' } 
            });
            
            // 回传给前端（带 tempId 方便前端确认消息发送成功）
            socket.emit('receive_message', { ...msg, tempId });
            
            // 推送给管理员
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: user.bossId, isMuted: user.isMuted });

            // 自动回复 (非工作时间)
            if (!isCambodiaWorkingTime() && !socketAutoReplyHistory.has(socket.id)) {
                const autoReply = await prisma.message.create({ 
                    data: { userId, content: REST_MESSAGE, type: 'text', isFromUser: false, status: 'sent' } 
                });
                setTimeout(() => {
                    socket.emit('receive_message', autoReply);
                    io.to('admin_room').emit('admin_receive_message', { ...autoReply, bossId: 'System_Auto', isMuted: user.isMuted });
                }, 1000);
                socketAutoReplyHistory.add(socket.id);
            }

            // TG 通知
            if (bot && !user.isMuted) {
                const conf = await prisma.globalConfig.findUnique({ where: { key: 'notification_switch' } });
                if (!conf || conf.value === 'on') {
                    try {
                        let mention = (bossId && bossId!=='未知') ? `@${bossId.replace('@','')}` : '';
                        const txt = finalType === 'image' ? "📷 [图片]" : content.substring(0, 100);
                        await bot.telegram.sendMessage(ALLOWED_GROUP_ID, `${mention} 🔔 **新消息**\nID: \`${userId}\`\n内容: ${txt}`, { 
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([[Markup.button.callback(`🗑️ 删除此人`, `del_${userId}`)]])
                        });
                    } catch(e) {}
                }
            }
        } catch(e) { console.error("发送失败:", e); }
    });

    socket.on('admin_reply', async ({ targetUserId, content, type, tempId }) => {
        try {
            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            // 管理员回复时，如果用户不存在则自动恢复（SystemRestore）
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
        } catch(e) { console.error("回复失败:", e); }
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

    // 📌 [核心修改] 网页端删除用户，也要暴力断开
    socket.on('admin_clear_user_data', async ({ userId }) => {
        try {
            // 1. 删除数据库
            await prisma.message.deleteMany({ where: { userId } });
            await prisma.user.delete({ where: { id: userId } });
            
            // 2. 暴力断开连接
            await forceDisconnectUser(userId);
            
            io.emit('admin_user_deleted', userId);
        } catch(e) {}
    });

    socket.on('admin_block_user', async ({ userId }) => {
        try {
            await prisma.message.deleteMany({ where: { userId } });
            await prisma.pushSubscription.deleteMany({ where: { userId } });
            await prisma.user.update({ where: { id: userId }, data: { isBlocked: true, isMuted: true } });
            
            io.to('admin_room').emit('admin_user_blocked', userId);
            
            // 暴力断开
            const sockets = await io.in(userId).fetchSockets();
            sockets.forEach(s => {
                s.emit('force_logout_blocked');
                s.disconnect(true);
            });
            
            onlineUsers.delete(userId);
            io.to('admin_room').emit('user_status_change', { userId, online: false });
        } catch(e) {}
    });
});

// 启动服务器
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
