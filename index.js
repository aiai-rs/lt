require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { PrismaClient } = require('@prisma/client');
const { Telegraf, Markup } = require('telegraf'); 
const cors = require('cors');

const app = express();
app.use(cors());
// 开启大文件支持(图片)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // Socket 100MB 限制
});
const prisma = new PrismaClient();

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;

let bot = null;

if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    console.log("🤖 机器人启动中...");

    // 1. 启动 & 绑定通知群组
    bot.start(async (ctx) => {
        const chatId = String(ctx.chat.id);
        try {
            await prisma.globalConfig.upsert({
                where: { key: 'admin_tg_id' },
                update: { value: chatId },
                create: { key: 'admin_tg_id', value: chatId }
            });
            const type = ctx.chat.type === 'private' ? '个人' : '群组';
            ctx.reply(`✅ 系统已连接！通知已绑定到当前${type} (ID: ${chatId})`);
        } catch (e) { ctx.reply("⚠️ 数据库连接错误"); }
    });

    // 2. 查状态
    bot.command('ck', async (ctx) => {
        try {
            const u = await prisma.user.count();
            const m = await prisma.message.count();
            ctx.reply(`📊 用户数: ${u} | 消息数: ${m}`);
        } catch (e) { ctx.reply("❌ 数据库连接失败"); }
    });

    // 3. 改密码
    bot.command('zc', async (ctx) => {
        const p = ctx.message.text.split(/\s+/)[1];
        if (!p) return ctx.reply("❌ 用法: /zc 新密码");
        try {
            await prisma.globalConfig.upsert({
                where: { key: 'admin_password' },
                update: { value: p },
                create: { key: 'admin_password', value: p }
            });
            ctx.reply(`✅ 密码已更新`);
        } catch (e) { ctx.reply("❌ 失败"); }
    });

    // 4. 清库 (按钮确认版)
    bot.command('sjkqk', (ctx) => {
        ctx.reply('⚠️ **警告**：确定要删除所有数据吗？', 
            Markup.inlineKeyboard([
                [Markup.button.callback('❌ 取消', 'cancel_clear'), Markup.button.callback('✅ 确认清空', 'confirm_clear')]
            ])
        );
    });
    
    // 处理清库按钮
    bot.action('confirm_clear', async (ctx) => {
        try {
            await prisma.message.deleteMany({});
            await prisma.user.deleteMany({});
            io.emit('admin_db_cleared');
            await ctx.editMessageText("💥 数据库已清空");
        } catch (e) { await ctx.editMessageText("❌ 清空失败"); }
    });
    
    bot.action('cancel_clear', async (ctx) => {
        await ctx.editMessageText("🛡️ 操作已取消");
    });

    // 5. 按钮回调：删除指定用户
    bot.action(/del_user_(.+)/, async (ctx) => {
        const targetId = ctx.match[1];
        try {
            await prisma.user.delete({ where: { id: targetId } });
            io.emit('admin_user_deleted', targetId);
            await ctx.editMessageText(`🗑️ 用户 \`${targetId}\` 已删除。`, { parse_mode: 'Markdown' });
        } catch (e) {
            await ctx.answerCbQuery("删除失败或用户已不存在");
        }
    });

    bot.launch().catch(err => console.error(err));
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ================= API 接口 =================
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    const dbConfig = await prisma.globalConfig.findUnique({ where: { key: 'admin_password' } });
    const validPwd = (dbConfig && dbConfig.value) || process.env.ADMIN_PASSWORD || "123456";
    if (password === validPwd) res.json({ success: true });
    else res.status(401).json({ success: false });
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { updatedAt: 'desc' },
            include: { messages: { take: 1, orderBy: { createdAt: 'desc' } } }
        });
        res.json(users);
    } catch (e) { res.json([]); }
});

app.get('/api/history/:userId', async (req, res) => {
    try {
        const msgs = await prisma.message.findMany({
            where: { userId: req.params.userId },
            orderBy: { createdAt: 'asc' }
        });
        res.json(msgs);
    } catch (e) { res.json([]); }
});

// 托管 admin.html (方便你直接访问)
app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/admin.html');
});

// ================= Socket 通讯 =================
io.on('connection', (socket) => {
    socket.on('join', async ({ userId, bossId, isAdmin }) => {
        if (isAdmin) socket.join('admin_room');
        else if (userId) {
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

    socket.on('send_message', async ({ userId, content, bossId }) => {
        // 存库
        const msg = await prisma.message.create({ data: { userId, content, isFromUser: true } });
        
        // 更新用户
        const user = await prisma.user.upsert({
            where: { id: userId },
            update: { updatedAt: new Date(), bossId: bossId || '未知' },
            create: { id: userId, bossId: bossId || '未知' }
        });

        // 推送给网页
        io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: user.bossId });

        // 🔥 TG 通知 (含 @提醒 和 删除按钮)
        if (bot) {
            try {
                const config = await prisma.globalConfig.findUnique({ where: { key: 'admin_tg_id' } });
                if (config && config.value) {
                    let mentionTag = "";
                    if (bossId && bossId !== '未知') {
                        const cleanId = bossId.replace('@', ''); 
                        mentionTag = `@${cleanId}`; // 生成 @iibb8
                    }
                    
                    const isImg = content.startsWith('data:image');
                    const textDisplay = isImg ? "📷 [图片]" : content.substring(0, 100);

                    const alertMsg = `${mentionTag} 🔔 **新消息**\n👤: \`${userId.slice(0,6)}\`\n🏷️: ${bossId}\n💬: ${textDisplay}`;
                    
                    // 发送带按钮的消息
                    bot.telegram.sendMessage(config.value, alertMsg, { 
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback(`🗑️ 删除此用户`, `del_user_${userId}`)]
                        ])
                    });
                }
            } catch (e) {}
        }
    });

    socket.on('admin_reply', async ({ targetUserId, content }) => {
        const msg = await prisma.message.create({ data: { userId: targetUserId, content, isFromUser: false } });
        io.to(targetUserId).emit('receive_message', msg);
        io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: 'System' });
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
