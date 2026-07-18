// deploy-router.mjs — deploy a fresh RomeDexRouter and record it to router.json.
// Usage: HADRIAN_PRIVATE_KEY=… node deploy-router.mjs
import fs from "node:fs";
import { ethers } from "ethers";
import { EVM_RPC, CHAIN_ID, PK, b32 } from "./lib.mjs";

const KEY = process.env.HADRIAN_PRIVATE_KEY;
if (!KEY) { console.error("HADRIAN_PRIVATE_KEY required"); process.exit(1); }
const DEX_PROGRAM = "Fv2LgkewH9114T6Gg99ERq8TxMVj2MGPRC73dJ4AKb1A";

const art = JSON.parse(fs.readFileSync(new URL("../contracts/out/RomeDexRouter.sol/RomeDexRouter.json", import.meta.url)));
const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
const wallet = new ethers.Wallet(KEY.trim(), provider);

const factory = new ethers.ContractFactory(art.abi, art.bytecode.object, wallet);
const dexB32 = b32(PK(DEX_PROGRAM));
console.log("deploying RomeDexRouter, dexProgram =", dexB32, "from", wallet.address);
const c = await factory.deploy(dexB32);
await c.waitForDeployment();
const addr = await c.getAddress();
console.log("ROUTER_DEPLOYED", addr);
fs.writeFileSync(new URL("./router.json", import.meta.url), JSON.stringify({ address: addr, dexProgram: DEX_PROGRAM }, null, 2) + "\n");
console.log("wrote router.json");
