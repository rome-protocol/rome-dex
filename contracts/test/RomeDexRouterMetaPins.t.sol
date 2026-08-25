// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RomeDexRouter} from "../src/RomeDexRouter.sol";
import {StatefulCpiFixture, MockCpi} from "./StatefulCpiFixture.sol";

interface IHelperView {
    function ata(address user, bytes32 mint) external view returns (bytes32);
    function pda(address user) external view returns (bytes32);
}

/// SwapV2 account-list pins: count, exact pubkey
/// order, writability, and signer flags for every CPI path the router
/// builds. Enabled by StatefulCpiFixture's account recorder (MockCpi no
/// longer drops the `accounts` argument) — without it these lists were
/// reviewable but not testable.
///
/// No fee-slot pubkey may appear anywhere in this file's expectations —
/// the v2 program has no dedicated fee-LP account slot at all.
contract RomeDexRouterMetaPinsTest is StatefulCpiFixture {
    RomeDexRouter router;

    bytes32 constant TOKEN_PROGRAM = 0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9;

    bytes32 constant PID = bytes32(uint256(0x1111));
    bytes32 constant AUTHORITY = bytes32(uint256(0xB1));
    bytes32 constant VAULT_A = bytes32(uint256(0xB2));
    bytes32 constant VAULT_B = bytes32(uint256(0xB3));
    bytes32 constant POOL_MINT = bytes32(uint256(0xB4));
    bytes32 constant MINT_A = bytes32(uint256(0xA1));
    bytes32 constant MINT_B = bytes32(uint256(0xA2));

    bytes32 constant PID2 = bytes32(uint256(0x3333));
    bytes32 constant AUTHORITY2 = bytes32(uint256(0xE1));
    bytes32 constant VAULT_A2 = bytes32(uint256(0xE2));
    bytes32 constant VAULT_B2 = bytes32(uint256(0xE3));
    bytes32 constant POOL_MINT2 = bytes32(uint256(0xE4));
    bytes32 constant MINT_MID = MINT_B; // pool1.mintB == pool2.mintA for `route`
    bytes32 constant MINT_C = bytes32(uint256(0xA3));

    function setUp() public {
        _setupStatefulCpi();
        router = new RomeDexRouter(bytes32(uint256(0xDE)));
        bytes32[7] memory a;
        a[0] = PID;
        a[1] = AUTHORITY;
        a[2] = VAULT_A;
        a[3] = VAULT_B;
        a[4] = POOL_MINT;
        a[5] = MINT_A;
        a[6] = MINT_B;
        router.registerPool(PID, a);

        bytes32[7] memory b;
        b[0] = PID2;
        b[1] = AUTHORITY2;
        b[2] = VAULT_A2;
        b[3] = VAULT_B2;
        b[4] = POOL_MINT2;
        b[5] = MINT_MID; // mintA
        b[6] = MINT_C; // mintB
        router.registerPool(PID2, b);
    }

    // `HELPER.pda(address(this))` executes INSIDE the router, so
    // `address(this)` there is the router's own address, not the test
    // contract's — this mirrors that call site exactly.
    function _pdaSelf() internal view returns (bytes32) {
        return IHelperView(HELPER_ADDR).pda(address(router));
    }

    function _ata(bytes32 mint) internal view returns (bytes32) {
        return IHelperView(HELPER_ADDR).ata(address(this), mint);
    }

    function _assertMeta(uint256 call, uint256 i, bytes32 pubkey, bool signer, bool writable, string memory label)
        internal
        view
    {
        MockCpi.AccountMeta memory m = cpi.recordedAccountAt(call, i);
        require(m.pubkey == pubkey, string.concat(label, ": wrong pubkey"));
        require(m.is_signer == signer, string.concat(label, ": wrong signer flag"));
        require(m.is_writable == writable, string.concat(label, ": wrong writable flag"));
    }

    // ── swap (tag 1) — 13 metas, m[0] WRITABLE, no fee slot ──────────────────
    function test_swap_aToB_metaList() public {
        router.swap(PID, true, 500, 0);
        require(cpi.recordedAccountsCount(0) == 13, "swap: expected 13 metas");
        bytes32 srcAta = _ata(MINT_A);
        bytes32 dstAta = _ata(MINT_B);
        _assertMeta(0, 0, PID, false, true, "swap[0] pool");
        _assertMeta(0, 1, AUTHORITY, false, false, "swap[1] authority");
        _assertMeta(0, 2, _pdaSelf(), true, false, "swap[2] uta");
        _assertMeta(0, 3, srcAta, false, true, "swap[3] srcAta");
        _assertMeta(0, 4, VAULT_A, false, true, "swap[4] srcVault");
        _assertMeta(0, 5, VAULT_B, false, true, "swap[5] dstVault");
        _assertMeta(0, 6, dstAta, false, true, "swap[6] dstAta");
        _assertMeta(0, 7, POOL_MINT, false, true, "swap[7] poolMint");
        _assertMeta(0, 8, MINT_A, false, false, "swap[8] srcMint");
        _assertMeta(0, 9, MINT_B, false, false, "swap[9] dstMint");
        _assertMeta(0, 10, TOKEN_PROGRAM, false, false, "swap[10] srcProg");
        _assertMeta(0, 11, TOKEN_PROGRAM, false, false, "swap[11] dstProg");
        _assertMeta(0, 12, TOKEN_PROGRAM, false, false, "swap[12] poolProg");
    }

    /// Symmetric arm: bToA swaps src/dst vault + mint
    /// slots — a hardcoded-direction mutant reddens here, not in the aToB test.
    function test_swap_bToA_metaList() public {
        router.swap(PID, false, 500, 0);
        bytes32 srcAta = _ata(MINT_B);
        bytes32 dstAta = _ata(MINT_A);
        _assertMeta(0, 3, srcAta, false, true, "swap[3] srcAta (bToA)");
        _assertMeta(0, 4, VAULT_B, false, true, "swap[4] srcVault (bToA)");
        _assertMeta(0, 5, VAULT_A, false, true, "swap[5] dstVault (bToA)");
        _assertMeta(0, 6, dstAta, false, true, "swap[6] dstAta (bToA)");
        _assertMeta(0, 8, MINT_B, false, false, "swap[8] srcMint (bToA)");
        _assertMeta(0, 9, MINT_A, false, false, "swap[9] dstMint (bToA)");
    }

    // ── swapExactOut (tag 6) — same 13-meta shape ────────────────────────────
    function test_swapExactOut_metaList() public {
        router.swapExactOut(PID, true, 500, 100_000);
        require(cpi.recordedAccountsCount(0) == 13, "swapExactOut: expected 13 metas");
        _assertMeta(0, 0, PID, false, true, "swapExactOut[0] pool");
        _assertMeta(0, 8, MINT_A, false, false, "swapExactOut[8] srcMint");
        _assertMeta(0, 9, MINT_B, false, false, "swapExactOut[9] dstMint");
    }

    // ── removeLiquidity (tag 3) — 14 metas, RO pool, no fee slot ─────────────
    function test_removeLiquidity_metaList() public {
        router.removeLiquidity(PID, 100, 0, 0);
        require(cpi.recordedAccountsCount(0) == 14, "removeLiquidity: expected 14 metas");
        _assertMeta(0, 0, PID, false, false, "withdraw[0] pool RO");
        _assertMeta(0, 1, AUTHORITY, false, false, "withdraw[1] authority");
        _assertMeta(0, 2, _pdaSelf(), true, false, "withdraw[2] uta");
        _assertMeta(0, 3, POOL_MINT, false, true, "withdraw[3] poolMint");
        _assertMeta(0, 4, _ata(POOL_MINT), false, true, "withdraw[4] userLp");
        _assertMeta(0, 5, VAULT_A, false, true, "withdraw[5] vaultA");
        _assertMeta(0, 6, VAULT_B, false, true, "withdraw[6] vaultB");
        _assertMeta(0, 7, _ata(MINT_A), false, true, "withdraw[7] userA");
        _assertMeta(0, 8, _ata(MINT_B), false, true, "withdraw[8] userB");
        _assertMeta(0, 9, MINT_A, false, false, "withdraw[9] mintA");
        _assertMeta(0, 10, MINT_B, false, false, "withdraw[10] mintB");
        _assertMeta(0, 11, TOKEN_PROGRAM, false, false, "withdraw[11] poolProg");
        _assertMeta(0, 12, TOKEN_PROGRAM, false, false, "withdraw[12] tokenAProg");
        _assertMeta(0, 13, TOKEN_PROGRAM, false, false, "withdraw[13] tokenBProg");
    }

    // ── addLiquidity (tag 2) — 14 metas, UNCHANGED shape, EVERY position pinned
    // (a mutant swapping m[3]/m[4] user-A/B ATAs, or m[9]/m[10] mints, survived
    // the old count+3-index-only assertions — completed per the withdraw/swap
    // full-pin pattern).
    function test_addLiquidity_metaList() public {
        router.addLiquidity(PID, 100, 1000, 1000);
        require(cpi.recordedAccountsCount(0) == 14, "addLiquidity: expected 14 metas");
        _assertMeta(0, 0, PID, false, false, "deposit[0] pool RO");
        _assertMeta(0, 1, AUTHORITY, false, false, "deposit[1] authority");
        _assertMeta(0, 2, _pdaSelf(), true, false, "deposit[2] uta");
        _assertMeta(0, 3, _ata(MINT_A), false, true, "deposit[3] userA");
        _assertMeta(0, 4, _ata(MINT_B), false, true, "deposit[4] userB");
        _assertMeta(0, 5, VAULT_A, false, true, "deposit[5] vaultA");
        _assertMeta(0, 6, VAULT_B, false, true, "deposit[6] vaultB");
        _assertMeta(0, 7, POOL_MINT, false, true, "deposit[7] poolMint");
        _assertMeta(0, 8, _ata(POOL_MINT), false, true, "deposit[8] userLp");
        _assertMeta(0, 9, MINT_A, false, false, "deposit[9] mintA");
        _assertMeta(0, 10, MINT_B, false, false, "deposit[10] mintB");
        _assertMeta(0, 11, TOKEN_PROGRAM, false, false, "deposit[11] tokenAProg");
        _assertMeta(0, 12, TOKEN_PROGRAM, false, false, "deposit[12] tokenBProg");
        _assertMeta(0, 13, TOKEN_PROGRAM, false, false, "deposit[13] poolProg");
    }

    // ── zapIn's deposit leg (_deposit, tag 2) — same 14-meta shape, fully pinned
    function test_zapIn_depositLeg_metaList() public {
        // The swap leg's internal exact-in bound is y=1 — queue a credit so
        // the realized output clears it and zapIn reaches the deposit CPI.
        bytes32 outAta = _ata(MINT_B);
        MockCpi.Effect[] memory swapEffect = new MockCpi.Effect[](1);
        swapEffect[0] = MockCpi.Effect({acct: outAta, offset: 64, delta: 100});
        cpi.queueBatch(swapEffect);
        cpi.set(POOL_MINT, 36, 1); // pool-mint supply, so lp math doesn't divide oddly
        cpi.set(VAULT_B, 64, 1_000_000); // vault big enough that lp stays > 0

        router.zapIn(PID, true, 500, 0, 10_000);
        require(cpi.recordedAccountsCount(1) == 14, "zapIn deposit leg: expected 14 metas");
        _assertMeta(1, 0, PID, false, false, "zapIn-deposit[0] pool RO");
        _assertMeta(1, 1, AUTHORITY, false, false, "zapIn-deposit[1] authority");
        _assertMeta(1, 2, _pdaSelf(), true, false, "zapIn-deposit[2] uta");
        _assertMeta(1, 3, _ata(MINT_A), false, true, "zapIn-deposit[3] userA");
        _assertMeta(1, 4, _ata(MINT_B), false, true, "zapIn-deposit[4] userB");
        _assertMeta(1, 5, VAULT_A, false, true, "zapIn-deposit[5] vaultA");
        _assertMeta(1, 6, VAULT_B, false, true, "zapIn-deposit[6] vaultB");
        _assertMeta(1, 7, POOL_MINT, false, true, "zapIn-deposit[7] poolMint");
        _assertMeta(1, 8, _ata(POOL_MINT), false, true, "zapIn-deposit[8] userLp");
        _assertMeta(1, 9, MINT_A, false, false, "zapIn-deposit[9] mintA");
        _assertMeta(1, 10, MINT_B, false, false, "zapIn-deposit[10] mintB");
        _assertMeta(1, 11, TOKEN_PROGRAM, false, false, "zapIn-deposit[11] tokenAProg");
        _assertMeta(1, 12, TOKEN_PROGRAM, false, false, "zapIn-deposit[12] tokenBProg");
        _assertMeta(1, 13, TOKEN_PROGRAM, false, false, "zapIn-deposit[13] poolProg");
    }

    // ── route — both hops carry the swap-path 13-meta shape ─────────────────
    function test_route_bothHops_metaList() public {
        // hop1's internal exact-in bound is y=1 — queue a mid-hop credit so
        // route reaches the second CPI at all.
        bytes32 midAta = _ata(MINT_MID);
        MockCpi.Effect[] memory hop1Effect = new MockCpi.Effect[](1);
        hop1Effect[0] = MockCpi.Effect({acct: midAta, offset: 64, delta: 100});
        cpi.queueBatch(hop1Effect);

        router.route(PID, true, PID2, true, 500, 0);
        require(cpi.recordedAccountsCount(0) == 13, "route hop1: expected 13 metas");
        require(cpi.recordedAccountsCount(1) == 13, "route hop2: expected 13 metas");
        _assertMeta(0, 0, PID, false, true, "route hop1[0] pool");
        _assertMeta(1, 0, PID2, false, true, "route hop2[0] pool");
        _assertMeta(1, 4, VAULT_A2, false, true, "route hop2[4] srcVault");
        _assertMeta(1, 5, VAULT_B2, false, true, "route hop2[5] dstVault");
    }
}
