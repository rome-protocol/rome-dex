// helper-abi.test.mjs — OFFLINE guard: every HelperProgram signature the app
// declares must be a selector the deployed HelperProgram actually dispatches.
//
// Why: the EVM lane encodes precompile calls from hand-written ABI strings; a
// signature that LOOKS right but never existed fails only at runtime with
// "method is not supported by HelperProgram 0x…" (exactly how the live
// create-pool break shipped — 0x8b0caf87). This test computes the selector of
// every "function …" string in any app/lib file that targets the HELPER
// precompile and asserts membership in the known dispatch table.
//
// KNOWN set source: the HelperProgram dispatch table.
// If HelperProgram gains a method, add its selector here deliberately.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(DIR, "..", "app", "lib");

// program/src/non_evm/helper.rs selector table (deployed surface).
const KNOWN_HELPER_SELECTORS = new Set([
  "0x5a7c3259", // create_ata(address)
  "0x3de2251a", // create_ata(address,bytes32)
  "0xd258a69d", // create_ata_for_key(bytes32,bytes32)
  "0x7881d453", // approve_spl_raw_delegate(bytes32,bytes32,uint64,bytes32,uint8)
  "0xe97d3291", // create_mint_account(bytes32)
  "0x4f75e987", // init_spl_mint(bytes32,uint8,bytes32,bool,bytes32)
  "0x20972d0f", // create_and_init_mint(uint8,bytes32,bool,bytes32,bytes32)
  "0xff3556ca", // create_pda(address)
  "0x58e88298", // create_pda(address,uint64)
  "0x6e3f24e0", // swap_gas_to_lamports(uint64)
  "0x5fe71665", // transfer_lamports(address,uint64)
  "0xb12be5ba", // transfer_spl(address,uint64)
  "0xba3a5eac", // transfer_spl(bytes32,uint64)
  "0x53b505e0", // transfer_spl(address,uint64,bytes32)
  "0xb6977879", // transfer_spl(bytes32,uint64,bytes32)
  "0x766b362a", // transfer_spl(bytes32,bytes32,uint64,bytes32)  (from_ata)
  "0xe479df56", // transfer_spl(address,address,uint64,bytes32)
  "0x46efa679", // transfer_spl_to_signer(uint64,bytes32)
  "0x8854a299", // pda(address)
  "0x31db4f82", // ata(address)
  "0xfeb1c647", // ata(address,bytes32)
  "0x4479b709", // deposit_from_ata(uint256)
  "0xabf6f675", // approve_spl(address,uint64,bytes32)
  "0xd795522b", // mint_spl(address,uint64,bytes32)
  "0xdd0119c8", // user_balance(address,bytes32)
  "0xed72dbc8", // allowance_of(address,address,bytes32)
]);

const HELPER_ADDR_RE = /0xff0{37}9/i; // the HELPER precompile constant (0xff…09), any casing
const FN_STRING_RE = /"function\s+([a-z_0-9]+\([^"]*\))"/g;

// HelperProgram method NAMES — a declared function with one of these names must
// match a real overload exactly. Other names in the same file (router-contract
// ABIs, the CPI precompile's `invoke`) are out of scope.
const HELPER_METHOD_NAMES = new Set([
  "create_ata", "create_ata_for_key", "create_pda", "swap_gas_to_lamports",
  "transfer_lamports", "transfer_spl", "transfer_spl_to_signer",
  "approve_spl", "approve_spl_raw_delegate", "mint_spl",
  "create_mint_account", "init_spl_mint", "create_and_init_mint",
  "pda", "ata", "deposit_from_ata", "user_balance", "allowance_of",
]);

test("every HELPER signature the app declares is a real deployed selector", () => {
  const offenders = [];
  let checked = 0;
  for (const f of fs.readdirSync(LIB).filter((n) => n.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(LIB, f), "utf8");
    if (!HELPER_ADDR_RE.test(src)) continue; // file never targets the HELPER
    for (const m of src.matchAll(FN_STRING_RE)) {
      const sig = `function ${m[1]}`;
      let frag;
      try { frag = ethers.FunctionFragment.from(sig); } catch { continue; } // non-ABI string
      if (!HELPER_METHOD_NAMES.has(frag.name)) continue; // not a HelperProgram call
      checked += 1;
      if (!KNOWN_HELPER_SELECTORS.has(frag.selector)) {
        offenders.push(`app/lib/${f}: "${frag.format("full")}" → ${frag.selector} is NOT a HelperProgram method`);
      }
    }
  }
  assert.ok(checked >= 5, `guard scanned too few signatures (${checked}) — extraction regex broke?`);
  assert.deepEqual(offenders, [], `unknown HelperProgram selectors:\n  ${offenders.join("\n  ")}`);
  console.log(`  ${checked} HELPER signatures across app/lib all resolve to deployed selectors`);
});
