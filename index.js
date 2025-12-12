require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { PrismaClient } = require('@prisma/client');
const { Telegraf } = require('telegraf');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const prisma = new PrismaClient();

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;

let bot = null;

// Bot 初始化
if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    console.log("Bot Starting...");

    // 1. 启动欢迎语
    bot.start((ctx) => {
        ctx.reply("HY System Online.\nCommands:\n/ck - Check DB Status\n/zc [password] - Set Admin Password\n/del [id] - Delete User\n/sjkqk - Clear All Data");
    });

    // 2. /ck 检查数据库状态 (你报错就是因为还没建表)
    bot.command('ck', async (ctx) => {
        try {
            // 这里会尝试连接数据库
            const userCount = await prisma.user.count();
            const msgCount = await prisma.message.count();
            ctx.reply(`Database Connected ✅\nUsers: ${userCount}\nMessages: ${msgCount}`);
        } catch (error) {
            console.error("DB Check Error:", error);
            // 看到这句话说明 prisma db push 没跑
            ctx.reply("❌ Database Connection Failed.\nDid you run 'npx prisma db push'?");
        }
    });

    // 3. /zc 设置密码
    bot.command('zc', async (ctx) => {
        const text = ctx.message.text.trim();
        const parts = text.split(/\s+/);
        if (parts.length < 2) return ctx.reply("Usage: /zc [new_password]");
        
        try {
            await prisma.globalConfig.upsert({
                where: { key: 'admin_password' },
                update: { value: parts[1] },
                create: { key: 'admin_password', value: parts[1] }
            });
            ctx.reply("Password Updated.");
        } catch (error) {
            ctx.reply("Error saving password.");
        }
    });

    // 4. /del 删除用户
    bot.command('del', async (ctx) => {
        const parts = ctx.message.text.trim().split(/\s+/);
        if (parts.length < 2) return ctx.reply("Usage: /del [user_id]");
        
        try {
            await prisma.user.delete({ where: { id: parts[1] } });
            io.emit('admin_user_deleted', parts[1]);
            ctx.reply(`User ${parts[1]} deleted.`);
        } catch (error) {
            ctx.reply("Delete failed (User not found).");
        }
    });

    // 5. /sjkqk 清空数据库
    bot.command('sjkqk', async (ctx) => {
        try {
            await prisma.message.deleteMany({});
            await prisma.user.deleteMany({});
            io.emit('admin_db_cleared');
            ctx.reply("Database Cleared.");
        } catch (error) {
            ctx.reply("Clear failed.");
        }
    });

    bot.launch().catch(err => console.error("Bot Error:", err));
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// 网页端 API - 登录
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    try {
        const dbConfig = await prisma.globalConfig.findUnique({ where: { key: 'admin_password' } });
        // 优先用数据库密码，没有则用环境变量，都没有则默认 123456
        const validPwd = (dbConfig && dbConfig.value) || process.env.ADMIN_PASSWORD || "123456";

        if (password === validPwd) {
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, msg: "Wrong Password" });
        }
    } catch (error) {
        res.status(500).json({ success: false, msg: "Login Error" });
    }
});

// 网页端 API - 获取用户列表
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { updatedAt: 'desc' },
            include: { messages: { take: 1, orderBy: { createdAt: 'desc' } } }
        });
        res.json(users);
    } catch (error) { res.status(500).json([]); }
});

// 网页端 API - 获取历史记录
app.get('/api/history/:userId', async (req, res) => {
    try {
        const history = await prisma.message.findMany({
            where: { userId: req.params.userId },
            orderBy: { createdAt: 'asc' }
        });
        res.json(history);
    } catch (error) { res.status(500).json([]); }
});

// Socket.io 逻辑
io.on('connection', (socket) => {
    socket.on('join', async ({ userId, bossId, isAdmin }) => {
        if (isAdmin) {
            socket.join('admin_room');
        } else if (userId) {
            socket.join(userId);
            if (bossId) {
                // 记录用户来源
                try {
                    await prisma.user.upsert({
                        where: { id: userId },
                        update: { bossId },
                        create: { id: userId, bossId }
                    });
                } catch(e) {}
            }
        }
    });

    socket.on('send_message', async ({ userId, content, bossId }) => {
        try {
            // 存消息
            const msg = await prisma.message.create({
                data: { userId, content, isFromUser: true }
            });
            // 更新用户时间
            const user = await prisma.user.upsert({
                where: { id: userId },
                update: { updatedAt: new Date(), bossId: bossId || 'Unknown' },
                create: { id: userId, bossId: bossId || 'Unknown' }
            });
            // 通知后台
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: user.bossId });
        } catch(e) { console.error(e); }
    });

    socket.on('admin_reply', async ({ targetUserId, content }) => {
        try {
            const msg = await prisma.message.create({
                data: { userId: targetUserId, content, isFromUser: false }
            });
            io.to(targetUserId).emit('receive_message', msg);
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: 'System' });
        } catch(e) { console.error(e); }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
