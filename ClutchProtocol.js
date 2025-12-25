import {
  VersionedTransaction,
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

import bs58 from "bs58";

// ================= CONFIG =================
const SOLANA_RPC = "";

// tek variables
const POLL_INTERVAL = 30_000;
const TX_DELAY = 500;
const MAX_RETRIES = 5;
const BACKOFF_BASE = 1000;
const MAX_SIGNATURE_LOOKBACK = 10;
const TOKEN_THRESHOLD = 200_000;
const connection = new Connection(SOLANA_RPC, "confirmed");
const web3Connection = new Connection(SOLANA_RPC, "confirmed");

//keys and api
const dev_pub = '';
const dev_pk = '';

// pumpswap sender account ( used to check last buyer )
const ACCOUNT = new PublicKey(
  ""
);

// Token contract 
const contractCA = new PublicKey(
  ""
);


// ================= HELPERS =================

function getRandomPollInterval() {
  const min = 60_000;   // 1 minute
  const max = 180_000;  // 3 minutes
  return Math.floor(Math.random() * (max - min + 1)) + min;
}


const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTransactionWithRetry(signature) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
    } catch (e) {
      if (e.message?.includes("429") && attempt < MAX_RETRIES) {
        await delay(BACKOFF_BASE * 2 ** attempt);
      } else {
        return null;
      }
    }
  }
  return null;
}

// ================= REAL TOKEN BALANCE =================
// Returns { balance, firstPositiveTimestamp } or null if zero
async function getTokenBalanceWithTime(ownerStr) {
  const owner = new PublicKey(ownerStr);
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

  let totalBalance = 0;
  let holdingStart = null;
  let holdingDurationSec = 0;

  for (const programId of programs) {
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
        programId,
      });

      for (const { pubkey, account } of accounts.value) {
        const info = account.data.parsed.info;
        if (info.mint !== contractCA.toBase58()) continue;

        const decimals = info.tokenAmount.decimals;

        // Current balance
        const currentAmount = Number(info.tokenAmount.amount) / Math.pow(10, decimals);
        totalBalance += currentAmount;

        // Fetch all signatures for this token account (oldest first)
        let allSignatures = [];
        let before = undefined;
        do {
          const sigBatch = await connection.getSignaturesForAddress(pubkey, { limit: 1000, before });
          if (sigBatch.length === 0) break;
          allSignatures = allSignatures.concat(sigBatch);
          before = sigBatch[sigBatch.length - 1].signature;
        } while (allSignatures.length < 5000);

        // Process each transaction in chronological order
        for (const sigInfo of allSignatures.reverse()) {
          try {
            const tx = await connection.getTransaction(sigInfo.signature);
            if (!tx?.meta?.postTokenBalances || !tx.blockTime) continue;

            const balanceInfo = tx.meta.postTokenBalances.find(
              (b) => b.mint === contractCA.toBase58() && b.owner === ownerStr
            );
            if (!balanceInfo) continue;

            const amount = Number(balanceInfo.uiTokenAmount.amount);

            if (amount > 0 && holdingStart === null) {
              // Balance became positive → start counting
              holdingStart = tx.blockTime;
            } else if (amount === 0 && holdingStart !== null) {
              // Balance dropped to 0 → accumulate duration
              holdingDurationSec += tx.blockTime - holdingStart;
              holdingStart = null;
            }
          } catch {}
        }

        // If balance is still positive now, add duration until current time
        if (holdingStart !== null) {
          holdingDurationSec += Math.floor(Date.now() / 1000) - holdingStart;
        }
      }
    } catch {}
  }

  if (totalBalance <= 0) return null;

  return { balance: totalBalance, holdingTimeSec: holdingDurationSec };
}


// ========== LAST VALID SIGNER ==========
async function getValidLastTransaction(signatures) {
  for (const { signature } of signatures) {
    const tx = await fetchTransactionWithRetry(signature);
    if (!tx?.meta || !tx.transaction?.message) continue;

    const keys =
      tx.transaction.message.accountKeys ||
      tx.transaction.message.staticAccountKeys;

    const sigs = tx.transaction.signatures;
    const signerIndex = sigs.findIndex(Boolean);
    if (signerIndex === -1) continue;

    const signerKey = keys[signerIndex];
    const pre = tx.meta.preBalances[signerIndex];
    const post = tx.meta.postBalances[signerIndex];
    const fee = tx.meta.fee || 0;

    const solSent = (pre - post - fee) / 1e9;

    // Only accept transactions sending more than 0.01 SOL
    if (solSent > 0.01) return { signerKey, solSent };
  }
  return null;
}

