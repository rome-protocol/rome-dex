// fund-wallet.mjs — fund an operator's own wallet for a hands-on rome-dex test.
//
// On Rome an EVM user's SPL tokens live in their external_auth PDA's ATA (the
// router pulls from there via delegate), and gas is the native balance of the
// EVM address itself. This funds both:
//   • EVM lane  — sends gas (native) to <evmAddr>, then mints test wUSDC into
//     evmPdaFor(evmAddr)'s wUSDC ATA (Solana deployer = mint authority).
//   • Solana lane (optional) — mints wUSDC into <solPubkey>'s own wUSDC ATA
//     and airdrops a little SOL for rent/fees if the validator allows.
//
// Usage (key inline, never echoed):
//   HADRIAN_PRIVATE_KEY=<your-funded-devnet-key> \
//   node fund-wallet.mjs <evmAddr0x> [solPubkey]
import fs from "node:fs";
import { ethers } from "ethers";
import { PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { conn, EVM_RPC, CHAIN_ID, PK, payer, evmPdaFor, bal, resolveGas } from "./lib.mjs";

const evmAddr = process.argv[2];
const solPubkey = process.argv[3];
const KEY = process.env.HADRIAN_PRIVATE_KEY;
if (!evmAddr || !/^0x[0-9a-fA-F]{40}$/.test(evmAddr)) { console.error("usage: node fund-wallet.mjs <evmAddr0x> [solPubkey]"); process.exit(1); }
if (!KEY) { console.error("HADRIAN_PRIVATE_KEY required (for EVM gas transfer)"); process.exit(1); }

const pools = JSON.parse(fs.readFileSync(new URL("./pools-real-tiers.json", import.meta.url)));
const USDC = pools[0].mintA; // wUSDC SPL mint (6 decimals)
const GAS_WEI = ethers.parseEther("0.05");          // plenty for many txs on Rome
const USDC_AMT = 5_000_000_000n;                    // 5,000 USDC (6dp)

console.log(`funding EVM wallet ${evmAddr}`);
// 1) EVM gas
const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
const w = new ethers.Wallet(KEY.trim(), provider);
const have = await provider.getBalance(evmAddr);
if (have < GAS_WEI) {
  const nonce = await provider.getTransactionCount(w.address, "pending");
  const g = await resolveGas({ from: w.address, to: evmAddr, data: "0x" });
  const tx = await w.sendTransaction({ to: evmAddr, value: GAS_WEI, type: 2, nonce, maxFeePerGas: g.maxFeePerGas, maxPriorityFeePerGas: g.maxPriorityFeePerGas, gasLimit: 30_000_000n });
  await tx.wait(1);
  console.log(`  gas: sent ${ethers.formatEther(GAS_WEI)} (tx ${tx.hash.slice(0, 14)}…)`);
} else {
  console.log(`  gas: already funded (${ethers.formatEther(have)})`);
}
// 2) wUSDC into the EVM user's external_auth PDA ATA
const pda = evmPdaFor(evmAddr);
const pdaAta = (await getOrCreateAssociatedTokenAccount(conn, payer, PK(USDC), pda, true)).address;
await mintTo(conn, payer, PK(USDC), pdaAta, payer, USDC_AMT);
console.log(`  wUSDC: minted 5,000 → PDA ATA ${pdaAta.toBase58().slice(0, 10)}… (pda ${pda.toBase58().slice(0, 10)}…) · bal ${await bal(pdaAta)}`);

// 3) optional Solana lane
if (solPubkey) {
  const owner = new PublicKey(solPubkey);
  const ata = (await getOrCreateAssociatedTokenAccount(conn, payer, PK(USDC), owner, false)).address;
  await mintTo(conn, payer, PK(USDC), ata, payer, USDC_AMT);
  console.log(`Solana wallet ${solPubkey}: minted 5,000 wUSDC → ${ata.toBase58().slice(0, 10)}…`);
  console.log("  (fund SOL for rent/fees from your funded CLI keypair or Phantom if needed)");
}
console.log("done — wallet ready for a rome-dex test.");
