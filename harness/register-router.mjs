// register-router.mjs — owner registers the real USDC/SOL tier pools into the
// RomeDexRouter and records the deployment in harness/router.json.
// Usage: ROUTER=0x… HADRIAN_PRIVATE_KEY=… node register-router.mjs
import fs from "node:fs";
import { ethers } from "ethers";
import { EVM_RPC, CHAIN_ID, PK, b32, resolveGas, evmRpc } from "./lib.mjs";

const ROUTER = process.env.ROUTER;
const KEY = process.env.HADRIAN_PRIVATE_KEY;
if (!ROUTER || !KEY) { console.error("ROUTER + HADRIAN_PRIVATE_KEY required"); process.exit(1); }

// Register EVERY pool across ALL pairs (multi-pair). Falls back to the single-
// pair file if the assembled multi-pair file is absent.
const poolsUrl = fs.existsSync(new URL("./pools-real-pairs.json", import.meta.url))
  ? new URL("./pools-real-pairs.json", import.meta.url)
  : new URL("./pools-real-tiers.json", import.meta.url);
const pools = JSON.parse(fs.readFileSync(poolsUrl));
const IFACE = new ethers.Interface([
  "function registerPool(bytes32 id, bytes32[8] accts)",
  "function pools(bytes32) view returns (bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)",
]);
const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
const wallet = new ethers.Wallet(KEY.trim(), provider);

for (const p of pools) {
  const id = b32(PK(p.swapState));
  const existing = await provider.call({ to: ROUTER, data: IFACE.encodeFunctionData("pools", [id]) });
  if (existing.slice(2, 66) === id.slice(2)) { console.log(`${p.tier}: already registered`); continue; }
  const data = IFACE.encodeFunctionData("registerPool", [id,
    [id, b32(PK(p.authority)), b32(PK(p.vaultA)), b32(PK(p.vaultB)),
     b32(PK(p.poolMint)), b32(PK(p.feeAccount)), b32(PK(p.mintA)), b32(PK(p.mintB))]]);
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const g = await resolveGas({ from: wallet.address, to: ROUTER, data });
  const signed = await wallet.signTransaction({ type: 2, chainId: CHAIN_ID, nonce, ...g, to: ROUTER, value: 0n, data });
  const r = await evmRpc("eth_sendRawTransaction", [signed]);
  if (r.error) { console.error(`${p.tier}: FAILED ${JSON.stringify(r.error).slice(0, 200)}`); process.exit(1); }
  await provider.waitForTransaction(r.result, 1, 120000).catch(() => null);
  console.log(`${p.tier}: registered (${r.result.slice(0, 14)}…)`);
}

fs.writeFileSync(new URL("./router.json", import.meta.url),
  JSON.stringify({ address: ROUTER, dexProgram: pools[0].program, registered: pools.map((p) => ({ pairId: p.pairId, tier: p.tier, swapState: p.swapState })) }, null, 2) + "\n");
console.log("wrote harness/router.json");
