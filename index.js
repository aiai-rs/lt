require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { PrismaClient } = require('@prisma/client');
const { Telegraf } = require('telegraf');
const cors = require('cors');

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const prisma = new PrismaClient();

let bot = null;
if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
}

if (bot) {
    bot.start((ctx) => ctx.reply("System Online. Commands: /ck, /del [id], /sjkqk, /zc [password]"));

    bot.command('ck', async (ctx) => {
        try {
            const userCount = await prisma.user.count();
            const msgCount = await prisma.message.count();
            ctx.reply(`Users: ${userCount}\nMessages: ${msgCount}`);
        } catch (e) {
            ctx.reply("Error fetching stats");
        }
    });

    bot.command('zc', async (ctx) => {
        const text = ctx.message.text.trim();
        const password = text.split(/\s+/)[1]; 

        if (!password) return ctx.reply("Usage: /zc [password]");

        try {
            await prisma.globalConfig.upsert({
                where: { key: 'admin_password' },
                update: { value: password },
                create: { key: 'admin_password', value: password }
            });
            ctx.reply("Password Updated");
        } catch (e) {
            ctx.reply("Database Error");
        }
    });

    bot.command('del', async (ctx) => {
        const userId = ctx.message.text.split(/\s+/)[1];
        if (!userId) return ctx.reply("Usage: /del [userId]");

        try {
            await prisma.user.delete({ where: { id: userId } });
            io.emit('admin_user_deleted', userId);
            ctx.reply(`Deleted User: ${userId}`);
        } catch (e) {
            ctx.reply("User not found or delete failed");
        }
    });

    bot.command('sjkqk', async (ctx) => {
        try {
            await prisma.message.deleteMany({});
            await prisma.user.deleteMany({});
            io.emit('admin_db_cleared');
            ctx.reply("Database Cleared Successfully");
        } catch (e) {
            ctx.reply("Clear Failed");
        }
    });

    bot.launch().catch(err => console.error(err));
    
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    try {
        const config = await prisma.globalConfig.findUnique({ where: { key: 'admin_password' } });
        const validPwd = (config && config.value) || process.env.ADMIN_PASSWORD;

        if (validPwd && password === validPwd) {
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, msg: "Invalid Password" });
        }
    } catch (e) {
        res.status(500).json({ success: false, msg: "Server Error" });
    }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { updatedAt: 'desc' },
            include: { messages: { take: 1, orderBy: { createdAt: 'desc' } } }
        });
        res.json(users);
    } catch (e) { res.status(500).json([]); }
});

app.get('/api/history/:userId', async (req, res) => {
    try {
        const msgs = await prisma.message.findMany({
            where: { userId: req.params.userId },
            orderBy: { createdAt: 'asc' }
        });
        res.json(msgs);
    } catch (e) { res.status(500).json([]); }
});

io.on('connection', (socket) => {
    socket.on('join', ({ userId, bossId, isAdmin }) => {
        if (isAdmin) {
            socket.join('admin_room');
        } else if (userId) {
            socket.join(userId);
            if (bossId) {
                prisma.user.upsert({
                    where: { id: userId },
                    update: { bossId },
                    create: { id: userId, bossId }
                }).catch(()=>{});
            }
        }
    });

    socket.on('send_message', async (data) => {
        const { userId, content, bossId } = data;
        const msg = await prisma.message.create({
            data: { userId, content, isFromUser: true }
        });

        const user = await prisma.user.upsert({
            where: { id: userId },
            update: { updatedAt: new Date(), bossId: bossId || 'Unknown' },
            create: { id: userId, bossId: bossId || 'Unknown' }
        });

        io.to('admin_room').emit('admin_receive_message', { 
            ...msg, 
            bossId: user.bossId 
        });
    });

    socket.on('admin_reply', async (data) => {
        const { targetUserId, content } = data;
        const msg = await prisma.message.create({
            data: { userId: targetUserId, content, isFromUser: false }
        });

        io.to(targetUserId).emit('receive_message', msg);
        io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: 'System' });
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
