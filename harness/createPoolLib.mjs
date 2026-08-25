// Shared CreatePool (tag 7) helpers for the harness's pool-creation scripts —
// no ephemeral signers, PDA-derived accounts. v2 has no dedicated fee-LP PDA
// (protocol fees are SwapV2 counters); the config PDA is CreatePool's
// gate account, appended at the end (index 11) so accounts 0-10 are the same
// shape the classic Initialize used minus its fee account.
//
// Used by create-pool.mjs, create-pool2.mjs, create-real-pool.mjs,
// create-real-pair-eth.mjs, create-tiered-pools.mjs, create-real-tiered-pools.mjs.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

export const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };

// Fees for a given fee-bps tier: {tradeNum, tradeDen, ownerNum, ownerDen}.
// owner_withdraw + host stay 0/0 (production requires exact-equal-zero denominators).
export function feesBufFor({ tradeNum, tradeDen, ownerNum, ownerDen }) {
  return Buffer.concat([u64(tradeNum), u64(tradeDen), u64(ownerNum), u64(ownerDen), u64(0), u64(0), u64(0), u64(0)]);
}
export const CURVE_CONSTANT_PRODUCT = Buffer.concat([Buffer.from([0]), Buffer.alloc(32)]);

// CreatePool data: [7][fee_bps u16][pool_bump][lp_bump][fees(64)][curve(33)].
export function createPoolData(feeBps, poolBump, lpBump, feesBuf, curveBuf = CURVE_CONSTANT_PRODUCT) {
  return Buffer.concat([Buffer.from([7]), u16(feeBps), Buffer.from([poolBump]), Buffer.from([lpBump]), feesBuf, curveBuf]);
}

// PDA derivations (seeds per program/src/processor.rs process_create_pool).
export const poolPdaFor = (program, mintA, mintB, feeBps) =>
  PublicKey.findProgramAddressSync([Buffer.from("cp_pool"), mintA.toBuffer(), mintB.toBuffer(), u16(feeBps)], program);
export const authorityFor = (program, pool) =>
  PublicKey.findProgramAddressSync([pool.toBuffer()], program);
export const lpMintFor = (program, pool) =>
  PublicKey.findProgramAddressSync([Buffer.from("cp_lp"), pool.toBuffer()], program);
export const destFor = (program, pool) =>
  PublicKey.findProgramAddressSync([Buffer.from("cp_dest"), pool.toBuffer()], program);
export const configPdaFor = (program) =>
  PublicKey.findProgramAddressSync([Buffer.from("config")], program);

// Resolve every PDA CreatePool needs from the two mints + fee tier.
export function resolveCreatePool(program, mintA, mintB, feeBps) {
  const [pool, poolBump] = poolPdaFor(program, mintA, mintB, feeBps);
  const [authority, authorityBump] = authorityFor(program, pool);
  const [lpMint, lpBump] = lpMintFor(program, pool);
  const [dest] = destFor(program, pool);
  const [config] = configPdaFor(program);
  return { pool, poolBump, authority, authorityBump, lpMint, lpBump, dest, config };
}

// The CreatePool instruction — 12 accounts, config PDA appended at index 11.
// `vaultA`/`vaultB` are the authority PDA's ATAs, pre-created + funded by the
// caller before this instruction runs (the program does not create them).
export function buildCreatePoolIx({ program, payer, pool, poolBump, authority, mintA, mintB, vaultA, vaultB, lpMint, lpBump, dest, config, feeBps, feesBuf, curveBuf }) {
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: mintA, isSigner: false, isWritable: false },
      { pubkey: mintB, isSigner: false, isWritable: false },
      { pubkey: vaultA, isSigner: false, isWritable: true },
      { pubkey: vaultB, isSigner: false, isWritable: true },
      { pubkey: lpMint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
    ],
    data: createPoolData(feeBps, poolBump, lpBump, feesBuf, curveBuf),
  });
}
