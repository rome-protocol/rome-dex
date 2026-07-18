// createPool.ts — PURE builder for the CreatePool instruction (tag 7): create a
// NEW constant-product pool over two existing tokens with NO ephemeral signers.
// The program creates the pool state PDA, the LP mint PDA, and the fee/destination
// PDAs internally (invoke_signed), so BOTH lanes can create a pool — the EVM lane
// via the CPI precompile (external_auth PDA auto-signed as payer). Byte-identical
// to the flow proven on-chain in harness/create-simple-pool.test.mjs.
//
// The caller pre-creates + funds the two vaults (the authority PDA's ATAs of the
// two mints) before CreatePool, exactly as the classic Initialize requires; the
// lane-specific submit lives in createPool-actions.ts.

import { ethers } from "ethers";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

type Fees = { tradeNum: bigint; tradeDen: bigint; ownerNum: bigint; ownerDen: bigint };

// Fee tiers a user can pick. `feeBps` is part of the pool PDA seed so (pair, fee)
// de-duplicates; `fees` is the on-chain Fees struct (same as the seeded tiers).
export const CREATE_FEE_TIERS: ReadonlyArray<{ tier: string; feeBps: number; fees: Fees }> = [
  { tier: "0.05%", feeBps: 5, fees: { tradeNum: 5n, tradeDen: 10_000n, ownerNum: 0n, ownerDen: 10_000n } },
  { tier: "0.30%", feeBps: 30, fees: { tradeNum: 25n, tradeDen: 10_000n, ownerNum: 5n, ownerDen: 10_000n } },
  { tier: "1.00%", feeBps: 100, fees: { tradeNum: 100n, tradeDen: 10_000n, ownerNum: 0n, ownerDen: 10_000n } },
];

const u16 = (v: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u64 = (v: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };

// CreatePool data: [7][fee_bps u16][pool_bump][lp_bump][fees(8×u64)][curve: 0 + 32 zero].
export function createPoolData(feeBps: number, poolBump: number, lpBump: number, fees: Fees): Buffer {
  const feesBuf = Buffer.concat([
    u64(fees.tradeNum), u64(fees.tradeDen), u64(fees.ownerNum), u64(fees.ownerDen),
    u64(0n), u64(10_000n), u64(0n), u64(10_000n), // owner-withdraw + host (zero, nonzero denoms)
  ]);
  const curve = Buffer.concat([Buffer.from([0]), Buffer.alloc(32)]); // ConstantProduct
  return Buffer.concat([Buffer.from([7]), u16(feeBps), Buffer.from([poolBump]), Buffer.from([lpBump]), feesBuf, curve]);
}

// PDA derivations (seeds per program/src/processor.rs process_create_pool).
export const poolPdaFor = (program: PublicKey, mintA: PublicKey, mintB: PublicKey, feeBps: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("cp_pool"), mintA.toBuffer(), mintB.toBuffer(), u16(feeBps)], program);
export const authorityFor = (program: PublicKey, pool: PublicKey) =>
  PublicKey.findProgramAddressSync([pool.toBuffer()], program);
export const lpMintFor = (program: PublicKey, pool: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("cp_lp"), pool.toBuffer()], program);
export const feeAcctFor = (program: PublicKey, pool: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("cp_fee"), pool.toBuffer()], program);
export const destFor = (program: PublicKey, pool: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("cp_dest"), pool.toBuffer()], program);
/** A vault is the authority PDA's ATA for the mint (created + funded by the caller). */
export const vaultAtaFor = (authority: PublicKey, mint: PublicKey) =>
  getAssociatedTokenAddressSync(mint, authority, true, TOKEN_PROGRAM_ID);

const acc = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

export interface CreatePoolArgs {
  program: PublicKey; payer: PublicKey;
  pool: PublicKey; poolBump: number; authority: PublicKey;
  mintA: PublicKey; mintB: PublicKey; vaultA: PublicKey; vaultB: PublicKey;
  lpMint: PublicKey; lpBump: number; feeAcct: PublicKey; destination: PublicKey;
  feeBps: number; fees: Fees;
}

/** The CreatePool instruction — account order byte-identical to the proven test. */
export function buildCreatePoolIx(a: CreatePoolArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.program,
    keys: [
      acc(a.payer, true, true), acc(a.pool, false, true), acc(a.authority, false, false),
      acc(a.mintA, false, false), acc(a.mintB, false, false),
      acc(a.vaultA, false, true), acc(a.vaultB, false, true),
      acc(a.lpMint, false, true), acc(a.feeAcct, false, true), acc(a.destination, false, true),
      acc(TOKEN_PROGRAM_ID, false, false), acc(SystemProgram.programId, false, false),
    ],
    data: createPoolData(a.feeBps, a.poolBump, a.lpBump, a.fees),
  });
}

