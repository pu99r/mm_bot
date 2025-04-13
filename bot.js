require("dotenv").config(); // Подключаем dotenv
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

// Подключаемся к MongoDB
// Возьмём нужные переменные окружения
const { 
  BOT_TOKEN,
  MONGODB_HOST, 
  MONGODB_PORT, 
  MONGODB_USERNAME, 
  MONGODB_PASSWORD, 
  MONGODB_DBNAME 
} = process.env;

const passwordEncoded = encodeURIComponent(MONGODB_PASSWORD);

// Добавляем &directConnection=true
const mongoUri = `mongodb://${MONGODB_USERNAME}:${passwordEncoded}` +
  `@${MONGODB_HOST}:${MONGODB_PORT}/${MONGODB_DBNAME}?authSource=admin&directConnection=true`;

console.log("BOT_TOKEN:", process.env.BOT_TOKEN);
console.log("MONGODB_HOST:", process.env.MONGODB_HOST);
console.log("MONGODB_USERNAME:", process.env.MONGODB_USERNAME);
console.log("MONGODB_PASSWORD:", process.env.MONGODB_PASSWORD);
console.log("MONGODB_DBNAME:", process.env.MONGODB_DBNAME);

// Добавляем увеличенные таймауты:
mongoose.connect(mongoUri, {
  connectTimeoutMS: 30000,
  socketTimeoutMS: 30000,
})
  .then(() => {
    console.log("Успешное подключение к MongoDB");
  })
  .catch((err) => {
    console.error("Ошибка подключения к MongoDB:", err);
  });

// Определяем схему и модель User
const userSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, required: true }, // ID телеграм пользователя
  username: { type: String, required: true },                // Ник (или имя) в Телеграм
  click_id: { type: String, default: "none" },               // Сюда сохраняем параметр после /start
  complete: { type: [String], default: [] },                 // Можно использовать для отметки шагов
});

const User = mongoose.model("User", userSchema);

// Создаём экземпляр бота
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 100,
    autoStart: true,
    params: {
      timeout: 10,
    },
  },
});

// ---------- Читаем файл с отзывами и формируем массив отзывов ----------
let reviewsLines = [];
try {
  const reviewsData = fs.readFileSync(
    path.join(__dirname, "reviews.txt"),
    "utf-8"
  );

  // Разбиваем на строки, убираем пустые
  reviewsLines = reviewsData
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // Заменяем "\n" внутри строки на настоящие переводы (для многострочных отзывов)
  reviewsLines = reviewsLines.map((line) => line.replace(/\\n/g, "\n"));
} catch (err) {
  console.warn("Не удалось прочитать файл reviews.txt. Продолжаем без отзывов.", err);
}

// Допустимые расширения (фото и видео)
const possibleExtensions = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".mp4",
  ".mov",
  ".webp",
];

// Формируем массив отзывов: [{ text, filePath, type }, ...]
const reviewsArray = [];
for (let i = 0; i < reviewsLines.length; i++) {
  const baseName = String(i + 1);
  let foundFile = null;

  // Ищем файл с любым из разрешённых расширений
  for (const ext of possibleExtensions) {
    const fullPath = path.join(__dirname, "reviews", baseName + ext);
    if (fs.existsSync(fullPath)) {
      foundFile = fullPath;
      break;
    }
  }

  // Если не нашли — пропускаем эту строку
  if (!foundFile) continue;

  // Определяем фото или видео
  const extension = path.extname(foundFile).toLowerCase();
  let fileType = "photo";
  if (extension === ".mp4" || extension === ".mov") {
    fileType = "video";
  }

  reviewsArray.push({
    text: reviewsLines[i],
    filePath: foundFile,
    type: fileType,
  });
}

// ========== 2. Логика вопросов, таймера, финального сообщения ==========
const STATES = {
  NONE: "none",
  Q1: "question1",
  Q2: "question2",
  Q3: "question3",
};

// Для состояния сессии используем объект в памяти (можно перенести в БД при желании)
const userStates = {};

