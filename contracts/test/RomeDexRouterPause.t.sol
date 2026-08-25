// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RomeDexRouter} from "../src/RomeDexRouter.sol";
import {PauseFixture} from "./PauseFixture.sol";

// Minimal foundry cheatcode surface (avoids an external forge-std dependency,
// mirrors the governance suite's IVm plus recordLogs/getRecordedLogs so the
// two completion-path tests can pin the emitted Swapped event without
// needing expectEmit's exact selector).
interface IVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address) external;
    function expectRevert(bytes4) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// Pause + unregister security fix. Before this, `frozen` was
/// read exactly once, in registerPool — no trading function checked
/// anything, so a trading-path bug left the operator with no lever short of
/// asking every user to revoke their standing SPL delegation (the contract
/// is not upgradeable). These tests pin:
///   - the new `_pool` chokepoint: every trading path resolves its pool
///     there, before any CPI, so pause() blocks all six without touching
///     each function individually;
///   - the pauser/owner admin surface (rotation, idempotence, owner-only
///     unpause);
///   - that freeze() (registry lock) and pause() (trading kill switch) are
///     independent — the bug this fix corrects was freeze() being mistaken
///     for a trading stop;
///   - reusable pool ids via unregisterPool/registerPool.
contract RomeDexRouterPauseTest is PauseFixture {
    IVm constant vm = IVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    RomeDexRouter router;
    bytes32 constant DEX = bytes32(uint256(0xDE));
    address constant alice = address(0xA11CE);
    address constant bob = address(0xB0B);
    address constant multisig = address(0xACE);
    bytes32 constant PID = bytes32(uint256(0x1111));
    bytes32 constant PID2 = bytes32(uint256(0x2222));

    bytes32 constant SWAPPED_TOPIC0 = keccak256("Swapped(address,bytes32,bool,uint64,uint64)");

    function _accts(bytes32 id) internal pure returns (bytes32[7] memory a) {
        a[0] = id; // registerPool requires a[0] == id
        for (uint256 i = 1; i < 7; i++) a[i] = bytes32(uint256(id) + i);
    }

    function setUp() public {
        router = new RomeDexRouter(DEX);
        router.registerPool(PID, _accts(PID));
    }

    /// Scans recorded logs for this test's Swapped event and returns its
    /// (non-indexed) amountOut. Reverts via require if none is found, which
    /// is itself a useful failure mode (proves the call didn't emit it).
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

    // ── 1-6: pause blocks every trading path — NO mocks. The revert fires in
    // `_pool` before any precompile call, so the mock-free revert is itself
    // proof no CPI is reached. One test per function, not folded. ─────────
    function test_pause_blocks_swap() public {
        router.pause();
        vm.expectRevert(RomeDexRouter.Paused.selector);
        router.swap(PID, true, 100, 0);
    }

    function test_pause_blocks_swapExactOut() public {
        router.pause();
        vm.expectRevert(RomeDexRouter.Paused.selector);
        router.swapExactOut(PID, true, 100, 1000);
    }

    function test_pause_blocks_addLiquidity() public {
        router.pause();
        vm.expectRevert(RomeDexRouter.Paused.selector);
        router.addLiquidity(PID, 100, 1000, 1000);
    }

    function test_pause_blocks_removeLiquidity() public {
        router.pause();
        vm.expectRevert(RomeDexRouter.Paused.selector);
        router.removeLiquidity(PID, 100, 0, 0);
    }

    function test_pause_blocks_zapIn() public {
        router.pause();
        vm.expectRevert(RomeDexRouter.Paused.selector);
        router.zapIn(PID, true, 100, 0, 1000);
    }

    function test_pause_blocks_route() public {
        router.registerPool(PID2, _accts(PID2));
        router.pause();
        vm.expectRevert(RomeDexRouter.Paused.selector);
        router.route(PID, true, PID2, true, 100, 0);
    }

    /// Ordering pin: paused + unknown id must revert Paused, not UnknownPool
    /// — the pause check runs FIRST inside _pool.
    function test_pause_and_unknownPool_revertsPaused() public {
        router.pause();
        vm.expectRevert(RomeDexRouter.Paused.selector);
        router.swap(PID2, true, 100, 0); // PID2 was never registered
    }

    // ── 7: unpause restores trading ─────────────────────────────────────────
    function test_unpause_restores_swap() public {
        _mockPrecompiles();
        router.pause();
        router.unpause();
        vm.recordLogs();
        router.swap(PID, true, 100, 0);
        uint64 out = _swappedAmountOut(vm.getRecordedLogs());
        require(out == 0, "expected amountOut 0 (constant mock balance)");
    }

    // ── 8-11: pauser / owner access control + idempotence ──────────────────
    function test_pauser_can_pause() public {
        router.setPauser(alice);
        vm.prank(alice);
        router.pause();
        require(router.paused(), "pauser pause had no effect");
    }

    function test_pauser_cannot_unpause() public {
        router.setPauser(alice);
        vm.prank(alice);
        router.pause();
        vm.prank(alice);
        vm.expectRevert(RomeDexRouter.NotOwner.selector);
        router.unpause();
    }

    function test_nonPauser_cannot_pause() public {
        // pauser is unset (zero); bob is neither owner nor pauser.
        vm.prank(bob);
        vm.expectRevert(RomeDexRouter.NotPauser.selector);
        router.pause();
    }

    function test_owner_can_pause_directly() public {
        router.pause();
        require(router.paused(), "owner pause had no effect");
        // idempotence pin: a second pause must not revert.
        router.pause();
        require(router.paused(), "second pause disturbed state");
    }

    // ── 12-13: pauser rotation ───────────────────────────────────────────────
    function test_setPauser_rotation() public {
        router.setPauser(alice);
        vm.prank(alice);
        router.pause();
        require(router.paused(), "alice should have been able to pause");
        router.unpause();

        router.setPauser(bob);
        // alice is no longer the pauser.
        vm.prank(alice);
        vm.expectRevert(RomeDexRouter.NotPauser.selector);
        router.pause();

        vm.prank(bob);
        router.pause();
        require(router.paused(), "bob should have been able to pause");

        vm.prank(alice);
        vm.expectRevert(RomeDexRouter.NotOwner.selector);
        router.setPauser(alice);
    }

    function test_zeroPauser_disables() public {
        router.setPauser(alice);
        router.setPauser(address(0));
        vm.prank(alice);
        vm.expectRevert(RomeDexRouter.NotPauser.selector);
        router.pause();
    }

    // ── 14-15: freeze vs pause are independent ───────────────────────────────
    /// The semantic pin that kills the false ":94-95" comment: freeze() locks
    /// the REGISTRY, it does not stop trading.
    function test_freeze_does_NOT_stop_trading() public {
        _mockPrecompiles();
        router.freeze();
        vm.recordLogs();
        router.swap(PID, true, 100, 0);
        uint64 out = _swappedAmountOut(vm.getRecordedLogs());
        require(out == 0, "swap should have completed while frozen");
    }

    function test_freeze_blocks_register_and_unregister() public {
        router.freeze();
        vm.expectRevert(RomeDexRouter.Frozen.selector);
        router.registerPool(PID2, _accts(PID2));
        vm.expectRevert(RomeDexRouter.Frozen.selector);
        router.unregisterPool(PID);
    }

    // ── 16-17: reusable pool ids ─────────────────────────────────────────────
    function test_unregister_then_reregister() public {
        router.unregisterPool(PID);
        (bytes32 swapState,,,,,,) = router.pools(PID);
        require(swapState == 0, "row not cleared");

        bytes32[7] memory fresh = _accts(PID);
        fresh[1] = bytes32(uint256(0x9999)); // different auxiliary account
        router.registerPool(PID, fresh);
        (bytes32 swapState2, bytes32 authority,,,,,) = router.pools(PID);
        require(swapState2 == PID, "re-registration failed");
        require(authority == bytes32(uint256(0x9999)), "auxiliary account not updated");
    }

    function test_unregister_unknown_reverts() public {
        vm.expectRevert(RomeDexRouter.NotRegistered.selector);
        router.unregisterPool(PID2);
    }

    function test_unregister_nonOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert(RomeDexRouter.NotOwner.selector);
        router.unregisterPool(PID);
    }

    // ── 18: admin ops stay available while paused ────────────────────────────
    function test_admin_available_while_paused() public {
        router.pause();
        router.registerPool(PID2, _accts(PID2));
        router.unregisterPool(PID2);
        router.setPauser(alice);
        router.freeze();
    }

    // ── 19: pause access rights survive a pending ownership transfer ────────
    function test_pause_during_pendingOwnership() public {
        router.transferOwnership(multisig);

        // owner (still address(this)) can pause/unpause while a transfer is
        // pending.
        router.pause();
        require(router.paused(), "owner pause failed pre-transfer");
        router.unpause();
        require(!router.paused(), "owner unpause failed pre-transfer");

        // pauser can pause.
        router.setPauser(alice);
        vm.prank(alice);
        router.pause();
        require(router.paused(), "pauser pause failed pre-transfer");
        router.unpause();

        // pendingOwner can do neither.
        vm.prank(multisig);
        vm.expectRevert(RomeDexRouter.NotPauser.selector);
        router.pause();

        vm.prank(multisig);
        vm.expectRevert(RomeDexRouter.NotOwner.selector);
        router.unpause();

        // accept ownership.
        vm.prank(multisig);
        router.acceptOwnership();

        // new owner (multisig) can unpause; pause first via the pauser.
        vm.prank(alice);
        router.pause();
        require(router.paused(), "pauser pause failed post-transfer");
        vm.prank(multisig);
        router.unpause();
        require(!router.paused(), "new owner unpause failed post-transfer");

        // old owner (address(this)) has lost owner-only rights entirely.
        vm.prank(alice);
        router.pause();
        vm.expectRevert(RomeDexRouter.NotOwner.selector);
        router.unpause(); // called as address(this) — msg.sender has no prank
    }
}
