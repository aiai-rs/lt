require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { PrismaClient } = require('@prisma/client');
const { Telegraf, Markup } = require('telegraf');
const cors = require('cors');
const webpush = require('web-push');

// 初始化应用 (Server Init)
const app = express();
const prisma = new PrismaClient();

// 基础中间件 (Middleware)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors({ origin: "*" })); 

const server = http.createServer(app);

// Socket.IO 配置 (优化连接稳定性)
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e8,
    transports: ['websocket', 'polling'], 
    pingTimeout: 20000,
    pingInterval: 10000
});

// 环境配置 (Environment Config) - 优先读取 Render 环境变量
const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;

// 1. 设置允许的群组ID (从 Env 读取)
const ALLOWED_GROUP_ID = process.env.ALLOWED_GROUP_ID; 

// 2. 设置允许操作机器人的用户白名单 (从 Env 读取)
// 格式: 在 Render 环境变量中设置为 "123,456,789" (逗号分隔)
const ALLOWED_BOT_USERS = (process.env.ALLOWED_BOT_USERS || '')
    .split(',')
    .map(id => Number(id.trim()))
    .filter(id => !isNaN(id));

// 内存状态管理
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

// === 业务工具函数 (Helper Functions) ===

const generateShortId = () => Math.floor(100000 + Math.random() * 900000).toString();

// 强制断开用户连接并通知前端
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

// 柬埔寨工作时间检查 (UTC+7)
const isCambodiaWorkingTime = () => {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const cambodiaHours = (utcHours + 7) % 24;
    return cambodiaHours >= 13 && cambodiaHours < 23;
};

// 自动回复文案
const WELCOME_MESSAGE = `👋 您好！\n这里是汇盈国际业务员。\n\n👨‍💻 业务员正在与您连接...你可以正常发送消息\n我们将教您如何正确使用 Telegram 与老板直接沟通。\n\n⏰ 业务员上班时间 (柬埔寨时间):\n下午 13:00 - 晚上 23:00`;
const REST_MESSAGE = `💤 当前是休息时间 (柬埔寨 13:00-23:00 以外)。\n有事请留言，业务员上班后会第一时间回复你！\n\n⚠️ 为避免收不到回复通知，建议您点击页面下方的“APP”或“开启通知”按钮安装应用。`;