// --------- Безопасные функции отправки/удаления ---------
async function safeSendMessage(chatId, text, options = {}) {
  try {
    const msg = await bot.sendMessage(chatId, text, options);
    return msg;
  } catch (err) {
    handleSendError(chatId, err);
    return null;
  }
}

async function safeDeleteMessage(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (err) {
    // Игнорируем любые ошибки при удалении
  }
}

async function safeSendPhoto(chatId, filePath, options = {}) {
  try {
    const msg = await bot.sendPhoto(chatId, fs.createReadStream(filePath), options);
    return msg;
  } catch (err) {
    handleSendError(chatId, err);
    return null;
  }
}

async function safeSendVideo(chatId, filePath, options = {}) {
  try {
    const msg = await bot.sendVideo(chatId, filePath, options);
    return msg;
  } catch (err) {
    handleSendError(chatId, err);
    return null;
  }
}

// Функция обработки ошибок отправки
function handleSendError(chatId, err) {
  if (err.response && err.response.body && err.response.body.error_code === 403) {
    console.log(`Пользователь с chatId=${chatId} заблокировал бота или недоступен.`);
  } else {
    console.error("Ошибка при отправке сообщения:", err);
  }
}

// ========== Обработка входящих сообщений ==========

// Обрабатываем любые сообщения
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || "";

  // 1) Отлавливаем /start (с параметром или без)
  // Например: /start 451325435
  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    let startParam = null;
    if (parts.length > 1) {
      // То, что идёт после /start
      startParam = parts[1];
    }

    // 2) Создаём/обновляем пользователя в БД
    // Берём username из msg.from.username, если нет — подставим что-то
    const candidateUsername = msg.from.username
      ? msg.from.username
      : (msg.from.first_name || "user") + (msg.from.last_name || "");

    // Ищем и обновляем (либо создаём) юзера
    let userDoc = await User.findOne({ telegramId: chatId });
    if (!userDoc) {
      // Если нет в базе — создаём
      userDoc = new User({
        telegramId: chatId,
        username: candidateUsername,
        click_id: startParam || "none",
      });
      await userDoc.save();
    } else {
      // Если уже есть — обновляем click_id
      userDoc.click_id = startParam || "none";
      // При желании можно обновить username
      userDoc.username = candidateUsername;
      await userDoc.save();
    }

    // 3) Инициализируем/сбрасываем состояние в памяти
    if (!userStates[chatId]) {
      userStates[chatId] = { state: STATES.NONE, reviewIndex: 0 };
    }
    userStates[chatId].refParam = userDoc.click_id; // Сохраним то, что в базе
    userStates[chatId].state = STATES.NONE;
    userStates[chatId].reviewIndex = 0;

    // 4) Отправляем приветствие
    const userName = msg.from.first_name || msg.from.username || "Друзья";
    const finalImagePath = path.join(__dirname, "photo", "1.webp");

    await safeSendPhoto(chatId, finalImagePath, {
      caption:
        `${userName}, приветствуем 👋\n\n` +
        `🧠 Мы подберём для вас стратегию заработка, исходя из ваших ответов.\n` +
        `Ответьте на 3 коротких вопроса — и узнайте, сколько сможете зарабатывать!\n\n` +
        `✅ У нас уже есть готовые проверенные методики под любой бюджет\n` +
        `💼 С нами уже зарабатывают сотни людей ежедневно!`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Подобрать стратегию", callback_data: "get_money" }],
        ],
      },
    });

    return;
  }

  // 2) Кнопка «Отзывы»
  if (text === "Отзывы") {
    sendNextReview(chatId);
    return;
  }

  // 3) Кнопка «Как получить»
  if (text === "Как получить") {
    // Достаём пользователя, чтобы взять актуальный click_id
    const userDoc = await User.findOne({ telegramId: chatId });
    const finalLink = `https://onesecgo.ru/stream/8kact?cid=${
      userDoc?.click_id || "none"
    }`;

    const finalImagePath = path.join(__dirname, "photo", "2.webp");
    await safeSendPhoto(chatId, finalImagePath, {
      caption:
        "📝 Что нужно сделать:\n\n" +
        "1. Перейдите на сайт: ПЕРЕЙТИ по кнопке ниже\n" +
        "2. Оплатите 1₽ для активации пакета по заработку на 5дн\n" +
        "3. Следуйте инструкции и зарабатывайте 💸\n\n" +
        "⏳ Важно: доступ ограничен по времени!",
      reply_markup: {
        inline_keyboard: [[{ text: "Перейти", url: finalLink }]],
      },
    });
    return;
  }
});

