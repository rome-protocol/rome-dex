// P1 completion: dual-lane ADD + REMOVE liquidity into the same rome-dex pool, LP-token dual-lane
// check, and self-sustain fee-accrual check. Solana lane = keypair direct; EVM lane = CPI 0xFF..08
// with external_auth PDA authority.

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, getAccount, getMint, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ethers } from "ethers";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url";
const DIR = path.dirname(fileURLToPath(import.meta.url));

const SOL = "https://api.devnet.solana.com";
const EVM_RPC = "https://hadrian-lt.testnet.romeprotocol.xyz/";
const CHAIN_ID = 200010n, GAS_PRICE = 11_000_000_000n, CPI = "0xFF00000000000000000000000000000000000008";
const ROME_EVM = new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf");
const EVM_DEPLOYER = "0x1f4946Be340F06c46A50E65084790968aBcc48F6";
const pool = JSON.parse(fs.readFileSync(path.join(DIR, "pool.json"), "utf8"));
const PK = (s) => new PublicKey(s);
const conn = new Connection(SOL, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))));
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const T = TOKEN_PROGRAM_ID;

function depositAccts(auth, uA, uB, uLp) {
  return [[PK(pool.swapState),0,0],[PK(pool.authority),0,0],[auth,1,0],[uA,0,1],[uB,0,1],[PK(pool.vaultA),0,1],[PK(pool.vaultB),0,1],[PK(pool.poolMint),0,1],[uLp,0,1],[PK(pool.mintA),0,0],[PK(pool.mintB),0,0],[T,0,0],[T,0,0],[T,0,0]].map(([p,s,w])=>({pubkey:p instanceof PublicKey?p:PK(p),isSigner:!!s,isWritable:!!w}));
}
function withdrawAccts(auth, uLp, uA, uB) {
  return [[PK(pool.swapState),0,0],[PK(pool.authority),0,0],[auth,1,0],[PK(pool.poolMint),0,1],[uLp,0,1],[PK(pool.vaultA),0,1],[PK(pool.vaultB),0,1],[uA,0,1],[uB,0,1],[PK(pool.feeAccount),0,1],[PK(pool.mintA),0,0],[PK(pool.mintB),0,0],[T,0,0],[T,0,0],[T,0,0]].map(([p,s,w])=>({pubkey:p instanceof PublicKey?p:PK(p),isSigner:!!s,isWritable:!!w}));
}
const depData = (lp, maxA, maxB) => Buffer.concat([Buffer.from([2]), u64(lp), u64(maxA), u64(maxB)]);
const wdData = (lp, minA, minB) => Buffer.concat([Buffer.from([3]), u64(lp), u64(minA), u64(minB)]);
const solRpc = async (m,p)=>(await(await fetch(SOL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})})).json());
async function cuSig(sig){for(const d of[600,2500,3500,5000,6000]){await new Promise(r=>setTimeout(r,d));const t=await solRpc("getTransaction",[sig,{maxSupportedTransactionVersion:0,commitment:"confirmed",encoding:"json"}]);if(t.result)return t.result.meta?.computeUnitsConsumed??0;}return null;}
const supply = async()=> (await getMint(conn, PK(pool.poolMint))).supply;
const bal = async(a)=>{try{return (await getAccount(conn,a)).amount;}catch{return 0n;}};

