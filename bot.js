require("dotenv").config(); // Подключаем dotenv
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");
const fs = require("fs");
const path = require("path");

const {
  BOT_TOKEN,
  MONGODB_HOST,
  MONGODB_PORT,
  MONGODB_USERNAME,
  MONGODB_PASSWORD,
  MONGODB_DBNAME,
} = process.env;

const passwordEncoded = encodeURIComponent(MONGODB_PASSWORD);

// Добавляем &directConnection=true
const mongoUri =
  `mongodb://${MONGODB_USERNAME}:${passwordEncoded}` +
  `@${MONGODB_HOST}:${MONGODB_PORT}/${MONGODB_DBNAME}?authSource=admin&directConnection=true`;

console.log("BOT_TOKEN:", BOT_TOKEN);
console.log("MONGODB_HOST:", MONGODB_HOST);
console.log("MONGODB_USERNAME:", MONGODB_USERNAME);
console.log("MONGODB_PASSWORD:", MONGODB_PASSWORD);
console.log("MONGODB_DBNAME:", MONGODB_DBNAME);

// Подключаемся к MongoDB с увеличенными таймаутами
mongoose
  .connect(mongoUri, {
    connectTimeoutMS: 30000,
    socketTimeoutMS: 30000,
  })
  .then(() => console.log("✅ Успешное подключение к MongoDB"))
  .catch((err) => console.error("❌ Ошибка подключения к MongoDB:", err));

// ==========================
//  Schema & Model
// ==========================
const userSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, required: true },
  username: { type: String, required: true },
  click_id: { type: String, default: "none" }, // чистый CID без суффикса
  link: { type: String, required: true }, // итоговая ссылка на оффер
  complete: { type: [String], default: [] },
  status: {
    type: String,
    enum: ["mes", "reg", "dep"],
    default: "mes",
  },
});

const User = mongoose.model("User", userSchema);

// ==========================
//  HTTP сервер для изменения статуса
// ==========================
const app = express();

//  GET /setStatus?telegramId=123456789&status=reg
app.get("/setStatus", async (req, res) => {
  const { telegramId, status } = req.query;

  // валидация входных данных
  if (!telegramId || !status)
    return res
      .status(400)
      .json({ error: "telegramId and status are required" });
  if (!["mes", "reg", "dep"].includes(status))
    return res.status(400).json({ error: "status must be mes, reg or sale" });

  try {
    const user = await User.findOneAndUpdate(
      { telegramId: Number(telegramId) },
      { $set: { status } },
      { new: true } // вернуть обновлённый документ
    );

    if (!user)
      return res
        .status(404)
        .json({ error: `User with telegramId ${telegramId} not found` });

    res.json({ success: true, user });
  } catch (err) {
    console.error("Error updating status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌐 Status API is listening on port ${PORT}`)
);

// ==========================
//  Bot init
// ==========================
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 100,
    autoStart: true,
    params: { timeout: 10 },
  },
});

const ADMIN_ID = 1370034279;

// ---------- Читаем файл с отзывами ----------
let reviewsLines = [];
try {
  const reviewsData = fs.readFileSync(
    path.join(__dirname, "reviews.txt"),
    "utf-8"
  );
  reviewsLines = reviewsData
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/\\n/g, "\n"));
} catch (err) {
  console.warn(
    "Файл reviews.txt не найден или пуст — продолжаем без отзывов",
    err
  );
}

const possibleExtensions = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".mp4",
  ".mov",
  ".webp",
];
const reviewsArray = [];
reviewsLines.forEach((text, idx) => {
  const base = String(idx + 1);
  const file = possibleExtensions.find((ext) =>
    fs.existsSync(path.join(__dirname, "reviews", base + ext))
  );
  if (!file) return;
  const filePath = path.join(__dirname, "reviews", base + file);
  const type = [".mp4", ".mov"].includes(file) ? "video" : "photo";
  reviewsArray.push({ text, filePath, type });
});

// ========== Константы состояний опроса ==========
const STATES = { NONE: "none", Q1: "q1", Q2: "q2", Q3: "q3" };
const userStates = {}; // хранение состояний в памяти

// --------------------------------------------------
//  Безопасные helpers на отправку / удаление
// --------------------------------------------------
const safeSendMessage = async (id, text, opts = {}) => {
  try {
    return await bot.sendMessage(id, text, opts);
  } catch (err) {
    if (err.response?.body?.error_code === 403) {
      console.log(`Пользователь ${id} заблокировал бота или недоступен.`);
    } else console.error("Ошибка sendMessage:", err);
    return null;
  }
};

const safeDeleteMessage = async (id, mid) => {
  try {
    await bot.deleteMessage(id, mid);
  } catch (_) {}
};

