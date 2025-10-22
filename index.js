import express from "express";
import Redis from "ioredis";
import axios from "axios";

const app = express();
app.use(express.json());

const redis = new Redis(process.env.REDIS_URL);

// Функція для обробки завершення групи
async function processMediaGroup(mediaGroupId) {
  const all = await redis.lrange(mediaGroupId, 0, -1);
  if (all.length === 0) return;
  
  const media = all.map((m) => JSON.parse(m));
  await redis.del(mediaGroupId);
  await redis.del(`timer:${mediaGroupId}`);
  
  try {
    await axios.post(process.env.N8N_WEBHOOK_URL, {
      media_group_id: mediaGroupId,
      files: media,
    });
    console.log(`✅ Sent ${media.length} files to n8n for group ${mediaGroupId}`);
  } catch (error) {
    console.error("❌ Error sending to n8n:", error.message);
  }
}

app.post("/telegram", async (req, res) => {
  const update = req.body;
  const msg = update.message;

  if (!msg) return res.sendStatus(200);

  const mediaGroupId = msg.media_group_id;
  const fileId = msg.photo?.[msg.photo.length - 1]?.file_id || msg.document?.file_id || msg.video?.file_id;
  const caption = msg.caption || "";
  const messageId = msg.message_id;

  // Якщо це не група — просто пересилаємо в n8n одразу
  if (!mediaGroupId) {
    try {
      await axios.post(process.env.N8N_WEBHOOK_URL, { 
        single: true,
        file_id: fileId,
        caption: caption,
        message: msg 
      });
      console.log(`✅ Sent single file to n8n`);
    } catch (error) {
      console.error("❌ Error sending single file:", error.message);
    }
    return res.sendStatus(200);
  }

  // Зберігаємо елемент у Redis
  await redis.rpush(mediaGroupId, JSON.stringify({ fileId, caption, messageId }));
  
  // Оновлюємо таймер (кожне нове фото скидає таймер)
  await redis.set(`timer:${mediaGroupId}`, Date.now(), "EX", 3);

  // Перевіряємо через 3 секунди
  setTimeout(async () => {
    const timerExists = await redis.exists(`timer:${mediaGroupId}`);
    if (!timerExists) {
      await processMediaGroup(mediaGroupId);
    }
  }, 3000);

  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("✅ Telegram Webhook Server is running!");
});

app.listen(process.env.PORT || 3000, () => 
  console.log(`🚀 Server started on port ${process.env.PORT || 3000}`)
);