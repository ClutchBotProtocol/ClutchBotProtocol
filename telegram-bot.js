import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";

// ================= CONFIG =================
const BOT_TOKEN = "";
const USERS_FILE = "./users.json";

// Public channel username (bot must be admin)
const PUBLIC_CHANNEL = "@ClutchProtocolTokens";

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ================= STORAGE =================
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
  }
  const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
  return raw ? JSON.parse(raw) : { users: [] };
}

function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// ================= STATE =================
const userState = {};

// ================= UI HELPERS =================
function getStatusButton(publicKey) {
  const data = loadUsers();
  const tokens = data.users.filter(u => u.publicKey === publicKey);

  if (!tokens.length) {
    return { text: "⚠️ Not registered", callback_data: "noop" };
  }

  const active = tokens.some(t => t.active === true);

  return active
    ? { text: "✅ Active", callback_data: "toggle" }
    : { text: "🔴 Inactive", callback_data: "toggle" };
}

function mainMenu(publicKey = null) {
  let statusBtn = { text: "⏸ Status (login first)", callback_data: "noop" };

  if (publicKey) {
    statusBtn = getStatusButton(publicKey);
  }

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚀 Register", callback_data: "register" }],
        [{ text: "🗑 Delete Token", callback_data: "delete" }],
        [statusBtn],
      ],
    },
  };
}

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    "👋 *Welcome to Clutch Protocol Signup Bot*\n\nRegister your token watcher below:",
    { parse_mode: "Markdown", ...mainMenu() }
  );
});

// ================= BUTTON HANDLER =================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  if (query.data === "register") {
    userState[userId] = { step: "register_pk" };
    return bot.sendMessage(chatId, "🔑 Send your *developer private key*:", {
      parse_mode: "Markdown",
    });
  }

  if (query.data === "delete") {
    userState[userId] = { step: "delete_pk" };
    return bot.sendMessage(chatId, "🗑 Send your *developer private key* to delete:", {
      parse_mode: "Markdown",
    });
  }

  if (query.data === "toggle") {
    userState[userId] = { step: "toggle_pk" };
    return bot.sendMessage(chatId, "⏸ Send your *developer private key* to toggle status:", {
      parse_mode: "Markdown",
    });
  }
});

// ================= MESSAGE HANDLER =================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text?.trim();

  if (!userState[userId]) return;

  const state = userState[userId];
  const usersData = loadUsers();

  // ---------- REGISTER: PRIVATE KEY ----------
  if (state.step === "register_pk") {
    let kp;
    try {
      kp = Keypair.fromSecretKey(bs58.decode(text));
    } catch {
      return bot.sendMessage(chatId, "❌ Invalid private key.");
    }

    state.privateKey = text;
    state.publicKey = kp.publicKey.toBase58();
    state.step = "register_token";

    return bot.sendMessage(chatId, "🪙 Send your *token contract address*:", {
      parse_mode: "Markdown",
    });
  }

  // ---------- REGISTER: TOKEN CA ----------
  if (state.step === "register_token") {
    try {
      new PublicKey(text);
    } catch {
      return bot.sendMessage(chatId, "❌ Invalid token contract address.");
    }

    state.tokenCA = text;
    state.step = "register_lp";

    return bot.sendMessage(chatId, "💧 Send your *LP address* (pair / pool):", {
      parse_mode: "Markdown",
    });
  }

  // ---------- REGISTER: LP ADDRESS ----------
  if (state.step === "register_lp") {
    try {
      new PublicKey(text);
    } catch {
      return bot.sendMessage(chatId, "❌ Invalid LP address.");
    }

    const newEntry = {
      publicKey: state.publicKey,
      privateKey: state.privateKey,
      tokenCA: state.tokenCA,
      lpAddress: text,
      active: true,
    };

    usersData.users.push(newEntry);
    saveUsers(usersData);
    delete userState[userId];

    // 🔔 POST TO PUBLIC CHANNEL
    try {
      await bot.sendMessage(
        PUBLIC_CHANNEL,
        `🚀 *New token registered to use Clutch Protocol*\n\n📄 Contract Address:\n\`${state.tokenCA}\``,
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      console.error("Channel post failed:", e.message);
    }

    return bot.sendMessage(
      chatId,
      "✅ *Token & LP registered successfully!*",
      { parse_mode: "Markdown", ...mainMenu(state.publicKey) }
    );
  }

  // ---------- DELETE ----------
  if (state.step === "delete_pk") {
    let kp;
    try {
      kp = Keypair.fromSecretKey(bs58.decode(text));
    } catch {
      return bot.sendMessage(chatId, "❌ Invalid private key.");
    }

    const pub = kp.publicKey.toBase58();
    const before = usersData.users.length;

    usersData.users = usersData.users.filter(u => u.publicKey !== pub);
    saveUsers(usersData);
    delete userState[userId];

    if (before === usersData.users.length) {
      return bot.sendMessage(chatId, "⚠️ No entries found.");
    }

    return bot.sendMessage(
      chatId,
      "🗑 *All tokens deleted for this key.*",
      { parse_mode: "Markdown", ...mainMenu() }
    );
  }

  // ---------- TOGGLE ----------
  if (state.step === "toggle_pk") {
    let kp;
    try {
      kp = Keypair.fromSecretKey(bs58.decode(text));
    } catch {
      return bot.sendMessage(chatId, "❌ Invalid private key.");
    }

    const pub = kp.publicKey.toBase58();
    let toggled = false;

    for (const u of usersData.users) {
      if (u.publicKey === pub) {
        u.active = !u.active;
        toggled = true;
      }
    }

    saveUsers(usersData);
    delete userState[userId];

    if (!toggled) {
      return bot.sendMessage(chatId, "⚠️ No tokens found.");
    }

    return bot.sendMessage(
      chatId,
      "🔄 *Status updated*",
      { parse_mode: "Markdown", ...mainMenu(pub) }
    );
  }
});

console.log("🤖 Clutch Protocol Telegram Bot running");
