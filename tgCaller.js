import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";

// ===== CONFIG =====
const TELEGRAM_BOT_TOKEN = "";

const TELEGRAM_CHANNEL_ID = "@ClutchProtocol";

const SOLANA_RPC = "";

const WATCHED_WALLET =
  "";

const EXCLUDED_ADDRESS =
  "";

const CHECK_INTERVAL_MS = 15_000;
// ==================

const connection = new Connection(SOLANA_RPC, "confirmed");
const walletPubkey = new PublicKey(WATCHED_WALLET);

let lastSeenBlockTime = 0;
let isRunning = false;

/* ---------------- TELEGRAM ---------------- */

async function sendTelegramMessage(text) {
  await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHANNEL_ID,
        text,
        disable_web_page_preview: true,
      }),
    }
  );
}

/* -------- ACCOUNT KEY RESOLUTION (ALT SAFE) -------- */

async function resolveAccountKeys(tx) {
  const message = tx.transaction.message;

  // Legacy tx
  if (!("addressTableLookups" in message)) {
    return message.accountKeys.map(k => k.toBase58());
  }

  // v0 without ALTs
  if (message.addressTableLookups.length === 0) {
    return message.staticAccountKeys.map(k => k.toBase58());
  }

  // v0 with ALTs
  const lookupAccounts = await Promise.all(
    message.addressTableLookups.map(async (lookup) => {
      const res = await connection.getAddressLookupTable(
        lookup.accountKey
      );
      return res.value;
    })
  );

  const accountKeys = message.getAccountKeys({
    addressLookupTableAccounts: lookupAccounts,
  });

  return accountKeys.keySegments().flat().map(k => k.toBase58());
}

/* -------- INITIALIZE TIMESTAMP (CRITICAL) -------- */

async function initLastSeenBlockTime() {
  const sigs = await connection.getSignaturesForAddress(walletPubkey, {
    limit: 1,
  });

  if (sigs.length && sigs[0].blockTime) {
    lastSeenBlockTime = sigs[0].blockTime;
    console.log("Initialized lastSeenBlockTime:", lastSeenBlockTime);
  }
}

/* ---------------- MAIN SCANNER ---------------- */

async function checkTransfers() {
  if (isRunning) return;
  isRunning = true;

  try {
    const signatures = await connection.getSignaturesForAddress(
      walletPubkey,
      { limit: 15 }
    );

    if (!signatures.length) return;

    // Oldest → Newest (important for timestamps)
    const ordered = signatures
      .filter(s => s.blockTime)
      .sort((a, b) => a.blockTime - b.blockTime);

    for (const sig of ordered) {
      // 🚫 Ignore old or equal timestamps
      if (sig.blockTime <= lastSeenBlockTime) continue;

      const tx = await connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx?.meta?.preBalances || !tx?.meta?.postBalances) continue;

      const accountKeys = await resolveAccountKeys(tx);
      const sender = accountKeys[0];

      // Only OUTGOING transfers
      if (sender !== WATCHED_WALLET) continue;

      for (let i = 0; i < tx.meta.postBalances.length; i++) {
        if (tx.meta.postBalances[i] > tx.meta.preBalances[i]) {
          const receiver = accountKeys[i];
        
          if (receiver === WATCHED_WALLET) continue;

          await sendTelegramMessage(
`🏆 A new buyer just came in Clutch! Winner Found!

👛 Address:
${receiver}

🕒 Time:
${new Date(sig.blockTime * 1000).toUTCString()}

🔗 Solscan:
https://solscan.io/tx/${sig.signature}`
          );

          break;
        }
      }

      // ✅ Move the watermark forward
      lastSeenBlockTime = sig.blockTime;
    }
  } catch (err) {
    console.error("Error checking transfers:", err.message);
  } finally {
    isRunning = false;
  }
}

/* ---------------- START BOT ---------------- */

(async () => {
  await initLastSeenBlockTime();
  console.log("🚀 Solana Telegram bot started...");
  setInterval(checkTransfers, CHECK_INTERVAL_MS);
})();
