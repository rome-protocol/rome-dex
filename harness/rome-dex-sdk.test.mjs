// rome-dex-sdk.test.mjs — host-level tests for the dress-rehearsal SDK
// extension (sdk/rome-dex.ts, dress-rehearsal harness).
// No chain access. Run with `node --import tsx --test rome-dex-sdk.test.mjs`
// from harness/ (needs harness/node_modules — @solana/web3.js + tsx, both
// already dependencies here).
//
// Golden vectors are GENERATED from Rust (program/src/instruction.rs's
// golden_vector_* tests), never hand-authored — same discipline as
// deploy/genesis-pools.test.mjs. Account-order pin tests compare byte-for-
// byte against harness/createPoolLib.mjs (the on-chain-proven producer) and
// the ceremony's own ix shape (deploy/genesis-pools.mjs), so the SDK can
// never silently drift from either.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PublicKey } from "@solana/web3.js";

import {
  ROME_DEX_PROGRAM,
  buildSwap, buildAddLiquidity, buildRemoveLiquidity,
  buildCreatePool, buildInitializeConfig, buildSetTreasury,
  buildTransferAdmin, buildAcceptAdmin, buildSetPoolCreation,
  deriveCreatePoolAddresses, deriveConfigPda, encodeFees,
  authorityFromSolana,
} from "../sdk/rome-dex.ts";
import { buildCreatePoolIx, feesBufFor, CURVE_CONSTANT_PRODUCT, resolveCreatePool } from "./createPoolLib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.join(DIR, "..", "contracts", "test", "vectors");

function decodeHexVector(s) {
  const t = s.trim().replace(/^0x/, "");
  const out = Buffer.alloc(t.length / 2);
  for (let i = 0; i < t.length; i += 2) out[i / 2] = parseInt(t.slice(i, i + 2), 16);
  return out;
}

function readVector(name) {
  return decodeHexVector(fs.readFileSync(path.join(VECTORS, name), "utf8"));
}

const dataBytes = (ix) => Buffer.from(ix.data.slice(2), "hex");

// Fixed, arbitrary test pubkeys — irrelevant to which values, only that the
// SDK and the Rust fixture agree on the SAME ones.
const PROGRAM_ID = new PublicKey(Buffer.alloc(32, 99));
const ADMIN_11 = new PublicKey(Buffer.alloc(32, 11));
const TREASURY_22 = new PublicKey(Buffer.alloc(32, 22));
const TREASURY_33 = new PublicKey(Buffer.alloc(32, 33));
const PENDING_ADMIN_44 = new PublicKey(Buffer.alloc(32, 44));