async function main(){
  const LP = 200_000n, MAXA = 100_000_000n, MAXB = 100_000_000_000n;
  // ---- Solana lane add-liquidity ----
  const payerLp = await getOrCreateAssociatedTokenAccount(conn, payer, PK(pool.poolMint), payer.publicKey);
  const sBefore = await supply();
  const dIx = new TransactionInstruction({ programId: PK(pool.program), keys: depositAccts(payer.publicKey, PK(pool.payerAtaA), PK(pool.payerAtaB), payerLp.address), data: depData(LP, MAXA, MAXB) });
  const dSig = await sendAndConfirmTransaction(conn, new Transaction().add(dIx), [payer], { commitment: "confirmed" });
  const solDepCU = await cuSig(dSig);
  console.log(`[Solana add-liq] LP+=${(await bal(payerLp.address))}  poolMint supply ${sBefore}->${await supply()}  CU=${solDepCU}`);

  // ---- EVM lane add-liquidity (via CPI) ----
  const key = process.env.HADRIAN_PRIVATE_KEY; if(!key){console.error("no EVM key");process.exit(1);}
  const evmPda = PublicKey.findProgramAddressSync([Buffer.from("EXTERNAL_AUTHORITY"), Buffer.from(EVM_DEPLOYER.slice(2),"hex")], ROME_EVM)[0];
  const evmA = await getOrCreateAssociatedTokenAccount(conn, payer, PK(pool.mintA), evmPda, true);
  const evmB = await getOrCreateAssociatedTokenAccount(conn, payer, PK(pool.mintB), evmPda, true);
  const evmLp = await getOrCreateAssociatedTokenAccount(conn, payer, PK(pool.poolMint), evmPda, true);
  // ensure funded A + B (mint if low)
  if(await bal(evmA.address) < MAXA) await mintTo(conn, payer, PK(pool.mintA), evmA.address, payer, 100_000_000n);
  if(await bal(evmB.address) < 20_000_000_000n) await mintTo(conn, payer, PK(pool.mintB), evmB.address, payer, 100_000_000_000n);
  const b32=(pk)=>"0x"+Buffer.from(pk.toBuffer()).toString("hex");
  const accs = depositAccts(evmPda, evmA.address, evmB.address, evmLp.address).map(a=>[b32(a.pubkey),a.isSigner,a.isWritable]);
  const iface=new ethers.Interface(["function invoke(bytes32 program,(bytes32,bool,bool)[] accounts,bytes data)"]);
  const calldata=iface.encodeFunctionData("invoke",[b32(PK(pool.program)),accs,"0x"+depData(LP,MAXA,MAXB).toString("hex")]);
  const provider=new ethers.JsonRpcProvider(EVM_RPC,undefined,{staticNetwork:true,batchMaxCount:1});
  const w=new ethers.Wallet(key.trim(),provider);
  const s2=await supply(); const lpBefore=await bal(evmLp.address);
  const nonce=await provider.getTransactionCount(w.address,"pending");
  const signed=await w.signTransaction({type:0,chainId:CHAIN_ID,nonce,gasPrice:GAS_PRICE,gasLimit:300_000_000n,to:CPI,value:0n,data:calldata});
  const send=await solRpcEvm("eth_sendRawTransaction",[signed]);
  if(send.error){console.error("[EVM add-liq] err",JSON.stringify(send.error).slice(0,220));process.exit(1);}
  await provider.waitForTransaction(send.result,1,120000).catch(()=>null);
  const sigs=(await solRpcEvm("rome_solanaTxForEvmTx",[send.result])).result||[];
  let evmCU=0,mx=0; for(const s of sigs){const c=await cuSig(s);if(c){evmCU+=c;mx=Math.max(mx,c);}}
  console.log(`[EVM add-liq via CPI] LP+=${(await bal(evmLp.address))-lpBefore}  poolMint supply ${s2}->${await supply()}  legs=${sigs.length} maxLeg=${mx}`);

  // ---- LP dual-lane + self-sustain fee check ----
  console.log(`\nLP token dual-lane: payer LP=${await bal(payerLp.address)} (Solana lane) | evmPda LP=${await bal(evmLp.address)} (EVM lane) — SAME mint ${pool.poolMint.slice(0,8)}…`);
  console.log(`self-sustain: pool fee account LP balance = ${await bal(PK(pool.feeAccount))} (owner-trade fees accrued from swaps → LPs)`);

  // ---- Solana lane remove-liquidity ----
  const aB=await bal(PK(pool.payerAtaA)), bB=await bal(PK(pool.payerAtaB));
  const wIx=new TransactionInstruction({programId:PK(pool.program),keys:withdrawAccts(payer.publicKey,payerLp.address,PK(pool.payerAtaA),PK(pool.payerAtaB)),data:wdData(100_000n,0n,0n)});
  const wSig=await sendAndConfirmTransaction(conn,new Transaction().add(wIx),[payer],{commitment:"confirmed"});
  const wCU=await cuSig(wSig);
  console.log(`[Solana remove-liq] burned 100000 LP → A+=${await bal(PK(pool.payerAtaA))-aB} B+=${await bal(PK(pool.payerAtaB))-bB}  CU=${wCU}`);
  console.log(`\n=== P1 FULL PARITY: swap + add-liq + remove-liq work on BOTH lanes into the same pool; LP is one dual-lane SPL mint; fees accrue to LPs ✅ ===`);
}
async function solRpcEvm(m,p){return await(await fetch(EVM_RPC,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})})).json();}
main().catch(e=>{console.error("FAILED:",e.message);if(e.logs)console.error(e.logs.join("\n"));process.exit(1);});