// ================= CLAIM REWARDS =================
async function ClaimRewards() {
  const response = await fetch(`https://pumpportal.fun/api/trade-local`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: dev_pub,
      action: "collectCreatorFee",
      priorityFee: 0.000001,
    }),
  });

  if (response.status === 200) {
    const data = await response.arrayBuffer();
    const tx = VersionedTransaction.deserialize(new Uint8Array(data));
    const kp = Keypair.fromSecretKey(
      bs58.decode(dev_pk)
    );
    tx.sign([kp]);
    const sig = await web3Connection.sendTransaction(tx);
    console.log("Rewards claimed:", `https://solscan.io/tx/${sig}`);
  }
}

 async function sendSol(signerPubkeyStr) {
    const connection = new Connection(SOLANA_RPC, "confirmed");
   
    // Load sender keypair
    const senderKeypair = Keypair.fromSecretKey(
      bs58.decode(dev_pk)
    );
  
    const receiverPubkey = new PublicKey(signerPubkeyStr);
  
     //Display sender balance
  const senderBalance = await connection.getBalance(senderKeypair.publicKey);
  console.log(
    "Sender SOL Balance:",
    (senderBalance / 1e9).toFixed(4),
    "SOL"
  );

    // Create transfer instruction
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: receiverPubkey,
        lamports: ((senderBalance / 1e9).toFixed(4) * 0.5 ) * 1e9, // SOL → lamports
      })
    );
  
    // Send + confirm
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [senderKeypair]
    );
  
    console.log("Clutch Protocol Rewards Transaction sent!");
  }

  let lastProcessedSigner = null; // Tracks the last qualifying wallet processed


// ================= MAIN LOOP =================
async function processLastSigner() {
  try {
    const signatures = await connection.getSignaturesForAddress(ACCOUNT, {
      limit: MAX_SIGNATURE_LOOKBACK,
    });
    if (!signatures.length) return;

    let latestQualifyingSigner = null;

    // Iterate signatures to find the first wallet meeting the token threshold
    for (const sigInfo of signatures) {
      const result = await getValidLastTransaction([sigInfo]);
      if (!result) continue;

      const signerStr = result.signerKey.toBase58();

      const tokenData = await getTokenBalanceWithTime(signerStr);
      if (!tokenData) continue;

     if (tokenData.balance < TOKEN_THRESHOLD) continue;

      latestQualifyingSigner = signerStr;
      break; // Stop at the first wallet that qualifies
    }

    if (!latestQualifyingSigner) {
      console.log("No qualifying wallets found in this poll.");
      return;
    }

    // Check if the qualifying signer changed since last poll otherwise wait until next poll is ran
    if (latestQualifyingSigner === lastProcessedSigner) {
      console.log("Latest buyer that qualifies has not changed.");
      return;
    }

    // New qualifying signer found
    lastProcessedSigner = latestQualifyingSigner;

    const result = await getValidLastTransaction([
      signatures.find(
        (s) => s.signature === latestQualifyingSigner
      ) || signatures[0],
    ]);

    const solBalance =
      (await connection.getBalance(new PublicKey(latestQualifyingSigner))) / 1e9;

    const tokenData = await getTokenBalanceWithTime(latestQualifyingSigner);
  console.log("────────────────────────────");
    console.log("CLUTCH PROTOCOL WINNER FOUND");
    console.log("Winner Wallet:", latestQualifyingSigner);
   console.log("Winner SOL Balance:", solBalance.toFixed(4));
    console.log(
      `Token Balance Meets Minimum Requirement ( 400,000 ) (${contractCA.toBase58()}):`,
      tokenData.balance
    );
    console.log("────────────────────────────");

    // Claim rewards and send SOL
    await ClaimRewards();
    await sendSol();
  } catch (err) {
    console.error("Watcher error:", err.message || err);
  }
}


// ================= START =================
console.log("Clutch Protocol Utility Started");

(async function startWatcher() {
  while (true) {
    await processLastSigner();
    const nextPoll = getRandomPollInterval();
    console.log(`⏳ Next poll in ${(nextPoll / 1000).toFixed(0)} seconds`);
    await delay(nextPoll);
  }
})();
