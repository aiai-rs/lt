const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { PrismaClient } = require('@prisma/client');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
// 允许网页端连接
const io = new Server(server, { cors: { origin: "*" } });

const prisma = new PrismaClient();
const port = process.env.PORT || 10000;

// ==========================================
//  Bot 专用接口 (对应你的 4 点要求)
// ==========================================

// 【需求 1】: 接收新消息 -> 只通知，不回复
// Bot 收到用户消息后，POST 到这里
app.post('/api/bot/message', async (req, res) => {
  const { userId, content, bossId } = req.body;
  if (!userId || !content) return res.status(400).send("缺参数");

  try {
    // 1. 找用户，没有就建
    let user = await prisma.user.findUnique({ where: { id: String(userId) } });
    
    // 如果是新用户，通知网页端
    if (!user) {
      user = await prisma.user.create({ 
        data: { id: String(userId), bossId: bossId || '未知来源' } 
      });
      io.emit('new_user_online', user); 
    } else {
      // 老用户更新时间
      await prisma.user.update({ 
        where: { id: String(userId) }, 
        data: { updatedAt: new Date() }
      });
    }

    // 2. 存入数据库
    const msg = await prisma.message.create({
      data: {
        content,
        userId: String(userId),
        isFromUser: true // 标记为客户发的
      }
    });

    // 3. 【关键】只推送给网页总控台，不返回任何自动回复内容
    io.emit('admin_receive_message', { ...msg, bossId: user.bossId });

    console.log(`收到 ${bossId} 旗下客户 ${userId} 的消息，已推送给网页。`);
    res.json({ success: true, status: "notified" });

  } catch (e) {
    console.error("接收消息出错:", e);
    res.status(500).send("Server Error");
  }
});

// 【需求 2】: 删除指定用户 (Bot 点击删除按钮后调用)
// Bot 调用这里：POST /api/bot/delete body: { userId: "xxx" }
app.post('/api/bot/delete', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).send("缺 ID");

  try {
    // 物理删除：因为 Schema 里设置了 Cascade，删人会自动删掉他的所有聊天记录
    await prisma.user.delete({ where: { id: String(userId) } });

    // 通知网页端把这个人踢掉
    io.emit('admin_user_deleted', userId);

    console.log(`指令执行：用户 ${userId} 已被彻底抹除。`);
    res.json({ success: true, msg: "已彻底删除该用户及所有数据" });
  } catch (e) {
    res.json({ success: false, msg: "删除失败，可能用户早已不存在" });
  }
});

// 【需求 3】: /ck 指令 (查看数据库数据)
// Bot 收到 /ck 后调用这里：GET /api/bot/check
app.get('/api/bot/check', async (req, res) => {
  try {
    const userCount = await prisma.user.count();
    const msgCount = await prisma.message.count();
    
    // 返回给 Bot 显示的文案
    const text = `📊 **数据库当前状态**\n\n👤 客户总数: ${userCount} 人\n💬 消息总数: ${msgCount} 条\n\n✅ 状态: 运行正常`;
    
    res.json({ text });
  } catch (e) {
    res.status(500).json({ text: "❌ 数据库读取失败" });
  }
});

// 【需求 4】: /sjkqk 指令 (一键清空数据库)
// Bot 收到 /sjkqk 后调用这里：POST /api/bot/clear_all
app.post('/api/bot/clear_all', async (req, res) => {
  try {
    // 执行核平指令
    await prisma.message.deleteMany({}); // 先删消息
    await prisma.user.deleteMany({});    // 再删人

    // 通知网页端刷新
    io.emit('admin_db_cleared');

    console.log("⚠️ 警告：数据库已被一键清空！");
    res.json({ success: true, msg: "♻️ 数据库已成功格式化，所有数据已清空。" });
  } catch (e) {
    res.status(500).json({ success: false, msg: "清空失败: " + e.message });
  }
});


// ==========================================
//  网页端接口 (给你的黑色总控台用)
// ==========================================

// 获取用户列表
app.get('/api/admin/users', async (req, res) => {
  const users = await prisma.user.findMany({ 
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { messages: true } } }
  });
  res.json(users);
});

// 获取聊天历史
app.get('/api/history/:userId', async (req, res) => {
  const msgs = await prisma.message.findMany({ 
    where: { userId: req.params.userId },
    orderBy: { createdAt: 'asc' }
  });
  res.json(msgs);
});

// WebSocket (网页端人工回复)
io.on('connection', (socket) => {
  console.log('老板已连接控制台');

  socket.on('admin_reply', async (data) => {
    const { targetUserId, content } = data;
    
    // 1. 存库
    await prisma.message.create({
      data: { userId: targetUserId, content, isFromUser: false }
    });

    console.log(`老板人工回复给 ${targetUserId}: ${content}`);
    
    // 注意：这里只是存库。
    // 你的 Bot 需要有一个机制来把这条消息发给真正的 TG 用户。
    // 通常 Bot 会轮询或者这里直接调 Bot 发送 API。
  });
});

server.listen(port, () => {
  console.log(`Bot 智能大脑已在端口 ${port} 就绪`);
});
