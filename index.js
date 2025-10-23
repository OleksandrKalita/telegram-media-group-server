import express from "express";
import Redis from "ioredis";
import axios from "axios";

const app = express();
app.use(express.json());

// Обробка помилок Redis
const redis = new Redis(process.env.REDIS_URL, {
  retryStrategy: (times) => {
    console.log(`🔄 Redis retry attempt ${times}`);
    return Math.min(times * 50, 2000);
  }
});

redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));

// Функція для витягування інформації про користувача
function getUserInfo(msg) {
  return {
    user_id: msg.from?.id,
    username: msg.from?.username || null,
    first_name: msg.from?.first_name || null,
    last_name: msg.from?.last_name || null,
    chat_id: msg.chat?.id,
    chat_type: msg.chat?.type,
    chat_title: msg.chat?.title || null
  };
}

// Функція для обробки завершення групи
async function processMediaGroup(mediaGroupId, userInfo) {
  try {
    const all = await redis.lrange(mediaGroupId, 0, -1);
    if (all.length === 0) return;
    
    const media = all.map((m) => JSON.parse(m));
    await redis.del(mediaGroupId);
    await redis.del(`timer:${mediaGroupId}`);
    await redis.del(`user:${mediaGroupId}`);
    
    console.log(`📦 Sending ${media.length} files for group ${mediaGroupId}`);
    
    await axios.post(process.env.N8N_WEBHOOK_URL, {
      media_group_id: mediaGroupId,
      files: media,
      user: userInfo,
      timestamp: new Date().toISOString()
    });
    
    console.log(`✅ Sent ${media.length} files to n8n for user @${userInfo.username || userInfo.user_id}`);
  } catch (error) {
    console.error("❌ Error in processMediaGroup:", error.message);
  }
}

app.post("/telegram", async (req, res) => {
  try {
    const update = req.body;
    const msg = update.message;

    if (!msg) return res.sendStatus(200);

    console.log(`📨 Received message ${msg.message_id}`);

    const mediaGroupId = msg.media_group_id;
    const fileId = msg.photo?.[msg.photo.length - 1]?.file_id || msg.document?.file_id || msg.video?.file_id;
    const caption = msg.caption || "";
    const messageId = msg.message_id;
    const userInfo = getUserInfo(msg);

    // Якщо це не група — просто пересилаємо в n8n одразу
    if (!mediaGroupId) {
      console.log(`📤 Sending single file to n8n from user @${userInfo.username || userInfo.user_id}`);
      await axios.post(process.env.N8N_WEBHOOK_URL, { 
        single: true,
        file_id: fileId,
        caption: caption,
        user: userInfo,
        message: msg,
        timestamp: new Date().toISOString()
      });
      console.log(`✅ Sent single file`);
      return res.sendStatus(200);
    }

    // Зберігаємо інформацію про користувача для групи (тільки один раз)
    const userExists = await redis.exists(`user:${mediaGroupId}`);
    if (!userExists) {
      await redis.set(`user:${mediaGroupId}`, JSON.stringify(userInfo), "EX", 10);
    }

    // Зберігаємо елемент у Redis
    await redis.rpush(mediaGroupId, JSON.stringify({ fileId, caption, messageId }));
    console.log(`💾 Saved to Redis group ${mediaGroupId}`);
    
    // Оновлюємо таймер
    await redis.set(`timer:${mediaGroupId}`, Date.now(), "EX", 3);

    // Перевіряємо через 3 секунди
    setTimeout(async () => {
      const timerExists = await redis.exists(`timer:${mediaGroupId}`);
      if (!timerExists) {
        const savedUserInfo = await redis.get(`user:${mediaGroupId}`);
        const userInfoParsed = savedUserInfo ? JSON.parse(savedUserInfo) : userInfo;
        await processMediaGroup(mediaGroupId, userInfoParsed);
      }
    }, 3000);

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error in /telegram:", error.message);
    res.sendStatus(500);
  }
});

app.get("/", (req, res) => {
  res.send("✅ Telegram Webhook Server is running!");
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    redis: redis.status,
    env: {
      hasToken: !!process.env.TELEGRAM_BOT_TOKEN,
      hasRedis: !!process.env.REDIS_URL,
      hasWebhook: !!process.env.N8N_WEBHOOK_URL
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`📍 Environment check:`);
  console.log(`   TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);
  console.log(`   REDIS_URL: ${process.env.REDIS_URL ? '✅' : '❌'}`);
  console.log(`   N8N_WEBHOOK_URL: ${process.env.N8N_WEBHOOK_URL ? '✅' : '❌'}`);
});

// Обробка необроблених помилок
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('💥 Unhandled Rejection:', error);
});