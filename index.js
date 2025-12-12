// index.js - 汇盈国际后端 (Bot通知 + 网页管理 + 指令控制)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Telegraf, Markup } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, 
  pingTimeout: 60000,
});

const prisma = new PrismaClient();
const bot = new Telegraf(process.env.BOT_TOKEN);

// 老板对应的 TG 群组 ID
const BOSS_GROUPS = {
  '@rrii8': process.env.GROUP_ID_RR, 
  '@iibb8': process.env.GROUP_ID_II 
};

// ================= TG 机器人逻辑 =================

// 1. 监听删除按钮的回调 (点击 [彻底抹除该用户] 触发)
bot.action(/del_(.+)/, async (ctx) => {
    const userId = ctx.match[1];
    try {
        // 数据库物理删除
        await prisma.message.deleteMany({ where: { userId } });
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
        
        // 踢下线前端
        io.to(userId).emit('force_logout');
        io.emit('admin_user_deleted', userId); // 通知后台网页刷新

        await ctx.answerCbQuery("✅ 执行成功：数据已焚毁");
        await ctx.editMessageText(`🗑 该用户 (#${userId}) 已被物理清除。`, { parse_mode: 'Markdown' });
    } catch (e) {
        await ctx.answerCbQuery("❌ 删除失败或用户已不存在");
    }
});

// 2. 监听清空数据库按钮 (点击 [确认清空所有数据] 触发)
bot.action('confirm_reset_db', async (ctx) => {
    try {
        await prisma.message.deleteMany({});
        await prisma.user.deleteMany({});
        
        // 广播全员下线
        io.emit('force_logout'); 
        
        await ctx.answerCbQuery("✅ 数据库已重置");
        await ctx.editMessageText("☢️ **全站数据已清空**\n就像没人来过一样。", { parse_mode: 'Markdown' });
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery("❌ 操作失败");
    }
});

// 3. 【修改】指令: 查看数据统计 /ck
bot.command('ck', async (ctx) => {
    try {
        const userCount = await prisma.user.count();
        const msgCount = await prisma.message.count();
        ctx.reply(`📊 **数据库当前状态**\n\n👤 活跃用户: ${userCount} 人\n💬 存储消息: ${msgCount} 条`, { parse_mode: 'Markdown' });
    } catch (e) {
        ctx.reply("❌ 无法连接数据库，请检查后端配置。");
    }
});

// 4. 【修改】指令: 一键清空数据库 /sjkqc
bot.command('sjkqc', async (ctx) => {
    ctx.reply("⚠️ **高危操作警告**\n\n您正在请求清空整个数据库！这将删除所有用户和聊天记录，且**无法恢复**。\n\n请确认：", 
        Markup.inlineKeyboard([
            Markup.button.callback('☢️ 确认清空所有数据', 'confirm_reset_db'),
            Markup.button.callback('❌ 取消', 'cancel_action')
        ])
    );
});

bot.action('cancel_action', (ctx) => ctx.deleteMessage());


// ================= Socket.io 逻辑 (用户端 + 管理端) =================

io.on('connection', (socket) => {
  
  // --- 用户端逻辑 ---
  socket.on('join', async ({ userId, bossId }) => {
    socket.join(userId); 
    // 更新用户状态
    await prisma.user.upsert({
      where: { id: userId },
      update: { socketId: socket.id, bossId },
      create: { id: userId, bossId, socketId: socket.id }
    });
    // 通知管理端有新人（如果管理端在线）
    io.to('admin_room').emit('new_user_online', { userId, bossId });
  });

  socket.on('send_message', async (data) => {
    const { userId, bossId, content, type } = data;

    // 1. 存库
    await prisma.message.create({
      data: { content, type, isFromUser: true, userId }
    });

    // 2. 转发给管理端网页 (如果业务员在后台网页看着)
    io.to('admin_room').emit('admin_receive_message', {
        ...data,
        createdAt: new Date()
    });

    // 3. 发送 TG 通知 (带删除按钮)
    const groupId = BOSS_GROUPS[bossId];
    if (groupId) {
      const text = `🔔 **新消息** (${bossId})\n用户: \`#${userId}\`\n内容: ${type === 'image' ? '[图片]' : content}`;
      
      const keyboard = Markup.inlineKeyboard([
          Markup.button.callback(`🗑️ 删除此人`, `del_${userId}`)
      ]);

      try {
        await bot.telegram.sendMessage(groupId, text, { parse_mode: 'Markdown', ...keyboard });
      } catch (e) {
        console.error("TG通知失败", e);
      }
    }
  });

  // --- 管理端逻辑 (业务员后台) ---
  socket.on('admin_join', () => {
      socket.join('admin_room'); // 业务员加入管理频道
  });

  socket.on('admin_reply', async (data) => {
      const { targetUserId, content } = data;
      
      // 1. 存库
      await prisma.message.create({
          data: { content, type: 'text', isFromUser: false, userId: targetUserId }
      });

      // 2. 发给用户
      io.to(targetUserId).emit('receive_message', {
          content,
          type: 'text',
          isFromUser: false,
          createdAt: new Date()
      });
  });
});

// ================= API 接口 =================

// 获取所有用户列表 (供后台使用)
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { messages: true } } }
        });
        res.json(users);
    } catch (e) {
        res.status(500).json([]);
    }
});

// 获取某人的聊天记录
app.get('/api/history/:userId', async (req, res) => {
  try {
    const history = await prisma.message.findMany({
      where: { userId: req.params.userId },
      orderBy: { createdAt: 'asc' }
    });
    res.json(history);
  } catch (e) {
    res.status(500).json([]);
  }
});

// 启动
const PORT = process.env.PORT || 3000;
bot.launch();
server.listen(PORT, () => {
  console.log(`Backend running on ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