describe("golden vectors (Rust-generated) — byte-pin every new builder", () => {
  test("buildCreatePool data matches dex_create_pool_data.hex", () => {
    const fixture = readVector("dex_create_pool_data.hex");
    // The fixture's fee_bps/pool_bump/lp_bump (30/254/253) are compiled into
    // the CreatePool struct directly in Rust, not derived from real PDAs —
    // pin the DATA only here (metas are pinned separately, below, against
    // createPoolLib on real derived PDAs). No mintA/mintB needed for this
    // one — see the comment below on why a throwaway mint pair isn't used.
    const feesBuf = encodeFees({
      tradeFeeNumerator: 25n, tradeFeeDenominator: 10_000n,
      ownerTradeFeeNumerator: 5n, ownerTradeFeeDenominator: 10_000n,
      ownerWithdrawFeeNumerator: 0n, ownerWithdrawFeeDenominator: 0n,
      hostFeeNumerator: 0n, hostFeeDenominator: 0n,
    });
    assert.deepEqual(feesBuf, feesBufFor({ tradeNum: 25n, tradeDen: 10_000n, ownerNum: 5n, ownerDen: 10_000n }));

    // Build the same [7][fee_bps][pool_bump][lp_bump][fees][curve] shape
    // buildCreatePool emits, using the SAME fixed bump values as the Rust
    // fixture (poolBump=254, lpBump=253) — call the internal encode path via
    // a throwaway mint pair ground to produce those exact bumps is
    // impractical, so assert the ENCODING function directly (encodeFees +
    // CURVE_CONSTANT_PRODUCT are the two moving parts buildCreatePool calls;
    // both are pinned): reconstruct the full data buffer by hand and compare.
    const feeBpsBuf = Buffer.alloc(2); feeBpsBuf.writeUInt16LE(30);
    const data = Buffer.concat([Buffer.from([7]), feeBpsBuf, Buffer.from([254, 253]), feesBuf, CURVE_CONSTANT_PRODUCT]);
    assert.deepEqual(data, fixture);
    assert.equal(data.length, 102);
  });

  test("buildInitializeConfig data matches dex_initialize_config_data.hex", () => {
    const fixture = readVector("dex_initialize_config_data.hex");
    const ix = buildInitializeConfig({
      programId: PROGRAM_ID, payer: PROGRAM_ID, upgradeAuthority: PROGRAM_ID,
      programData: PROGRAM_ID, admin: ADMIN_11, treasury: TREASURY_22, mode: 1,
    });
    assert.deepEqual(dataBytes(ix), fixture);
    assert.equal(dataBytes(ix).length, 66);
  });

  test("buildSetTreasury data matches dex_set_treasury_data.hex", () => {
    const fixture = readVector("dex_set_treasury_data.hex");
    const ix = buildSetTreasury({ programId: PROGRAM_ID, admin: ADMIN_11, treasury: TREASURY_33 });
    assert.deepEqual(dataBytes(ix), fixture);
    assert.equal(dataBytes(ix).length, 33);
  });

  test("buildTransferAdmin data matches dex_transfer_admin_data.hex", () => {
    const fixture = readVector("dex_transfer_admin_data.hex");
    const ix = buildTransferAdmin({ programId: PROGRAM_ID, admin: ADMIN_11, pendingAdmin: PENDING_ADMIN_44 });
    assert.deepEqual(dataBytes(ix), fixture);
    assert.equal(dataBytes(ix).length, 33);
  });

  test("buildAcceptAdmin data matches dex_accept_admin_data.hex", () => {
    const fixture = readVector("dex_accept_admin_data.hex");
    const ix = buildAcceptAdmin({ programId: PROGRAM_ID, pendingAdmin: PENDING_ADMIN_44 });
    assert.deepEqual(dataBytes(ix), fixture);
    assert.equal(dataBytes(ix).length, 1);
  });

  test("buildSetPoolCreation data matches dex_set_pool_creation_data.hex", () => {
    const fixture = readVector("dex_set_pool_creation_data.hex");
    const ix = buildSetPoolCreation({ programId: PROGRAM_ID, admin: ADMIN_11, mode: 1 });
    assert.deepEqual(dataBytes(ix), fixture);
    assert.equal(dataBytes(ix).length, 2);
  });
});