const safeSendPhoto = async (id, filePath, opts = {}) => {
  try {
    return await bot.sendPhoto(id, fs.createReadStream(filePath), opts);
  } catch (err) {
    console.error("sendPhoto", err);
    return null;
  }
};
const safeSendVideo = async (id, filePath, opts = {}) => {
  try {
    return await bot.sendVideo(id, filePath, opts);
  } catch (err) {
    console.error("sendVideo", err);
    return null;
  }
};

// ==========================
//  Обработка входящих сообщений
// ==========================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || "";

  if (msg.from.id === ADMIN_ID && msg.text === "mes+") {
    await safeSendMessage(ADMIN_ID, "📣 Рассылка запущена!");

    const users = await User.find(
      { status: { $in: ["mes", "reg"] } }, // dep исключаем
      { telegramId: 1, username: 1, status: 1, link: 1 }
    ).lean();

    for (const u of users) {
      const caption =
        u.status === "mes"
          ? "🔥 Остался один шаг!\nЗарегистрируйтесь сейчас и получите доступ к пошаговой инструкции по заработку."
          : "🚀 Активируйте подписку всего за 1 ₽ и начните получать прибыль уже сегодня!";

      await safeSendPhoto(
        u.telegramId,
        path.join(__dirname, "photo", "2.webp"),
        {
          caption,
          reply_markup: {
            inline_keyboard: [[{ text: "Перейти", url: u.link }]],
          },
        }
      ).catch(() => {}); // игнорируем возможные 403/400

      // лёгкая пауза, чтобы не упереться в лимит 30 msg/сек
      await new Promise((r) => setTimeout(r, 35));
    }

    await safeSendMessage(ADMIN_ID, "✅ Рассылка завершена");
    return;
  }

  // ----------------------
  //  /start <param>
  // ----------------------
  if (text.startsWith("/start")) {
    const [_, rawParam] = text.split(" ");

    // 👉 Берём CID ДО символа «_»
    const baseCid = rawParam ? rawParam.split("_")[0] : "none";

    // Формируем ссылку по условиям
    const sub1 = `&sub1=${userDoc.telegramId}`;
    let generatedLink;
    if (rawParam?.endsWith("_al2")) {
      generatedLink = `https://justonesec.ru/stream/cprumod249ak?cid=${baseCid}${sub1}`;
    } else if (rawParam?.endsWith("_al")) {
      generatedLink = `https://onesecgo.ru/stream/gamesportg?cid=${baseCid}${sub1}`;
    } else {
      generatedLink = `https://onesecgo.ru/stream/8kact?cid=${baseCid}${sub1}`;
    }

    // username fallback
    const username =
      msg.from.username ||
      `${msg.from.first_name || "user"}${msg.from.last_name || ""}`;

    // Создаём/обновляем пользователя
    let userDoc = await User.findOne({ telegramId: chatId });
    if (!userDoc) {
      userDoc = new User({
        telegramId: chatId,
        username,
        click_id: baseCid,
        link: generatedLink,
      });
    } else {
      userDoc.username = username;
      userDoc.click_id = baseCid;
      userDoc.link = generatedLink;
    }
    await userDoc.save();

    // Инициализируем память
    userStates[chatId] = { state: STATES.NONE, reviewIndex: 0 };

    // Приветствие
    const name = msg.from.first_name || msg.from.username || "Друзья";
    await safeSendPhoto(chatId, path.join(__dirname, "photo", "1.webp"), {
      caption:
        `${name}, приветствуем 👋\n\n` +
        `🧠 Ответьте на 3 коротких вопроса, и мы подберём стратегию заработка.\n\n` +
        `✅ Проверенные методики под любой бюджет\n` +
        `💼 Уже сотни людей зарабатывают ежедневно!`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Подобрать стратегию", callback_data: "get_money" }],
        ],
      },
    });
    return;
  }

  // ----------------------
  //  «Отзывы»
  // ----------------------
  if (text === "Отзывы") {
    sendNextReview(chatId);
    return;
  }

  // ----------------------
  //  «Как получить»
  // ----------------------
  if (text === "Как получить") {
    const userDoc = await User.findOne({ telegramId: chatId });
    const finalLink =
      userDoc?.link ||
      `https://onesecgo.ru/stream/8kact?cid=${userDoc?.click_id || "none"}`;

    await safeSendPhoto(chatId, path.join(__dirname, "photo", "2.webp"), {
      caption:
        "📝 Что нужно сделать:\n\n" +
        "1. Нажмите «Перейти» ниже\n" +
        "2. Оплатите 1₽ для активации пакета (5 дней)\n" +
        "3. Следуйте инструкции и зарабатывайте 💸\n\n" +
        "⏳ Важно: доступ ограничен по времени!",
      reply_markup: {
        inline_keyboard: [[{ text: "Перейти", url: finalLink }]],
      },
    });
    return;
  }
});