// ========== Обработка нажатий инлайн-кнопок ==========
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // --- Нажали «Подобрать стратегию» ---
  if (data === "get_money") {
    // Удаляем приветственное сообщение
    await safeDeleteMessage(chatId, query.message.message_id);

    // Начинаем опрос
    if (!userStates[chatId]) {
      userStates[chatId] = {};
    }
    userStates[chatId].state = STATES.Q1;
    userStates[chatId].reviewIndex = userStates[chatId].reviewIndex || 0;

    // Задаём первый вопрос
    const qMsg = await safeSendMessage(chatId, "Какой у вас телефон?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Iphone", callback_data: "q1_Iphone" },
            { text: "Android", callback_data: "q1_Android" },
          ],
        ],
      },
    });

    // Сохраняем id отправленного сообщения, чтобы потом удалить
    if (qMsg && qMsg.message_id) {
      userStates[chatId].lastQuestionMsgId = qMsg.message_id;
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  // --- Вопрос 1 (Q1) ---
  if (data.startsWith("q1_") && userStates[chatId]?.state === STATES.Q1) {
    userStates[chatId].phone = data.replace("q1_", "");
    userStates[chatId].state = STATES.Q2;

    // Удаляем предыдущий вопрос
    if (userStates[chatId].lastQuestionMsgId) {
      await safeDeleteMessage(chatId, userStates[chatId].lastQuestionMsgId);
    }

    // Задаём второй вопрос
    const qMsg = await safeSendMessage(chatId, "Сколько планируете работать?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "30 минут в день", callback_data: "q2_30min" },
            { text: "1 час в день", callback_data: "q2_1h" },
          ],
          [
            { text: "3 часа в день", callback_data: "q2_3h" },
            { text: "5 часов в день", callback_data: "q2_5h" },
          ],
        ],
      },
    });
    if (qMsg && qMsg.message_id) {
      userStates[chatId].lastQuestionMsgId = qMsg.message_id;
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  // --- Вопрос 2 (Q2) ---
  if (data.startsWith("q2_") && userStates[chatId]?.state === STATES.Q2) {
    const mapping = {
      q2_30min: "30 минут в день",
      q2_1h: "1 час в день",
      q2_3h: "3 часа в день",
      q2_5h: "5 часов в день",
    };
    userStates[chatId].workTime = mapping[data];
    userStates[chatId].state = STATES.Q3;

    // Удаляем предыдущий вопрос
    if (userStates[chatId].lastQuestionMsgId) {
      await safeDeleteMessage(chatId, userStates[chatId].lastQuestionMsgId);
    }

    // Третий вопрос
    const qMsg = await safeSendMessage(chatId, "Сколько хотите зарабатывать?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "50 т.р. в месяц", callback_data: "q3_50k" },
            { text: "70 т.р. в месяц", callback_data: "q3_70k" },
          ],
          [
            { text: "120 т.р. в месяц", callback_data: "q3_120k" },
            { text: "300 т.р. в месяц", callback_data: "q3_300k" },
          ],
        ],
      },
    });
    if (qMsg && qMsg.message_id) {
      userStates[chatId].lastQuestionMsgId = qMsg.message_id;
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  // --- Вопрос 3 (Q3) ---
  if (data.startsWith("q3_") && userStates[chatId]?.state === STATES.Q3) {
    const mapping = {
      q3_50k: "50 т.р. в месяц",
      q3_70k: "70 т.р. в месяц",
      q3_120k: "120 т.р. в месяц",
      q3_300k: "300 т.р. в месяц",
    };
    userStates[chatId].income = mapping[data];
    userStates[chatId].state = STATES.NONE;

    // Удаляем предыдущий вопрос
    if (userStates[chatId].lastQuestionMsgId) {
      await safeDeleteMessage(chatId, userStates[chatId].lastQuestionMsgId);
    }

    // Запускаем «таймер»
    startTimerSequence(chatId);

    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }
});

