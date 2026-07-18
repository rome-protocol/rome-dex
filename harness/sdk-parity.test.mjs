// SDK parity gate — proves @rome-protocol/sdk is a byte-identical drop-in for
// rome-dex's inline PDA / ATA / CPI-encode surface (app/lib/walletActions.ts).
// Offline: no chain, no key. Run: node --import tsx --test sdk-parity.test.mjs
//
// This gates the dogfood swap. The load-bearing assertion is the last one:
// the SDK encodes invoke() calldata with viem; rome-dex encodes it with ethers.
// If those bytes ever diverge, the swap is unsafe and this goes RED.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ethers } from "ethers";
import {
  deriveAuthorityPda,
  deriveAta,
  pubkeyToBytes32,
  encodeInvoke,
  u64Le,
  padRomeGas,
} from "@rome-protocol/sdk";

// ---- fixtures ----
const EOA = "0x1234567890123456789012345678901234567890";
const ROME_EVM = "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf"; // Hadrian primary
const MINT = new PublicKey("So11111111111111111111111111111111111111112"); // wSOL
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// ---- inline reference: rome-dex app/lib/walletActions.ts logic, verbatim ----
const inlineEvmPda = (eoa, prog) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("EXTERNAL_AUTHORITY"), Buffer.from(eoa.slice(2), "hex")],
    new PublicKey(prog),
  )[0];
const inlineAta = (owner, mint) =>
  getAssociatedTokenAddress(mint, owner, true, TOKEN_PROGRAM_ID, ATA_PROGRAM);
const b32 = (pk) => "0x" + Buffer.from(pk.toBuffer()).toString("hex");
const inlineU64le = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const swapExactInData = (a, m) =>
  Buffer.concat([Buffer.from([1]), inlineU64le(a), inlineU64le(m)]);
const cpiIface = new ethers.Interface([
  "function invoke(bytes32 program,(bytes32,bool,bool)[] accounts,bytes data)",
]);
const inlineCalldata = (accounts, data, program) => {
  const accs = accounts.map((a) => [b32(a.pubkey), a.isSigner, a.isWritable]);
  return cpiIface.encodeFunctionData("invoke", [b32(program), accs, "0x" + data.toString("hex")]);
};
const toHex = (x) =>
  typeof x === "string" ? x.replace(/^0x/, "").toLowerCase() : Buffer.from(x).toString("hex");

test("deriveAuthorityPda == inline evmPdaFor", () => {
  assert.equal(
    deriveAuthorityPda(EOA, ROME_EVM).toBase58(),
    inlineEvmPda(EOA, ROME_EVM).toBase58(),
  );
});

test("deriveAta == inline ataFor (allowOwnerOffCurve for PDA owners)", async () => {
  const owner = deriveAuthorityPda(EOA, ROME_EVM);
  assert.equal(deriveAta(owner, MINT).toBase58(), (await inlineAta(owner, MINT)).toBase58());
});

test("pubkeyToBytes32 == inline b32", () => {
  const pk = deriveAuthorityPda(EOA, ROME_EVM);
  assert.equal(pubkeyToBytes32(pk), b32(pk));
});

test("u64Le == inline u64le (LE, full u64 range)", () => {
  for (const v of [0n, 1n, 1000n, 2n ** 63n, 18446744073709551615n]) {
    assert.equal(toHex(u64Le(v)), inlineU64le(v).toString("hex"));
  }
});

test("padRomeGas == inline estimate ×1.3 (13n/10n), full range", () => {
  for (const v of [0n, 1n, 21_000n, 1_480_000n, 200_000_000n]) {
    assert.equal(padRomeGas(v), (v * 13n) / 10n);
  }
});

test("encodeInvoke (viem) == inline buildEvmCalldata (ethers), byte-for-byte", () => {
  const program = new PublicKey(new Uint8Array(32).fill(9));
  const accounts = Array.from({ length: 14 }, (_, i) => ({
    pubkey: new PublicKey(new Uint8Array(32).fill(i + 1)),
    isSigner: i === 2, // user_transfer_authority is the signer at index 2
    isWritable: i >= 3 && i <= 8, // the mutable swap accounts
  }));
  const data = swapExactInData(1000n, 900n);
  const sdkHex = encodeInvoke(program, accounts, "0x" + data.toString("hex"));
  const inlineHex = inlineCalldata(accounts, data, program);
  assert.equal(sdkHex, inlineHex);
});