// ==========================
//  Обработка callback_query
// ==========================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // --- start quiz ---
  if (data === "get_money") {
    await safeDeleteMessage(chatId, query.message.message_id);
    userStates[chatId] = { ...userStates[chatId], state: STATES.Q1 };

    const q = await safeSendMessage(chatId, "Какой у вас телефон?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "iPhone", callback_data: "q1_iphone" },
            { text: "Android", callback_data: "q1_android" },
          ],
        ],
      },
    });
    if (q) userStates[chatId].last = q.message_id;
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  // --- Q1 ---
  if (data.startsWith("q1_") && userStates[chatId]?.state === STATES.Q1) {
    userStates[chatId].phone = data.replace("q1_", "");
    userStates[chatId].state = STATES.Q2;
    if (userStates[chatId].last)
      await safeDeleteMessage(chatId, userStates[chatId].last);

    const q = await safeSendMessage(chatId, "Сколько планируете работать?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "30 мин/день", callback_data: "q2_30" },
            { text: "1 час/день", callback_data: "q2_60" },
          ],
          [
            { text: "3 часа/день", callback_data: "q2_180" },
            { text: "5 часов/день", callback_data: "q2_300" },
          ],
        ],
      },
    });
    if (q) userStates[chatId].last = q.message_id;
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  // --- Q2 ---
  if (data.startsWith("q2_") && userStates[chatId]?.state === STATES.Q2) {
    const map = {
      q2_30: "30 минут",
      q2_60: "1 час",
      q2_180: "3 часа",
      q2_300: "5 часов",
    };
    userStates[chatId].work = map[data];
    userStates[chatId].state = STATES.Q3;
    if (userStates[chatId].last)
      await safeDeleteMessage(chatId, userStates[chatId].last);

    const q = await safeSendMessage(chatId, "Сколько хотите зарабатывать?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "50k", callback_data: "q3_50" },
            { text: "70k", callback_data: "q3_70" },
          ],
          [
            { text: "120k", callback_data: "q3_120" },
            { text: "300k", callback_data: "q3_300" },
          ],
        ],
      },
    });
    if (q) userStates[chatId].last = q.message_id;
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  // --- Q3 ---
  if (data.startsWith("q3_") && userStates[chatId]?.state === STATES.Q3) {
    const map = { q3_50: "50k", q3_70: "70k", q3_120: "120k", q3_300: "300k" };
    userStates[chatId].income = map[data];
    userStates[chatId].state = STATES.NONE;
    if (userStates[chatId].last)
      await safeDeleteMessage(chatId, userStates[chatId].last);

    launchTimer(chatId);
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }
});

// ==========================
//  Таймер (визуальная имитация)
// ==========================
function launchTimer(chatId) {
  const steps = [
    "Анализируем ваш профиль…",
    "Изучаем ответы…",
    "Подбираем стратегию…",
    "Формируем результат…",
    "Готово ✅",
  ];

  let idx = 0;
  let mid = null;

  const next = () => {
    if (mid) safeDeleteMessage(chatId, mid);
    if (idx === steps.length) return sendFinal(chatId);
    safeSendMessage(chatId, steps[idx++]).then((m) => {
      mid = m?.message_id;
      setTimeout(next, 1800);
    });
  };
  next();
}

// ==========================
//  Финал
// ==========================
async function sendFinal(chatId) {
  const userDoc = await User.findOne({ telegramId: chatId });
  const url =
    userDoc?.link ||
    `https://onesecgo.ru/stream/8kact?cid=${userDoc?.click_id || "none"}`;

  await safeSendMessage(
    chatId,
    "🎉 Стратегия готова!\n\n💰 Потенциальный доход: 8000₽/день",
    {
      reply_markup: {
        keyboard: [["Отзывы", "Как получить"]],
        resize_keyboard: true,
      },
    }
  );

  await safeSendPhoto(chatId, path.join(__dirname, "photo", "2.webp"), {
    caption:
      "📝 Ваши шаги:\n1. Нажмите кнопку ниже\n2. Активируйте пакет за 1₽\n3. Следуйте инструкции и получайте прибыль!",
    reply_markup: { inline_keyboard: [[{ text: "Перейти", url }]] },
  });
}

// ==========================
//  Отправка отзывов
// ==========================
async function sendNextReview(chatId) {
  if (!reviewsArray.length) return safeSendMessage(chatId, "Пока нет отзывов");
  const st = (userStates[chatId] ||= { state: STATES.NONE, reviewIndex: 0 });
  const { text, filePath, type } = reviewsArray[st.reviewIndex];
  if (type === "photo")
    await safeSendPhoto(chatId, filePath, { caption: text });
  else await safeSendVideo(chatId, filePath, { caption: text });
  st.reviewIndex = (st.reviewIndex + 1) % reviewsArray.length;
}

console.log("🤖 Bot started...");
