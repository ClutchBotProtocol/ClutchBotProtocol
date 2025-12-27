import {
  VersionedTransaction,
  Connection,
  Keypair,
  sendAndConfirmTransaction,
  PublicKey,
  Transaction
} from "@solana/web3.js";

import bs58 from "bs58";
import fetch from "node-fetch";
import {
  getAssociatedTokenAddress,
  createBurnInstruction,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getMint
} from "@solana/spl-token";

import axios from "axios";

// ===== CONFIG =====
const RPC_ENDPOINT = "";
const connection = new Connection(RPC_ENDPOINT, "confirmed");

const DEV_PUB = "";
const DEV_PK = "";

const TOKEN_MINT = new PublicKey("");
const BUY_PERCENTAGE = 0.02; // 2% of SOL balance

const MIN_5M_VOLUME = 500; // USD

const TELEGRAM_BOT_TOKEN = "";
const TELEGRAM_CHANNEL = -1003572238909;

const wallet = Keypair.fromSecretKey(bs58.decode(DEV_PK));

// ===== HELPERS =====
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = () => 150_000 + Math.floor(Math.random() * 450_000); // 1–3 minutes

async function getSolBalance() {
  return await connection.getBalance(wallet.publicKey);
}

// ===== VOLUME CHECK (DexScreener) =====
async function get5MinVolumeUSD() {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT.toBase58()}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.pairs || data.pairs.length === 0) return 0;

    let totalVolume = 0;

    for (const pair of data.pairs) {
      if (pair.chainId !== "solana") continue;
      if (!pair.volume?.m5) continue;
      totalVolume += Number(pair.volume.m5);
    }

    return totalVolume;
  } catch (err) {
    console.error("❌ Volume fetch error:", err.message || err);
    return 0;
  }
}

// ===== TELEGRAM ALERT =====
async function sendTelegramAlert(tokenAmount, txHash) {
  try {
    const message =
      `🔥 New $CLUTCH Burn!\n` +
      `Amount: ${tokenAmount} tokens\n\n` +
      `🔗 https://solscan.io/tx/${txHash}`;

    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHANNEL,
        text: message
      }
    );

    console.log("✅ Telegram alert sent");
  } catch (err) {
    console.error("❌ Telegram alert failed:", err.response?.data || err.message);
  }
}

// ===== BUY FUNCTION =====
async function buyToken() {
  try {
    const balance = await getSolBalance();
    const buyAmountLamports = Math.floor(balance * BUY_PERCENTAGE);

    if (buyAmountLamports <= 0) {
      console.log("⚠️ Wallet balance too low");
      return;
    }

    const response = await fetch(`https://pumpportal.fun/api/trade-local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: DEV_PUB,
        action: "buy",
        mint: TOKEN_MINT.toBase58(),
        denominatedInSol: "true",
        amount: buyAmountLamports / 1e9,
        slippage: 10,
        priorityFee: 0.00001,
        pool: "auto"
      })
    });

    if (response.status !== 200) {
      console.log("❌ Buy failed:", response.statusText);
      return;
    }

    const data = new Uint8Array(await response.arrayBuffer());
    const tx = VersionedTransaction.deserialize(data);
    tx.sign([wallet]);

    const sig = await connection.sendTransaction(tx);
    console.log(`✅ Bought token: https://solscan.io/tx/${sig}`);

    await delay(1000);
    await burnToken();

  } catch (err) {
    console.error("❌ Buy error:", err.message || err);
  }
}

// ===== BURN FUNCTION =====
async function burnToken() {
  try {
    const tokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const accountInfo = await getAccount(
      connection,
      tokenAccount,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    const rawAmount = Number(accountInfo.amount);
    if (rawAmount === 0) {
      console.log("⚠️ No tokens to burn");
      return;
    }

    const mintInfo = await getMint(
      connection,
      TOKEN_MINT,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    const decimals = mintInfo.decimals;
    const humanAmount = rawAmount / (10 ** decimals);

    console.log(`🔥 Burning ${humanAmount.toFixed(decimals)} tokens`);

    const burnIx = createBurnInstruction(
      tokenAccount,
      TOKEN_MINT,
      wallet.publicKey,
      rawAmount,
      [],
      TOKEN_2022_PROGRAM_ID
    );

    const tx = new Transaction().add(burnIx);
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);

    console.log(`🔥 Burn complete: https://solscan.io/tx/${sig}`);
    await sendTelegramAlert(humanAmount.toFixed(decimals), sig);

  } catch (err) {
    console.error("❌ Burn failed:", err.message || err);
  }
}

// ===== MAIN LOOP =====
(async function startAutoBuy() {
  console.log("🚀 Auto-buy + burn bot started");

  while (true) {
    const volume5m = await get5MinVolumeUSD();
    console.log(`📊 5m Volume: $${volume5m.toFixed(2)}`);

    if (volume5m > MIN_5M_VOLUME) {
      console.log("✅ Volume threshold met — buying");
      await buyToken();
    } else {
      console.log("⏭ Volume too low — skipping buy");
    }

    const waitTime = randomDelay();
    console.log(`⏱ Waiting ${Math.floor(waitTime / 1000)} seconds...\n`);
    await delay(waitTime);
  }
})();