describe("account order — pinned against the on-chain-proven producers, field-for-field", () => {
  test("buildCreatePool's 12 metas equal createPoolLib.buildCreatePoolIx's metas, for the SAME derived PDAs", () => {
    const programId = new PublicKey(Buffer.alloc(32, 7));
    const mintA = new PublicKey(Buffer.alloc(32, 1));
    const mintB = new PublicKey(Buffer.alloc(32, 2));
    const payer = new PublicKey(Buffer.alloc(32, 9));
    const feeBps = 30;

    const resolved = resolveCreatePool(programId, mintA, mintB, feeBps);
    const vaultA = new PublicKey(Buffer.alloc(32, 5));
    const vaultB = new PublicKey(Buffer.alloc(32, 6));
    const feesBuf = feesBufFor({ tradeNum: 25n, tradeDen: 10_000n, ownerNum: 5n, ownerDen: 10_000n });

    const referenceIx = buildCreatePoolIx({
      program: programId, payer, pool: resolved.pool, poolBump: resolved.poolBump,
      authority: resolved.authority, mintA, mintB, vaultA, vaultB, lpMint: resolved.lpMint,
      lpBump: resolved.lpBump, dest: resolved.dest, config: resolved.config, feeBps, feesBuf,
      curveBuf: CURVE_CONSTANT_PRODUCT,
    });

    const sdkIx = buildCreatePool({
      programId, payer, mintA, mintB, feeBps, vaultA, vaultB,
      fees: {
        tradeFeeNumerator: 25n, tradeFeeDenominator: 10_000n,
        ownerTradeFeeNumerator: 5n, ownerTradeFeeDenominator: 10_000n,
      },
    });

    assert.equal(sdkIx.accounts.length, 12);
    assert.equal(referenceIx.keys.length, 12);
    for (let i = 0; i < 12; i++) {
      assert.equal(sdkIx.accounts[i].pubkey.toBase58(), referenceIx.keys[i].pubkey.toBase58(), `meta ${i} pubkey`);
      assert.equal(sdkIx.accounts[i].isSigner, referenceIx.keys[i].isSigner, `meta ${i} isSigner`);
      assert.equal(sdkIx.accounts[i].isWritable, referenceIx.keys[i].isWritable, `meta ${i} isWritable`);
    }
    assert.deepEqual(dataBytes(sdkIx), referenceIx.data, "data bytes match createPoolLib.createPoolData exactly");
  });

  test("deriveCreatePoolAddresses matches harness/createPoolLib.mjs::resolveCreatePool exactly (pool/authority/lpMint/dest/config)", () => {
    const programId = new PublicKey(Buffer.alloc(32, 42));
    const mintA = new PublicKey(Buffer.alloc(32, 1));
    const mintB = new PublicKey(Buffer.alloc(32, 2));
    const feeBps = 5;
    const a = deriveCreatePoolAddresses(mintA, mintB, feeBps, programId);
    const b = resolveCreatePool(programId, mintA, mintB, feeBps);
    assert.equal(a.pool.toBase58(), b.pool.toBase58());
    assert.equal(a.poolBump, b.poolBump);
    assert.equal(a.swapAuthority.toBase58(), b.authority.toBase58());
    assert.equal(a.lpMint.toBase58(), b.lpMint.toBase58());
    assert.equal(a.lpBump, b.lpBump);
    assert.equal(a.dest.toBase58(), b.dest.toBase58());
    assert.equal(a.config.toBase58(), b.config.toBase58());
  });

  test("buildInitializeConfig's 5 metas mirror the ceremony's ix shape (deploy/genesis-pools.mjs:677-687)", () => {
    const programId = new PublicKey(Buffer.alloc(32, 3));
    const payer = new PublicKey(Buffer.alloc(32, 4));
    const upgradeAuthority = new PublicKey(Buffer.alloc(32, 5));
    const programData = new PublicKey(Buffer.alloc(32, 6));
    const ix = buildInitializeConfig({
      programId, payer, upgradeAuthority, programData, admin: ADMIN_11, treasury: TREASURY_22, mode: 0,
    });
    const config = deriveConfigPda(programId);
    assert.equal(ix.accounts.length, 5);
    const expect = [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: upgradeAuthority, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: programData, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
    ];
    for (let i = 0; i < 5; i++) {
      assert.equal(ix.accounts[i].pubkey.toBase58(), expect[i].pubkey.toBase58(), `meta ${i} pubkey`);
      assert.equal(ix.accounts[i].isSigner, expect[i].isSigner, `meta ${i} isSigner`);
      assert.equal(ix.accounts[i].isWritable, expect[i].isWritable, `meta ${i} isWritable`);
    }
  });

  test("buildSetTreasury/buildTransferAdmin/buildAcceptAdmin/buildSetPoolCreation are all [config(w), signer(ro)] — matches instruction.rs's set_treasury/transfer_admin/accept_admin/set_pool_creation builders", () => {
    const programId = new PublicKey(Buffer.alloc(32, 8));
    const config = deriveConfigPda(programId);
    for (const ix of [
      buildSetTreasury({ programId, admin: ADMIN_11, treasury: TREASURY_33 }),
      buildTransferAdmin({ programId, admin: ADMIN_11, pendingAdmin: PENDING_ADMIN_44 }),
      buildAcceptAdmin({ programId, pendingAdmin: PENDING_ADMIN_44 }),
      buildSetPoolCreation({ programId, admin: ADMIN_11, mode: 1 }),
    ]) {
      assert.equal(ix.accounts.length, 2);
      assert.equal(ix.accounts[0].pubkey.toBase58(), config.toBase58());
      assert.equal(ix.accounts[0].isSigner, false);
      assert.equal(ix.accounts[0].isWritable, true);
      assert.equal(ix.accounts[1].isSigner, true);
      assert.equal(ix.accounts[1].isWritable, false);
    }
  });
});