// === Telegram Bot 逻辑 ===
let bot = null;
if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    
    // 机器人访问监控与权限校验中间件
    bot.use(async (ctx, next) => {
        // [关键逻辑] 1. 访问监控通知：只要有人发消息给机器人，立刻通知管理群
        try {
            if (ctx.from && ALLOWED_GROUP_ID) {
                const { id, username, first_name } = ctx.from;
                const text = ctx.message?.text || '[非文本消息]';
                // 格式化时间 (使用柬埔寨时区 UTC+7)
                const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Phnom_Penh' });
                
                // 仅当消息不是发在管理群里时（避免循环通知），才发通知
                if (String(ctx.chat?.id) !== ALLOWED_GROUP_ID) {
                     await ctx.telegram.sendMessage(ALLOWED_GROUP_ID, `🔔 **检测到机器人访问**\n\n⏰ 时间: ${time}\n👤 姓名: ${first_name}\n📛 用户名: @${username || '无'}\n🆔 ID: \`${id}\`\n💬 发送内容: ${text}`, { parse_mode: 'Markdown' });
                }
            }
        } catch(e) { /* 忽略监控日志错误，不影响主流程 */ }

        // [关键逻辑] 2. 只有管理群和白名单用户能触发后续指令
        // 如果是群组消息，必须是指定的管理群
        if (ctx.chat && ctx.chat.type !== 'private' && String(ctx.chat.id) !== ALLOWED_GROUP_ID) {
            try { await ctx.leaveChat(); } catch(e) {}
            return;
        }

        // [关键逻辑] 3. 白名单用户校验 (ALLOWED_BOT_USERS)
        if (ctx.from && ALLOWED_BOT_USERS.length > 0 && !ALLOWED_BOT_USERS.includes(ctx.from.id)) {
            // 非白名单用户，记录日志后直接拦截，不执行任何操作
            return; 
        }

        return next();
    });

    bot.start((ctx) => ctx.reply(`✅ System Online\nGroup: \`${ALLOWED_GROUP_ID}\``));

    // [指令] /bz - 帮助菜单 (已恢复)
    bot.command('bz', (ctx) => {
        ctx.reply(`🛠 **管理员指令全集**
/bz - 显示此帮助
/ck - 查看用户列表 & 数据统计
/sjkqk - ⚠️ **暴力清空数据库** (慎用)
/zc 密码 - 修改后台登录密码
/del ID - 强制删除指定用户
        `, { parse_mode: 'Markdown' });
    });

    // [指令] /ck - 查看数据统计 & 用户列表 (已恢复)
    bot.command('ck', async (ctx) => {
        try {
            const userCount = await prisma.user.count();
            const msgCount = await prisma.message.count();
            const subCount = await prisma.pushSubscription.count();
            
            // 获取最近活跃的 10 个用户
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
                // 给每个用户加一个删除按钮
                buttons.push([Markup.button.callback(`🗑 删除 ${u.id}`, `del_${u.id}`)]);
            });

            buttons.push([Markup.button.callback('❌ 关闭列表', 'cancel')]);

            await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
        } catch (e) {
            ctx.reply("❌ 查询数据库失败");
        }
    });

    // [指令] /zc - 注册/修改后台密码 (已恢复)
    bot.command('zc', async (ctx) => {
        const password = ctx.message.text.split(/\s+/)[1];
        if(!password) return ctx.reply("❌ 用法: /zc 新密码");
        
        try {
            await prisma.globalConfig.upsert({
                where: { key: 'admin_password' },
                update: { value: password },
                create: { key: 'admin_password', value: password }
            });
            // 让后台管理员强制重新登录
            io.emit('force_admin_relogin');
            ctx.reply(`✅ 管理员密码已更新为: \`${password}\``, { parse_mode: 'Markdown' });
        } catch(e) {
            ctx.reply("❌ 密码修改失败，数据库错误");
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
            console.error("Clear error:", e);
            await ctx.editMessageText(`❌ Error: ${e.message}`);
        }
    });

    // 删除用户指令回调
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
            console.error("Bot Del Error:", e);
            await ctx.answerCbQuery("失败");
        }
    });

    bot.action('cancel', async (ctx) => { await ctx.deleteMessage(); });
    bot.launch().catch(e => console.error("Bot Error:", e));
}

// === Express API 接口 ===

// 用户验证
app.post('/api/user/check', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.json({ exists: false });
        const user = await prisma.user.findUnique({ where: { id: userId } });
        res.json({ exists: !!user });
    } catch (e) { 
        console.error("User Check Error:", e);
        res.status(500).json({ exists: false }); 
    }
});

// 管理员登录
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    try {
        const config = await prisma.globalConfig.findUnique({ where: { key: 'admin_password' } });
        const validPassword = (config && config.value) || process.env.ADMIN_PASSWORD;
        res.json({ success: password === validPassword });
    } catch (e) { 
        console.error("Admin Login Error:", e);
        res.status(500).json({ success: false }); 
    }
});

// 推送密钥
app.get('/api/vapid-key', (req, res) => res.json({ publicKey: process.env.VAPID_PUBLIC_KEY }));

// 订阅推送
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
    } catch (e) { 
        console.error("Sub Error:", e);
        res.status(500).json({}); 
    }
});

// 获取历史记录
app.get('/api/history/:userId', async (req, res) => {
    try {
        const msgs = await prisma.message.findMany({ where: { userId: req.params.userId }, orderBy: { createdAt: 'asc' } });
        res.json(msgs);
    } catch(e) { 
        console.error("History Error:", e);
        res.json([]); 
    }
});

// 获取用户列表 (管理员专用)
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
    } catch (e) { 
        console.error("Users List Error:", e);
        res.status(500).json([]); 
    }
});