// ========== «Таймер» (имитация вычислений) ==========
function startTimerSequence(chatId) {
  const messages = [
    "Анализируем ваш профиль…",
    "Изучаем ваши ответы…",
    "Ищем подходящую стратегию…",
    "Идёт подбор индивидуального решения…",
    "Сверяем с актуальными возможностями…",
    "Формируем персональный результат…",
    "Готово ✅",
  ];

  let index = 0;
  let lastMessageId = null;

  function showNextMessage() {
    // Удаляем предыдущее "промежуточное" сообщение
    if (lastMessageId) {
      safeDeleteMessage(chatId, lastMessageId);
    }

    if (index >= messages.length) {
      // Все этапы таймера пройдены
      // Отправляем финальное сообщение
      sendFinalMessages(chatId).catch((err) =>
        console.error("Ошибка в sendFinalMessages:", err)
      );
      return;
    }

    safeSendMessage(chatId, messages[index]).then((sentMsg) => {
      if (sentMsg) {
        lastMessageId = sentMsg.message_id;
      }
      index++;
      setTimeout(showNextMessage, 2000);
    });
  }

  showNextMessage();
}

// Отдельная функция отправки финальных сообщений
async function sendFinalMessages(chatId) {
  // Достаём пользователя из базы, чтобы взять актуальный click_id
  const userDoc = await User.findOne({ telegramId: chatId });

  const finalLink = `https://onesecgo.ru/stream/8kact?cid=${
    userDoc?.click_id || "none"
  }`;

  await safeSendMessage(
    chatId,
    "🎉 Отлично! Мы подобрали для вас подходящую стратегию.\n\n" +
      "💰 Потенциальный доход: 8000₽ в день",
    {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [["Отзывы", "Как получить"]],
        resize_keyboard: true,
      },
    }
  );

  const finalImagePath = path.join(__dirname, "photo", "2.webp");
  await safeSendPhoto(chatId, finalImagePath, {
    caption:
      "📝 Что нужно сделать:\n\n" +
      "1. Перейдите на сайт: ПЕРЕЙТИ по кнопке ниже\n" +
      "2. Оплатите 1₽ для активации пакета по заработку на 5дн\n" +
      "3. Следуйте инструкции и зарабатывайте 💸\n\n" +
      "⏳ Важно: доступ ограничен по времени!",
    reply_markup: {
      inline_keyboard: [[{ text: "Перейти", url: finalLink }]],
    },
  });
}

// ========== Функция отправки следующих отзывов (циклично) ==========
async function sendNextReview(chatId) {
  if (!reviewsArray.length) {
    await safeSendMessage(chatId, "Пока нет отзывов");
    return;
  }

  // Инициализируем
  if (!userStates[chatId]) {
    userStates[chatId] = { state: STATES.NONE, reviewIndex: 0 };
  }

  if (typeof userStates[chatId].reviewIndex !== "number") {
    userStates[chatId].reviewIndex = 0;
  }

  const { text, filePath, type } =
    reviewsArray[userStates[chatId].reviewIndex];

  if (type === "photo") {
    await safeSendPhoto(chatId, filePath, { caption: text });
  } else {
    // video
    await safeSendVideo(chatId, filePath, { caption: text });
  }

  userStates[chatId].reviewIndex += 1;
  if (userStates[chatId].reviewIndex >= reviewsArray.length) {
    userStates[chatId].reviewIndex = 0;
  }
}

console.log("Бот запущен...");