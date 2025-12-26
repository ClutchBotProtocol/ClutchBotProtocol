import { VersionedTransaction, Connection, Keypair, sendAndConfirmTransaction, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import fetch from "node-fetch";
import { getAssociatedTokenAddress, createBurnInstruction, TOKEN_2022_PROGRAM_ID, getAccount } from "@solana/spl-token";

// ===== CONFIG =====
const RPC_ENDPOINT = "";
const connection = new Connection(RPC_ENDPOINT, "confirmed");

const DEV_PUB = "";
const DEV_PK = "";

const TOKEN_MINT = new PublicKey("");

const wallet = Keypair.fromSecretKey(bs58.decode(DEV_PK));

// ===== HELPERS =====
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = () => 60_000 + Math.floor(Math.random() * 120_000); // 1–3 minutes in ms

async function getSolBalance() {
  return await connection.getBalance(wallet.publicKey);
}

// ===== BUY FUNCTION =====
async function buyToken() {
  try {
    const balance = await getSolBalance();
    const buyAmountLamports = Math.floor(balance * BUY_PERCENTAGE);

    if (buyAmountLamports <= 0) {
      console.log("⚠️ Wallet balance too low to buy");
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
      console.log("❌ Buy error:", response.statusText);
      return;
    }

    const data = new Uint8Array(await response.arrayBuffer());
    const tx = VersionedTransaction.deserialize(data);
    tx.sign([wallet]);
    const sig = await connection.sendTransaction(tx);
    console.log(`✅ Token bought: https://solscan.io/tx/${sig}`);

    // Delay 1 second before burn
    await delay(1000);

    // Burn the entire token balance
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

    console.log("Token account to burn from:", tokenAccount.toBase58());

    const accountInfo = await getAccount(connection, tokenAccount, "confirmed", TOKEN_2022_PROGRAM_ID);
    const tokenBalance = Number(accountInfo.amount);

    if (tokenBalance === 0) {
      console.log("⚠️ No tokens to burn");
      return;
    }

    console.log(`Burning entire balance: ${tokenBalance} units`);

    const burnIx = createBurnInstruction(
      tokenAccount,
      TOKEN_MINT,
      wallet.publicKey,
      tokenBalance,
      [],
      TOKEN_2022_PROGRAM_ID
    );

    const tx = new Transaction().add(burnIx);
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log(`🔥 Entire token balance burned: https://solscan.io/tx/${sig}`);

  } catch (err) {
    console.error("❌ Burn failed:", err.message || err);
  }
}

// ===== MAIN LOOP =====
(async function startAutoBuy() {
  console.log("🚀 Auto-buy + burn bot started");
  while (true) {
    await buyToken();
    const waitTime = randomDelay();
    console.log(`⏱ Waiting ${Math.floor(waitTime / 1000)} seconds before next cycle...`);
    await delay(waitTime);
  }
})();