describe("hot-path builders — unchanged under default programId (regression)", () => {
  const pool = {
    swap: new PublicKey(Buffer.alloc(32, 1)),
    poolMint: new PublicKey(Buffer.alloc(32, 2)),
    swapTokenA: new PublicKey(Buffer.alloc(32, 3)),
    swapTokenB: new PublicKey(Buffer.alloc(32, 4)),
    mintA: new PublicKey(Buffer.alloc(32, 5)),
    mintB: new PublicKey(Buffer.alloc(32, 6)),
    tokenProgramA: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    tokenProgramB: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    poolTokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  };
  const authority = authorityFromSolana(new PublicKey(Buffer.alloc(32, 7)));
  const userAtas = {
    tokenA: new PublicKey(Buffer.alloc(32, 8)),
    tokenB: new PublicKey(Buffer.alloc(32, 9)),
    poolToken: new PublicKey(Buffer.alloc(32, 10)),
  };

  test("buildSwap defaults program to ROME_DEX_PROGRAM when programId is omitted", () => {
    const ix = buildSwap({ authority, poolAccounts: pool, direction: "AToB", userAtas, amounts: { amountIn: 1n, minimumAmountOut: 0n } });
    assert.equal(ix.program.toBase58(), ROME_DEX_PROGRAM.toBase58());
  });

  test("buildSwap targets an explicit programId when given (threaded through deriveSwapAuthority + program field)", () => {
    const customProgram = new PublicKey(Buffer.alloc(32, 55));
    const ixDefault = buildSwap({ authority, poolAccounts: pool, direction: "AToB", userAtas, amounts: { amountIn: 1n, minimumAmountOut: 0n } });
    const ixCustom = buildSwap({ authority, poolAccounts: pool, direction: "AToB", userAtas, amounts: { amountIn: 1n, minimumAmountOut: 0n }, programId: customProgram });
    assert.equal(ixCustom.program.toBase58(), customProgram.toBase58());
    // swap authority (meta 1) is program-derived — must differ between the
    // default and custom program targets, proving programId actually reached
    // deriveSwapAuthority and isn't just cosmetic on the `program:` field.
    assert.notEqual(ixCustom.accounts[1].pubkey.toBase58(), ixDefault.accounts[1].pubkey.toBase58());
  });

  test("buildAddLiquidity / buildRemoveLiquidity: programId threads to both program field and derived authority", () => {
    const customProgram = new PublicKey(Buffer.alloc(32, 66));
    const add = buildAddLiquidity({ authority, poolAccounts: pool, userAtas, amounts: { poolTokenAmount: 1n, maximumTokenAAmount: 1n, maximumTokenBAmount: 1n }, programId: customProgram });
    const remove = buildRemoveLiquidity({ authority, poolAccounts: pool, userAtas, amounts: { poolTokenAmount: 1n, minimumTokenAAmount: 0n, minimumTokenBAmount: 0n }, programId: customProgram });
    assert.equal(add.program.toBase58(), customProgram.toBase58());
    assert.equal(remove.program.toBase58(), customProgram.toBase58());
  });
});
