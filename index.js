import express from "express";
import Redis from "ioredis";
import axios from "axios";

const app = express();
app.use(express.json());

// 1️⃣ Підключення до Redis (змінна середовища)
const redis = new Redis(process.env.REDIS_URL);

// 2️⃣ Твій Webhook від Telegram
app.post("/telegram", async (req, res) => {
  const update = req.body;
  const msg = update.message;

  if (!msg) return res.sendStatus(200);

  const mediaGroupId = msg.media_group_id;
  const fileId = msg.photo?.[0]?.file_id || msg.document?.file_id || msg.video?.file_id;
  const caption = msg.caption || "";

  // Якщо це не група — просто пересилаємо в n8n одразу
  if (!mediaGroupId) {
    await axios.post(process.env.N8N_WEBHOOK_URL, { single: msg });
    return res.sendStatus(200);
  }

  // 3️⃣ Зберігаємо елемент у Redis
  await redis.rpush(mediaGroupId, JSON.stringify({ fileId, caption }));

  // 4️⃣ Перевіряємо, чи це перше повідомлення в групі
  const exists = await redis.get(`timer:${mediaGroupId}`);
  if (!exists) {
    await redis.set(`timer:${mediaGroupId}`, "1", "EX", 5); // таймер на 5 секунд

    // Через 5 секунд після останнього повідомлення — зібрати групу
    setTimeout(async () => {
      const all = await redis.lrange(mediaGroupId, 0, -1);
      const media = all.map((m) => JSON.parse(m));
      await redis.del(mediaGroupId);
      await redis.del(`timer:${mediaGroupId}`);

      // Відправляємо один запит до n8n з усією групою
      await axios.post(process.env.N8N_WEBHOOK_URL, {
        media_group_id: mediaGroupId,
        files: media,
      });
    }, 5000);
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("✅ Telegram Webhook Server is running!");
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Server started"));
