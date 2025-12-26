import fs from "fs";
import path from "path";
import bs58 from "bs58";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

/* ================= CONFIG ================= */

const SOLANA_RPC =
  "";

const USERS_FILE = path.resolve("./users.json");

const MIN_POLL = 60_000;
const MAX_POLL = 180_000;

const MAX_SIGNATURE_LOOKBACK = 15;
const TOKEN_THRESHOLD = 200_000;

const connection = new Connection(SOLANA_RPC, "confirmed");

/* ================= UTILS ================= */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function randomPollInterval() {
  return Math.floor(Math.random() * (MAX_POLL - MIN_POLL + 1)) + MIN_POLL;
}

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")).users || [];
  } catch {
    return [];
  }
}

/* ================= DEDUPE ================= */

const processed = new Map(); // tokenCA:buyer → timestamp

/* ================= BUYER DETECTION ================= */

async function getLatestBuyer(lpAddress, tokenCA) {
  const lpStr = lpAddress.toString();

  const sigs = await connection.getSignaturesForAddress(
    new PublicKey(lpAddress),
    { limit: MAX_SIGNATURE_LOOKBACK }
  );

  for (const sig of sigs) {
    const tx = await connection.getTransaction(sig.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx?.meta) continue;

    const pre = tx.meta.preTokenBalances || [];
    const post = tx.meta.postTokenBalances || [];

    for (const postBal of post) {
      if (postBal.mint !== tokenCA) continue;

      // ❌ EXCLUDE LP ITSELF
      if (postBal.owner === lpStr) continue;

      const preBal = pre.find(
        (p) =>
          p.mint === tokenCA &&
          p.owner === postBal.owner
      );

      const preAmt = preBal
        ? Number(preBal.uiTokenAmount.amount)
        : 0;

      const postAmt = Number(postBal.uiTokenAmount.amount);

      // ✅ REAL BUYER FOUND
      if (postAmt > preAmt) {
        return postBal.owner;
      }
    }
  }

  return null;
}

/* ================= TOKEN BALANCE ================= */

async function getTokenBalance(ownerStr, tokenCA) {
  let total = 0;
  const owner = new PublicKey(ownerStr);

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const accts = await connection.getParsedTokenAccountsByOwner(owner, {
        programId,
      });

      for (const a of accts.value) {
        const info = a.account.data.parsed.info;
        if (info.mint !== tokenCA) continue;

        total +=
          Number(info.tokenAmount.amount) /
          Math.pow(10, info.tokenAmount.decimals);
      }
    } catch {}
  }

  return total;
}

/* ================= ACTIONS ================= */

async function claimRewards(devPub, devPk) {
  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: devPub,
      action: "collectCreatorFee",
      priorityFee: 0.000001,
    }),
  });

  if (res.status !== 200) return;

  const tx = VersionedTransaction.deserialize(
    new Uint8Array(await res.arrayBuffer())
  );

  const kp = Keypair.fromSecretKey(bs58.decode(devPk));
  tx.sign([kp]);

  await connection.sendTransaction(tx);
}

async function sendSol(devPk, receiver) {
  const sender = Keypair.fromSecretKey(bs58.decode(devPk));
  const bal = await connection.getBalance(sender.publicKey);

  if (bal < 0.01 * 1e9) return;

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: sender.publicKey,
      toPubkey: new PublicKey(receiver),
      lamports: Math.floor(bal * 0.5),
    })
  );

  await sendAndConfirmTransaction(connection, tx, [sender]);
}

/* ================= USER PIPELINE ================= */

async function processUser(user) {
  if (!user.active) return;

  const { publicKey, privateKey, tokenCA, lpAddress } = user;

  console.log("👤 Checking token:", tokenCA);

  const buyer = await getLatestBuyer(lpAddress, tokenCA);
  if (!buyer) return;

  const key = `${tokenCA}:${buyer}`;
  if (processed.has(key)) return;

  const balance = await getTokenBalance(buyer, tokenCA);
  if (balance < TOKEN_THRESHOLD) return;

  processed.set(key, Date.now());

  console.log("🏆 WINNER FOUND");
  console.log("Token:", tokenCA);
  console.log("Buyer:", buyer);
  console.log("Balance:", balance);

  await claimRewards(publicKey, privateKey);
  await delay(2000);
  await sendSol(privateKey, buyer);
}

/* ================= MAIN LOOP ================= */

export async function startWatcher() {
  console.log("🚀 Clutch Protocol Watcher Started");

  while (true) {
    const users = loadUsers();

    await Promise.allSettled(
      users.map((u) => processUser(u))
    );

    const wait = randomPollInterval();
    console.log(`⏳ Poll complete. Next poll in ${wait / 1000}s`);
    await delay(wait);
  }
}
