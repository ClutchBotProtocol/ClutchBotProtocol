

import "./telegram-bot.js";        // Starts Telegram bot
import { startWatcher } from "./watcher.js"; // Starts watcher

async function start() {
  try {
    console.log("🔧 Starting Clutch Protocol services...");
    await startWatcher(); // blocking async loop
  } catch (err) {
    console.error("❌ Fatal startup error:", err);
    process.exit(1);
  }
}

start();
