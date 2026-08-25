// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RomeDexRouter} from "../src/RomeDexRouter.sol";
import {StatefulCpiFixture, MockCpi} from "./StatefulCpiFixture.sol";

interface IVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function expectRevert(bytes4) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

interface IHelperView {
    function ata(address user, bytes32 mint) external view returns (bytes32);
}

/// The slippage-mirror fix — RomeDexRouter's `_swap` did not enforce the
/// bound the router itself encodes (unlike RomeClmmRouter, which mirrors the
/// on-chain program's guard as defense-in-depth). Trades were bounded ONLY
/// by the DEX program's own on-chain enforcement, making correctness of this
/// router's byte encoding a silent precondition for user safety.
///
/// These tests exercise the NEW dispatch in `_swap`: tag 0x01 (output bound,
/// `OutBelowMinimum`) and tag 0x06 (input bound, `InAboveMaximum`). They are
/// written RED-first — against a router that has neither error yet, this
/// file fails to COMPILE (the guard genuinely does not exist), which is
/// itself the RED signal for a Solidity custom-error check.
contract RomeDexRouterSlippageTest is StatefulCpiFixture {
    IVm constant vm = IVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    RomeDexRouter router;
    bytes32 constant DEX = bytes32(uint256(0xDE));
    bytes32 constant PID1 = bytes32(uint256(0x1111));
    bytes32 constant PID2 = bytes32(uint256(0x2222));
    bytes32 constant MINT_1A = bytes32(uint256(0xA1));
    bytes32 constant MINT_MID = bytes32(uint256(0xA2)); // pool1.mintB == pool2.mintA
    bytes32 constant MINT_2B = bytes32(uint256(0xA3));
    uint16 constant TOKEN_AMOUNT_OFFSET = 64;

    bytes32 constant SWAPPED_TOPIC0 = keccak256("Swapped(address,bytes32,bool,uint64,uint64)");

    function _accts(bytes32 id, bytes32 mintA, bytes32 mintB) internal pure returns (bytes32[7] memory a) {
        a[0] = id;
        a[1] = bytes32(uint256(id) + 1); // authority
        a[2] = bytes32(uint256(id) + 2); // vaultA
        a[3] = bytes32(uint256(id) + 3); // vaultB
        a[4] = bytes32(uint256(id) + 4); // poolMint
        a[5] = mintA;
        a[6] = mintB;
    }

    function setUp() public {
        _setupStatefulCpi();
        router = new RomeDexRouter(DEX);
        router.registerPool(PID1, _accts(PID1, MINT_1A, MINT_MID));
        router.registerPool(PID2, _accts(PID2, MINT_MID, MINT_2B));
    }

    function _credit(bytes32 acct, int256 delta) internal {
        MockCpi.Effect[] memory e = new MockCpi.Effect[](1);
        e[0] = MockCpi.Effect({acct: acct, offset: TOKEN_AMOUNT_OFFSET, delta: delta});
        cpi.queueBatch(e);
    }

    function _swappedAmountOut(IVm.Log[] memory logs) internal view returns (uint64 amountOut) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics.length == 3 && logs[i].topics[0] == SWAPPED_TOPIC0)
            {
                (,, uint64 out) = abi.decode(logs[i].data, (bool, uint64, uint64));
                return out;
            }
        }
        revert("Swapped not emitted");
    }

    // ── swap (tag 1, output bound) ───────────────────────────────────────────
    function test_swap_reverts_below_minOut() public {
        bytes32 dstAta = IHelperView(HELPER_ADDR).ata(address(this), MINT_MID);
        uint64 minOut = 1000;
        _credit(dstAta, int256(uint256(minOut)) - 1); // realized out = minOut - 1
        vm.expectRevert(RomeDexRouter.OutBelowMinimum.selector);
        router.swap(PID1, true, 500, minOut);
    }

    /// Boundary equality — kills both the `<`/`<=` mutant on the guard AND
    /// an inverted-delta mutant (`before - after` on this GROWING balance
    /// would underflow → panic 0x11, not a clean pass).
    function test_swap_passes_at_exact_minOut() public {
        bytes32 dstAta = IHelperView(HELPER_ADDR).ata(address(this), MINT_MID);
        uint64 minOut = 1000;
        _credit(dstAta, int256(uint256(minOut)));
        vm.recordLogs();
        router.swap(PID1, true, 500, minOut);
        require(_swappedAmountOut(vm.getRecordedLogs()) == minOut, "amountOut != minOut at boundary");
    }

    /// The event must report the REALIZED output, not just clear the bound.
    function test_swap_event_reports_realized_out() public {
        bytes32 dstAta = IHelperView(HELPER_ADDR).ata(address(this), MINT_MID);
        uint64 minOut = 1000;
        uint64 realized = 1777;
        _credit(dstAta, int256(uint256(realized)));
        vm.recordLogs();
        router.swap(PID1, true, 500, minOut);
        require(_swappedAmountOut(vm.getRecordedLogs()) == realized, "event did not report realized out");
    }

    // ── swapExactOut (tag 6, input bound) ────────────────────────────────────
    function test_swapExactOut_reverts_above_maxIn() public {
        bytes32 srcAta = IHelperView(HELPER_ADDR).ata(address(this), MINT_1A);
        uint64 maxIn = 1000;
        cpi.set(srcAta, TOKEN_AMOUNT_OFFSET, 5000);
        _credit(srcAta, -(int256(uint256(maxIn)) + 1)); // realized spend = maxIn + 1
        vm.expectRevert(RomeDexRouter.InAboveMaximum.selector);
        router.swapExactOut(PID1, true, 500, maxIn);
    }

    /// Boundary equality — kills the `>`/`>=` mutant AND an inverted-delta
    /// mutant (`after - before` on this SHRINKING balance would underflow).
    function test_swapExactOut_passes_at_exact_maxIn() public {
        bytes32 srcAta = IHelperView(HELPER_ADDR).ata(address(this), MINT_1A);
        uint64 maxIn = 1000;
        cpi.set(srcAta, TOKEN_AMOUNT_OFFSET, 5000);
        _credit(srcAta, -int256(uint256(maxIn)));
        router.swapExactOut(PID1, true, 500, maxIn); // must not revert
    }

    // ── route (tag 1 both hops; hop1 y=1, hop2 y=user minOut) ────────────────
    function test_route_finalHop_reverts_below_minOut() public {
        bytes32 midAta = IHelperView(HELPER_ADDR).ata(address(this), MINT_MID);
        bytes32 finalAta = IHelperView(HELPER_ADDR).ata(address(this), MINT_2B);
        uint64 minOut = 5000;
        _credit(midAta, 12345); // hop1 realized mid, well above the y=1 floor
        _credit(finalAta, int256(uint256(minOut)) - 1); // hop2 realized out
        vm.expectRevert(RomeDexRouter.OutBelowMinimum.selector);
        router.route(PID1, true, PID2, true, 1000, minOut);
    }

    /// hop1 uses y=1 internally (no user-expressed bound on the mid leg) —
    /// a realized mid of exactly 0 must still revert.
    function test_route_zeroMid_reverts() public {
        vm.expectRevert(RomeDexRouter.OutBelowMinimum.selector);
        router.route(PID1, true, PID2, true, 1000, 0); // mid stays 0 (no credit queued)
    }

    function test_route_secondHop_swaps_realized_mid() public {
        bytes32 midAta = IHelperView(HELPER_ADDR).ata(address(this), MINT_MID);
        bytes32 finalAta = IHelperView(HELPER_ADDR).ata(address(this), MINT_2B);
        uint64 mid = 12345;
        uint64 minOut = 5000;
        _credit(midAta, int256(uint256(mid)));
        _credit(finalAta, int256(uint256(minOut))); // clears the final-hop bound exactly
        router.route(PID1, true, PID2, true, 1000, minOut);
        bytes memory expected = abi.encodePacked(bytes1(0x01), _leTest(mid), _leTest(minOut));
        require(keccak256(cpi.recordedData(1)) == keccak256(expected), "hop2 did not swap the realized mid");
    }

    function _leTest(uint64 v) internal pure returns (bytes8 r) {
        v = ((v & 0xFF00FF00FF00FF00) >> 8) | ((v & 0x00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000) >> 16) | ((v & 0x0000FFFF0000FFFF) << 16);
        v = (v >> 32) | (v << 32);
        r = bytes8(v);
    }
}
