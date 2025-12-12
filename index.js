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

// 🔴 用于存储待确认的用户ID (清库保护)
const pendingClear = new Set();

let bot = null;

// ================= Bot 逻辑区域 =================
if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    console.log("🤖 机器人正在启动...");

    // 1. 欢迎语
    bot.start((ctx) => {
        ctx.reply("👋 HY 客服系统已上线。\n\n可用指令：\n/ck - 📊 查看数据状态\n/zc [密码] - 🔐 设置后台密码\n/del [ID] - 🗑️ 删除指定用户\n/sjkqk - 💥 清空所有数据 (慎用)");
    });

    // 2. /ck 查看状态
    bot.command('ck', async (ctx) => {
        try {
            const userCount = await prisma.user.count();
            const msgCount = await prisma.message.count();
            ctx.reply(`📊 **数据库连接正常**\n👤 客户总数: ${userCount} 人\n💬 消息总数: ${msgCount} 条`);
        } catch (error) {
            console.error("查询失败:", error);
            ctx.reply("❌ 无法连接数据库。\n请检查是否在 Shell 运行了 'npx prisma db push'");
        }
    });

    // 3. /zc 设置密码
    bot.command('zc', async (ctx) => {
        const text = ctx.message.text.trim();
        const parts = text.split(/\s+/);
        if (parts.length < 2) return ctx.reply("❌ 格式错误。请发送：/zc 新密码");
        
        try {
            await prisma.globalConfig.upsert({
                where: { key: 'admin_password' },
                update: { value: parts[1] },
                create: { key: 'admin_password', value: parts[1] }
            });
            ctx.reply(`✅ 密码已更新为：${parts[1]}`);
        } catch (error) {
            ctx.reply("❌ 密码保存失败，数据库错误。");
        }
    });

    // 4. /del 删除用户
    bot.command('del', async (ctx) => {
        const parts = ctx.message.text.trim().split(/\s+/);
        if (parts.length < 2) return ctx.reply("❌ 格式错误。请发送：/del 用户ID");
        
        try {
            await prisma.user.delete({ where: { id: parts[1] } });
            io.emit('admin_user_deleted', parts[1]);
            ctx.reply(`🗑️ 用户 ${parts[1]} 已成功删除。`);
        } catch (error) {
            ctx.reply("❌ 删除失败，未找到该用户。");
        }
    });

    // 5. /sjkqk 清空数据库 (第一步：申请)
    bot.command('sjkqk', async (ctx) => {
        const userId = ctx.from.id;
        pendingClear.add(userId); // 加入待确认列表
        
        ctx.reply("⚠️ **高能预警！** ⚠️\n\n此操作将 **永久删除** 所有客户和聊天记录！\n\n请在 30 秒内发送 /qr 进行最终确认。");

        // 30秒后自动取消资格
        setTimeout(() => {
            if (pendingClear.has(userId)) {
                pendingClear.delete(userId);
                ctx.reply("⏳ 操作超时，清库请求已自动取消。");
            }
        }, 30000);
    });

    // 6. /qr 确认清空 (第二步：执行)
    bot.command('qr', async (ctx) => {
        const userId = ctx.from.id;
        
        if (pendingClear.has(userId)) {
            try {
                await prisma.message.deleteMany({});
                await prisma.user.deleteMany({});
                io.emit('admin_db_cleared');
                ctx.reply("💥 **操作成功**：数据库已格式化，所有数据已清空。");
            } catch (error) {
                ctx.reply("❌ 清空失败，数据库发生错误。");
            }
            pendingClear.delete(userId); // 移除标记
        } else {
            ctx.reply("❓ 没有待确认的指令。请先发送 /sjkqk");
        }
    });

    bot.launch().catch(err => console.error("机器人启动失败:", err));
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
} else {
    console.log("⚠️ 警告: 未检测到 BOT_TOKEN，机器人功能无法使用。");
}

// ================= 网页后端接口 =================

// 登录验证
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    try {
        const dbConfig = await prisma.globalConfig.findUnique({ where: { key: 'admin_password' } });
        const validPwd = (dbConfig && dbConfig.value) || process.env.ADMIN_PASSWORD || "123456";

        if (password === validPwd) {
            res.json({ success: true, msg: "登录成功" });
        } else {
            res.status(401).json({ success: false, msg: "密码错误" });
        }
    } catch (error) {
        res.status(500).json({ success: false, msg: "服务器验证出错" });
    }
});

// 获取用户列表
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { updatedAt: 'desc' },
            include: { messages: { take: 1, orderBy: { createdAt: 'desc' } } }
        });
        res.json(users);
    } catch (error) { res.status(500).json([]); }
});

// 获取聊天记录
app.get('/api/history/:userId', async (req, res) => {
    try {
        const history = await prisma.message.findMany({
            where: { userId: req.params.userId },
            orderBy: { createdAt: 'asc' }
        });
        res.json(history);
    } catch (error) { res.status(500).json([]); }
});

// Socket.io 实时通讯
io.on('connection', (socket) => {
    socket.on('join', async ({ userId, bossId, isAdmin }) => {
        if (isAdmin) {
            socket.join('admin_room');
        } else if (userId) {
            socket.join(userId);
            if (bossId) {
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
            const msg = await prisma.message.create({
                data: { userId, content, isFromUser: true }
            });
            const user = await prisma.user.upsert({
                where: { id: userId },
                update: { updatedAt: new Date(), bossId: bossId || '未知' },
                create: { id: userId, bossId: bossId || '未知' }
            });
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: user.bossId });
        } catch(e) { console.error("消息保存失败:", e); }
    });

    socket.on('admin_reply', async ({ targetUserId, content }) => {
        try {
            const msg = await prisma.message.create({
                data: { userId: targetUserId, content, isFromUser: false }
            });
            io.to(targetUserId).emit('receive_message', msg);
            io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: 'System' });
        } catch(e) { console.error("回复失败:", e); }
    });
});

server.listen(PORT, () => {
    console.log(`🚀 服务器已启动，端口: ${PORT}`);
});
