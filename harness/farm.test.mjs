// rome-dex FARM — dual-lane liquidity-mining proof (roadmap 2a).
//
// Stakes the rome-dex USDC/SOL 0.30% LP mint into the farm program from BOTH
// lanes into the SAME farm, advances time, and proves reward accrues
// proportionally to stake and claims mint the reward SPL to each lane's reward
// ATA, then unstake returns LP. CU is measured per lane.
//
//   • Solana lane — the local payer keypair signs directly.
//   • EVM lane    — the deployer EOA calls CPI 0xFF..08; Rome auto-signs with
//                   its external_auth PDA (the authority-agnostic seam).
//
// Run sequentially (shares one live farm + one EOA nonce):
//   HADRIAN_PRIVATE_KEY=$(...) node --test farm.test.mjs
// Prereq: setup-farm.mjs has been run (writes farm.json). The EVM lane skips
// (does not fail) when HADRIAN_PRIVATE_KEY is unset.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { transfer } from "@solana/spl-token";
import {
  conn, payer, PK, bal, evmPdaFor, ensureAta, execSolana, execEvmCpi,
} from "./lib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const farm = JSON.parse(fs.readFileSync(path.join(DIR, "farm.json"), "utf8"));
const FARM_PROGRAM = new PublicKey(farm.farmProgram);
const KEY = process.env.HADRIAN_PRIVATE_KEY;
const EVM_EOA = "0x1f4946Be340F06c46A50E65084790968aBcc48F6";

// LP source: the payer holds the pool's initial LP in the tier's `destination`.
const tiers = JSON.parse(fs.readFileSync(path.join(DIR, "pools-real-tiers.json"), "utf8"));
const LP_SRC = new PublicKey(tiers.find((t) => t.poolMint === farm.lpMint).destination);

const SOL_STAKE = 100_000n; // 0.1 LP (6 decimals)
const EVM_STAKE = 200_000n; // 0.2 LP — 2× the Solana lane, to prove proportionality
const WAIT_MS = 12_000;

// ---- farm instruction encoders ----
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const initUserStakeData = () => Buffer.from([1]);
const stakeData = (amt) => Buffer.concat([Buffer.from([2]), u64(amt)]);
const unstakeData = (amt) => Buffer.concat([Buffer.from([3]), u64(amt)]);
const claimData = () => Buffer.from([4]);

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const userStakePda = (authority) =>
  PublicKey.findProgramAddressSync(
    [new PublicKey(farm.farm).toBuffer(), PK(authority).toBuffer()], FARM_PROGRAM)[0];

const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w });

const initUserStakeAccounts = (authority, ustake) => [
  acc(farm.farm, 0, 0), acc(authority, 0, 0), acc(ustake, 0, 1),
  acc(payer.publicKey, 1, 1), acc("11111111111111111111111111111111", 0, 0),
];
const stakeAccounts = (authority, ustake, userLp) => [
  acc(farm.farm, 0, 1), acc(farm.authority, 0, 0), acc(authority, 1, 0),
  acc(ustake, 0, 1), acc(userLp, 0, 1), acc(farm.lpVault, 0, 1), acc(TOKEN, 0, 0),
];
const unstakeAccounts = (authority, ustake, userLp) => [
  acc(farm.farm, 0, 1), acc(farm.authority, 0, 0), acc(authority, 1, 0),
  acc(ustake, 0, 1), acc(farm.lpVault, 0, 1), acc(userLp, 0, 1), acc(TOKEN, 0, 0),
];
const claimAccounts = (authority, ustake, userReward) => [
  acc(farm.farm, 0, 1), acc(farm.authority, 0, 0), acc(authority, 1, 0),
  acc(ustake, 0, 1), acc(farm.rewardMint, 0, 1), acc(userReward, 0, 1), acc(TOKEN, 0, 0),
];

// ---- lane state (resolved in setup) ----
const S = { solAuth: payer.publicKey, evmAuth: null,
  solLp: null, evmLp: null, solReward: null, evmReward: null,
  solStake: null, evmStake: null };
const CU = {};