/** Resolve every account CreatePool needs from the two mints + fee tier. */
export function resolveCreatePool(program: PublicKey, mintA: PublicKey, mintB: PublicKey, feeBps: number) {
  const [pool, poolBump] = poolPdaFor(program, mintA, mintB, feeBps);
  const [authority] = authorityFor(program, pool);
  const [lpMint, lpBump] = lpMintFor(program, pool);
  const [feeAcct] = feeAcctFor(program, pool);
  const [destination] = destFor(program, pool);
  return {
    pool, poolBump, authority, lpMint, lpBump, feeAcct, destination,
    vaultA: vaultAtaFor(authority, mintA), vaultB: vaultAtaFor(authority, mintB),
  };
}

// ── EVM-lane call encoding (pure) ────────────────────────────────────────────
// The complete EVM-lane create sequence as raw {to,data} calls. The action file
// only signs + sends these; the on-chain harness (create-pool-app-path.test.mjs)
// submits the SAME bytes with a fresh wallet — a true app-path proof. (The
// 0x8b0caf87 unsupported-selector bug shipped because the earlier proof funded
// the vaults deployer-side, never exercising the app's own HELPER calldata.)

export const HELPER_PRECOMPILE = "0xff00000000000000000000000000000000000009";
export const CPI_PRECOMPILE_ADDR = "0xFF00000000000000000000000000000000000008";
export const BOOTSTRAP_LAMPORTS = 30_000_000n; // pool + LP mint + fee + dest + vault rents

const HELPER_IFACE = new ethers.Interface([
  "function swap_gas_to_lamports(uint64 lamports)",
  "function create_ata_for_key(bytes32 wallet, bytes32 mint)",
  // 0xb6977879 (helper `transfer_spl_with_mint_to_ata`) — destination is a
  // PRE-DERIVED token account, sourced from the caller's own PDA ATA. The pool
  // vault is exactly such an account (the authority PDA's ATA of the mint).
  "function transfer_spl(bytes32 to_ata, uint64 amount, bytes32 mint)",
]);
const CPI_IFACE = new ethers.Interface([
  "function invoke(bytes32 program_id, (bytes32 pubkey, bool is_signer, bool is_writable)[] accounts, bytes data)",
]);
const eb32 = (pk: PublicKey): string => "0x" + Buffer.from(pk.toBuffer()).toString("hex");

export interface EvmCall { to: string; data: string; label: string }

export interface EvmCreatePoolPlan {
  program: PublicKey;
  /** The EVM user's external_auth PDA — CreatePool payer + vault funder. */
  owner: PublicKey;
  mintA: PublicKey; mintB: PublicKey; feeBps: number; fees: Fees;
  seedA: bigint; seedB: bigint;
  needBootstrap: boolean; needVaultA: boolean; needVaultB: boolean;
}

/** Encode the EVM-lane create sequence. Returns the calls + resolved accounts. */
export function buildEvmCreatePoolCalls(p: EvmCreatePoolPlan): { calls: EvmCall[]; resolved: ReturnType<typeof resolveCreatePool> } {
  const r = resolveCreatePool(p.program, p.mintA, p.mintB, p.feeBps);
  const calls: EvmCall[] = [];
  if (p.needBootstrap) {
    calls.push({ to: HELPER_PRECOMPILE, label: "Prepare your account", data: HELPER_IFACE.encodeFunctionData("swap_gas_to_lamports", [BOOTSTRAP_LAMPORTS]) });
  }
  if (p.needVaultA) {
    calls.push({ to: HELPER_PRECOMPILE, label: "Set up the pool's vaults", data: HELPER_IFACE.encodeFunctionData("create_ata_for_key", [eb32(r.authority), eb32(p.mintA)]) });
  }
  if (p.needVaultB) {
    calls.push({ to: HELPER_PRECOMPILE, label: "Set up the pool's vaults", data: HELPER_IFACE.encodeFunctionData("create_ata_for_key", [eb32(r.authority), eb32(p.mintB)]) });
  }
  calls.push({ to: HELPER_PRECOMPILE, label: "Fund the pool's vaults", data: HELPER_IFACE.encodeFunctionData("transfer_spl", [eb32(r.vaultA), p.seedA, eb32(p.mintA)]) });
  calls.push({ to: HELPER_PRECOMPILE, label: "Fund the pool's vaults", data: HELPER_IFACE.encodeFunctionData("transfer_spl", [eb32(r.vaultB), p.seedB, eb32(p.mintB)]) });
  const ix = buildCreatePoolIx({ program: p.program, payer: p.owner, mintA: p.mintA, mintB: p.mintB, feeBps: p.feeBps, fees: p.fees, ...r });
  calls.push({
    to: CPI_PRECOMPILE_ADDR, label: "Create the pool and open it",
    data: CPI_IFACE.encodeFunctionData("invoke", [eb32(p.program), ix.keys.map((k) => [eb32(k.pubkey), k.isSigner, k.isWritable]), "0x" + ix.data.toString("hex")]),
  });
  return { calls, resolved: r };
}
