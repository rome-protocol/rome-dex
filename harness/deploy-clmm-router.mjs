// deploy-clmm-router.mjs — deploy RomeClmmRouter, register the proof pool, record
// to clmm-router.json. Usage: HADRIAN_PRIVATE_KEY=… node deploy-clmm-router.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { EVM_RPC, CHAIN_ID, PK, b32 } from "./lib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.HADRIAN_PRIVATE_KEY;
if (!KEY) { console.error("HADRIAN_PRIVATE_KEY required"); process.exit(1); }

const C = JSON.parse(fs.readFileSync(path.join(DIR, "clmm.json"), "utf8"));
const art = JSON.parse(fs.readFileSync(path.join(DIR, "../contracts/out/RomeClmmRouter.sol/RomeClmmRouter.json"), "utf8"));
const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
const wallet = new ethers.Wallet(KEY.trim(), provider);

const clmmB32 = b32(PK(C.program));
console.log("deploying RomeClmmRouter, clmmProgram =", clmmB32, "from", wallet.address);
const factory = new ethers.ContractFactory(art.abi, art.bytecode.object, wallet);
const c = await factory.deploy(clmmB32);
await c.waitForDeployment();
const addr = await c.getAddress();
console.log("CLMM_ROUTER_DEPLOYED", addr);

// Register the proof pool: [pool, vault0, vault1, mint0, mint1].
const accts = [C.pool, C.vault0, C.vault1, C.mint0, C.mint1].map((k) => b32(PK(k)));
const tx = await c.registerPool(b32(PK(C.pool)), accts);
await tx.wait(1);
console.log("registerPool", tx.hash);

fs.writeFileSync(path.join(DIR, "clmm-router.json"),
  JSON.stringify({ address: addr, clmmProgram: C.program, pool: C.pool }, null, 2) + "\n");
console.log("wrote clmm-router.json");