test("setup: fund both lanes + create UserStake PDAs", async () => {
  S.evmAuth = evmPdaFor(EVM_EOA);
  S.solStake = userStakePda(S.solAuth);
  S.evmStake = userStakePda(S.evmAuth);

  // LP + reward ATAs on both lanes (EVM ones owned by the external_auth PDA).
  S.solLp = await ensureAta(farm.lpMint, S.solAuth);
  S.evmLp = await ensureAta(farm.lpMint, S.evmAuth, true);
  S.solReward = await ensureAta(farm.rewardMint, S.solAuth);
  S.evmReward = await ensureAta(farm.rewardMint, S.evmAuth, true);

  // Fund each lane's LP ATA from the pool's initial-LP account (payer-owned).
  const need = { [S.solLp]: SOL_STAKE * 3n, [S.evmLp]: EVM_STAKE * 3n };
  for (const [ata, want] of Object.entries(need)) {
    if ((await bal(ata)) < want) {
      await transfer(conn, payer, LP_SRC, PK(ata), payer, want);
    }
  }
  assert.ok((await bal(S.solLp)) >= SOL_STAKE, "solana lane funded with LP");
  assert.ok((await bal(S.evmLp)) >= EVM_STAKE, "evm lane funded with LP");

  // Create UserStake PDAs (permissionless — payer funds both authorities).
  for (const [auth, ustake] of [[S.solAuth, S.solStake], [S.evmAuth, S.evmStake]]) {
    const info = await conn.getAccountInfo(PK(ustake));
    if (!info) {
      const r = await execSolana({
        accounts: initUserStakeAccounts(auth, ustake), data: initUserStakeData(),
        programId: FARM_PROGRAM,
      });
      assert.ok(r.ok, "initUserStake");
    }
  }
  assert.ok(await conn.getAccountInfo(PK(S.solStake)), "solana UserStake exists");
  assert.ok(await conn.getAccountInfo(PK(S.evmStake)), "evm UserStake exists");
});

// SECURITY REGRESSION (fix #19): a stake with a substitute token_program must
// revert with IncorrectTokenProgram (Custom 9) BEFORE any accounting change.
// Without the guard, a no-op token program would fake-stake (credit amount, move
// no LP) → drain other stakers on a later real unstake (arbitrary CPI).
test("Solana lane: stake with wrong token program is rejected", async () => {
  const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
  const before = await bal(S.solLp);
  const badAccounts = stakeAccounts(S.solAuth, S.solStake, S.solLp);
  badAccounts[badAccounts.length - 1] = acc(SYSTEM_PROGRAM, 0, 0); // swap the real token program
  // execSolana throws on a failed tx/simulation; the guard must reject with
  // Custom(9) = IncorrectTokenProgram before any state change.
  let failed = null;
  try {
    const r = await execSolana({ accounts: badAccounts, data: stakeData(SOL_STAKE), programId: FARM_PROGRAM });
    if (r && r.ok === false) failed = String(r.error ?? "");
    else assert.fail("wrong-token-program stake must be rejected, but it succeeded");
  } catch (e) {
    failed = String(e?.message ?? e);
  }
  assert.match(failed, /0x9\b|custom program error: 0x9|IncorrectTokenProgram/i, `expected IncorrectTokenProgram, got: ${failed}`);
  assert.equal(await bal(S.solLp), before, "no LP moved on the rejected stake");
});

test("Solana lane: stake LP", async () => {
  const before = await bal(S.solLp);
  const r = await execSolana({
    accounts: stakeAccounts(S.solAuth, S.solStake, S.solLp), data: stakeData(SOL_STAKE),
    programId: FARM_PROGRAM,
  });
  assert.ok(r.ok, "stake ok");
  CU.stake_sol = r.cu;
  assert.equal(await bal(S.solLp) + SOL_STAKE, before, "LP debited from wallet");
});