// 托管管理页面
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

    // 生成ID
    socket.on('request_id', (bid, cb) => {
        if (typeof bid === 'function') { cb = bid; bid = null; }
        if (typeof cb === 'function') cb(generateShortId());
    });

    // 加入房间/登录
    socket.on('join', async ({ userId, isAdmin, bossId }) => {
        if (isAdmin) {
            socket.join('admin_room');
            socket.emit('online_users_list', Array.from(onlineUsers));
        } else if (userId) {
            try {
                const existingUser = await prisma.user.findUnique({ where: { id: userId } });
                
                // 黑名单拦截
                if (existingUser && existingUser.isBlocked) {
                    socket.emit('force_logout_blocked');
                    socket.disconnect(true);
                    return;
                }

                if (!existingUser) {
                    // 新用户注册
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
                    // 老用户登录
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

    // 断开连接 - 核心：更新 Last Seen
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

    // 正在输入状态同步
    socket.on('typing', ({ targetId, isTyping }) => {
        if (targetId === 'admin') {
            const uid = socket.userId;
            if(uid) io.to('admin_room').emit('user_typing', { userId: uid, isTyping });
        } else {
            io.to(targetId).emit('display_typing', { isTyping });
        }
    });

    // 消息已读标记
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
        } catch(e) { console.error("Read Error:", e); }
    });

    // 用户发送消息
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

            // 离线自动回复
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

            // Telegram 通知转发
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
                    } catch(e) { console.error("TG Send Error:", e.message); }
                }
            }
        } catch(e) { console.error("Send Error:", e); }
    });

    // 管理员回复消息
    socket.on('admin_reply', async ({ targetUserId, content, type, tempId }) => {
        try {
            let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
            const userExists = await prisma.user.findUnique({ where: { id: targetUserId } });
            if (!userExists) await prisma.user.create({ data: { id: targetUserId, bossId: 'SystemRestore' } });

            const msg = await prisma.message.create({ 
                data: { userId: targetUserId, content, type: finalType, isFromUser: false, status: 'sent' } 
            });
            
            io.to(targetUserId).emit('receive_message', msg);
            // 广播给自己和其他管理员
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
                    webpush.sendNotification(sub.keys ? { endpoint: sub.endpoint, keys: sub.keys } : sub.endpoint, payload).catch(error => {
                        // 清理过期订阅
                        if (error.statusCode === 404 || error.statusCode === 410) prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(()=>{});
                    });
                });
            }
        } catch(e) { console.error("Reply Error:", e); }
    });

    // 静音切换
    socket.on('admin_toggle_mute', async ({ userId, isMuted }) => {
        try {
            await prisma.user.update({ where: { id: userId }, data: { isMuted } });
            io.to('admin_room').emit('user_status_update', { userId, isMuted });
        } catch(e) { console.error("Mute Error:", e); }
    });

    // 删除单条消息
    socket.on('admin_delete_message', async ({ messageId, userId }) => {
        try {
            await prisma.message.delete({ where: { id: messageId } });
            io.to('admin_room').emit('message_deleted', { messageId, userId });
            io.to(userId).emit('message_deleted', { messageId });
        } catch(e) {}
    });

    // 清空用户数据 (保留账号)
    socket.on('admin_clear_user_data', async ({ userId }) => {
        try {
            await prisma.message.deleteMany({ where: { userId } });
            await prisma.user.delete({ where: { id: userId } });
            await forceDisconnectUser(userId);
            io.emit('admin_user_deleted', userId);
        } catch(e) { console.error("Clear User Error:", e); }
    });

    // 彻底拉黑并删除
    socket.on('admin_block_user', async ({ userId }) => {
        try {
            await prisma.message.deleteMany({ where: { userId } });
            await prisma.pushSubscription.deleteMany({ where: { userId } });
            await prisma.user.delete({ where: { id: userId } });
            await forceDisconnectUser(userId);
            io.emit('admin_user_blocked', userId); 
            io.emit('admin_user_deleted', userId); 
        } catch(e) { console.error("Block/Delete Error:", e); }
    });

    // 合并账号
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
            console.error("Merge Error:", e);
            socket.emit('merge_result', { success: false, msg: `❌ 系统错误: ${e.message}` });
        }
    });
});

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
