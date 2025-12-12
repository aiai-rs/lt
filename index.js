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

let bot = null;

// 生成6位纯数字ID工具
const generateShortId = () => Math.floor(100000 + Math.random() * 900000).toString();

// ================= Bot 逻辑 =================
if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    console.log("🤖 机器人启动中...");

    bot.start(async (ctx) => {
        const chatId = String(ctx.chat.id);
        try {
            await prisma.globalConfig.upsert({
                where: { key: 'admin_tg_id' },
                update: { value: chatId },
                create: { key: 'admin_tg_id', value: chatId }
            });
            ctx.reply(`✅ 系统已就绪！\n通知ID: ${chatId}\n\n💡 指令提示：\n发送 "删除 123456" -> 删除指定用户\n网页后台可单独静音某个用户。`);
        } catch (e) { ctx.reply("⚠️ 数据库错误"); }
    });

    // 中文删除指令监听
    bot.hears(/^删除\s+(\d+)$/, (ctx) => {
        const targetId = ctx.match[1];
        ctx.reply(`⚠️ **敏感操作确认**\n\n你申请删除用户 ID: \`${targetId}\`\n该用户所有数据将永久消失！`, 
            Markup.inlineKeyboard([
                [Markup.button.callback('❌ 取消', 'cancel_act'), Markup.button.callback('✅ 确认删除', `confirm_del_${targetId}`)]
            ])
        );
    });

    // 删除确认回调
    bot.action(/confirm_del_(.+)/, async (ctx) => {
        const targetId = ctx.match[1];
        try {
            await prisma.user.delete({ where: { id: targetId } });
            io.emit('admin_user_deleted', targetId);
            io.to(targetId).emit('force_logout'); // 踢下线
            await ctx.editMessageText(`🗑️ 用户 \`${targetId}\` 已成功删除。`, { parse_mode: 'Markdown' });
        } catch (e) { await ctx.editMessageText("❌ 删除失败，用户可能不存在。"); }
    });

    bot.action('cancel_act', async (ctx) => {
        await ctx.editMessageText("🛡️ 操作已取消。");
    });

    // 辅助指令
    bot.command('ck', async (ctx) => {
        const u = await prisma.user.count();
        const m = await prisma.message.count();
        ctx.reply(`📊 用户: ${u} | 消息: ${m}`);
    });

    bot.command('zc', async (ctx) => {
        const p = ctx.message.text.split(/\s+/)[1];
        if(!p) return ctx.reply("❌ 用法: /zc 新密码");
        await prisma.globalConfig.upsert({
            where: { key: 'admin_password' },
            update: { value: p },
            create: { key: 'admin_password', value: p }
        });
        ctx.reply("✅ 密码已修改");
    });

    bot.launch().catch(err => console.error(err));
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ================= API =================
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
        const msgs = await prisma.message.findMany({ where: { userId: req.params.userId }, orderBy: { createdAt: 'asc' } });
        res.json(msgs);
    } catch (e) { res.json([]); }
});

app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));

// ================= Socket =================
io.on('connection', (socket) => {
    // 申请纯数字ID
    socket.on('request_id', async (bossId, callback) => {
        let newId = generateShortId();
        callback(newId);
    });

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

    // 切换静音 (Admin调用)
    socket.on('admin_toggle_mute', async ({ userId, isMuted }) => {
        try {
            await prisma.user.update({ where: { id: userId }, data: { isMuted } });
            // 广播更新用户列表状态
            io.to('admin_room').emit('user_status_update', { userId, isMuted });
        } catch(e) {}
    });

    socket.on('send_message', async ({ userId, content, type, bossId }) => {
        let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
        
        // 1. 存库
        const msg = await prisma.message.create({ data: { userId, content, type: finalType, isFromUser: true } });
        
        // 2. 更新用户 (获取最新静音状态)
        const user = await prisma.user.upsert({
            where: { id: userId },
            update: { updatedAt: new Date(), bossId: bossId || '未知' },
            create: { id: userId, bossId: bossId || '未知' }
        });

        // 3. 推送前端
        io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: user.bossId, isMuted: user.isMuted });

        // 4. TG 通知 (🔴 核心逻辑：检查是否被静音)
        if (bot && !user.isMuted) { // 只有没静音才发
            try {
                const config = await prisma.globalConfig.findUnique({ where: { key: 'admin_tg_id' } });
                if (config && config.value) {
                    let mention = (bossId && bossId!=='未知') ? `@${bossId.replace('@','')}` : '';
                    const txt = finalType === 'image' ? "📷 [图片]" : content.substring(0, 100);
                    
                    bot.telegram.sendMessage(config.value, `${mention} 🔔 **消息** (ID: \`${userId}\`)\n来自: ${bossId}\n💬: ${txt}`, { 
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([[Markup.button.callback(`🗑️ 删除 ${userId}`, `confirm_del_${userId}`)]])
                    });
                }
            } catch (e) {}
        }
    });

    socket.on('admin_reply', async ({ targetUserId, content, type }) => {
        let finalType = type || (content.startsWith('data:image') ? 'image' : 'text');
        const msg = await prisma.message.create({ data: { userId: targetUserId, content, type: finalType, isFromUser: false } });
        io.to(targetUserId).emit('receive_message', msg);
        io.to('admin_room').emit('admin_receive_message', { ...msg, bossId: 'System' });
    });
});

server.listen(PORT, () => { console.log(`Run on ${PORT}`); });