test("EVM lane: stake LP via external_auth PDA", { skip: !KEY }, async () => {
  const before = await bal(S.evmLp);
  const r = await execEvmCpi({
    accounts: stakeAccounts(S.evmAuth, S.evmStake, S.evmLp), data: stakeData(EVM_STAKE),
    key: KEY, programId: FARM_PROGRAM,
  });
  assert.ok(r.ok, `evm stake ok: ${r.error || ""}`);
  CU.stake_evm = r.maxCu; CU.stake_evm_legs = r.legs;
  assert.equal(await bal(S.evmLp) + EVM_STAKE, before, "LP debited from external_auth ATA");
});

test("reward accrues proportionally; claim mints to BOTH lanes", async () => {
  // Reset both positions' debt at ~the same accumulator by claiming once, then
  // measure the reward minted over a fixed window with both staked (total
  // stable), so the delta is skew-free and reflects pure proportional accrual.
  const r0s = await execSolana({
    accounts: claimAccounts(S.solAuth, S.solStake, S.solReward), data: claimData(),
    programId: FARM_PROGRAM });
  assert.ok(r0s.ok);
  let evmStaked = false;
  if (KEY) {
    const r0e = await execEvmCpi({
      accounts: claimAccounts(S.evmAuth, S.evmStake, S.evmReward), data: claimData(),
      key: KEY, programId: FARM_PROGRAM });
    assert.ok(r0e.ok, `evm claim0 ok: ${r0e.error || ""}`);
    evmStaked = true;
  }
  const solR0 = await bal(S.solReward);
  const evmR0 = await bal(S.evmReward);

  await new Promise((res) => setTimeout(res, WAIT_MS));

  const r1s = await execSolana({
    accounts: claimAccounts(S.solAuth, S.solStake, S.solReward), data: claimData(),
    programId: FARM_PROGRAM });
  assert.ok(r1s.ok);
  CU.claim_sol = r1s.cu;
  const solDelta = (await bal(S.solReward)) - solR0;
  assert.ok(solDelta > 0n, `solana reward accrued over time (got ${solDelta})`);

  if (evmStaked) {
    const r1e = await execEvmCpi({
      accounts: claimAccounts(S.evmAuth, S.evmStake, S.evmReward), data: claimData(),
      key: KEY, programId: FARM_PROGRAM });
    assert.ok(r1e.ok, `evm claim1 ok: ${r1e.error || ""}`);
    CU.claim_evm = r1e.maxCu; CU.claim_evm_legs = r1e.legs;
    const evmDelta = (await bal(S.evmReward)) - evmR0;
    assert.ok(evmDelta > 0n, `evm reward minted to external_auth ATA (got ${evmDelta})`);
    // EVM staked 2× the Solana lane → ~2× the reward over the same window.
    const ratio = Number(evmDelta) / Number(solDelta);
    console.log(`\n  reward delta — solana ${solDelta} | evm ${evmDelta} | ratio ${ratio.toFixed(2)} (expect ~2.0)`);
    assert.ok(ratio > 1.5 && ratio < 2.6, `proportional to stake (ratio ${ratio.toFixed(2)})`);
  }
});

test("unstake returns LP on both lanes", async () => {
  const solBefore = await bal(S.solLp);
  const r = await execSolana({
    accounts: unstakeAccounts(S.solAuth, S.solStake, S.solLp), data: unstakeData(SOL_STAKE),
    programId: FARM_PROGRAM });
  assert.ok(r.ok);
  CU.unstake_sol = r.cu;
  assert.equal(await bal(S.solLp), solBefore + SOL_STAKE, "solana LP returned");

  if (KEY) {
    const evmBefore = await bal(S.evmLp);
    const re = await execEvmCpi({
      accounts: unstakeAccounts(S.evmAuth, S.evmStake, S.evmLp), data: unstakeData(EVM_STAKE),
      key: KEY, programId: FARM_PROGRAM });
    assert.ok(re.ok, `evm unstake ok: ${re.error || ""}`);
    CU.unstake_evm = re.maxCu; CU.unstake_evm_legs = re.legs;
    assert.equal(await bal(S.evmLp), evmBefore + EVM_STAKE, "evm LP returned to external_auth ATA");
  }

  console.log("\n  CU per lane (single-pass):", JSON.stringify(CU, null, 0));
});
