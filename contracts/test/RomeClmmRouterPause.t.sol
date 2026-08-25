// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RomeClmmRouter} from "../src/RomeClmmRouter.sol";
import {PauseFixture} from "./PauseFixture.sol";

// Minimal foundry cheatcode surface (avoids an external forge-std dependency).
interface IVm {
    function prank(address) external;
    function expectRevert(bytes4) external;
}

/// Pause + unregister security fix, mirrored onto the CLMM swap
/// router. Unlike RomeDexRouter, this contract exposes exactly one trading
/// function (swap) — liquidity ops stay on the direct CPI-precompile path
/// (see the contract's SCOPE note) — so there is a single pause-blocks-swap
/// test rather than one per function.
contract RomeClmmRouterPauseTest is PauseFixture {
    IVm constant vm = IVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    RomeClmmRouter router;
    bytes32 constant CLMM = bytes32(uint256(0xC1));
    address constant alice = address(0xA11CE);
    address constant bob = address(0xB0B);
    address constant multisig = address(0xACE);
    bytes32 constant PID = bytes32(uint256(0x1111));
    bytes32 constant PID2 = bytes32(uint256(0x2222));

    function _accts(bytes32 id) internal pure returns (bytes32[5] memory a) {
        a[0] = id;
        for (uint256 i = 1; i < 5; i++) a[i] = bytes32(uint256(id) + i);
    }

    function _oneTickArray() internal pure returns (bytes32[] memory t) {
        t = new bytes32[](1);
        t[0] = bytes32(uint256(0x7777));
    }

    function setUp() public {
        router = new RomeClmmRouter(CLMM);
        router.registerPool(PID, _accts(PID));
    }

    // ── pause blocks the one trading path — NO mocks. Pass a VALID 1-entry
    // tickArrays window so the pin is Paused, not NoTickArrays (that guard
    // runs before _pool, so an invalid window would mask what we're testing).
    function test_pause_blocks_swap() public {
        router.pause();
        vm.expectRevert(RomeClmmRouter.Paused.selector);
        router.swap(PID, true, 100, 0, 0, _oneTickArray());
    }

    function test_pause_and_unknownPool_revertsPaused() public {
        router.pause();
        vm.expectRevert(RomeClmmRouter.Paused.selector);
        router.swap(PID2, true, 100, 0, 0, _oneTickArray());
    }

    function test_unpause_restores_swap() public {
        _mockPrecompiles();
        router.pause();
        router.unpause();
        // minOut=0 — the mock balance is constant, so realized out is 0, and
        // the router's own defense-in-depth OutBelowMinimum check
        // (out < minOut) must not fire.
        uint64 out = router.swap(PID, true, 100, 0, 0, _oneTickArray());
        require(out == 0, "expected out 0 (constant mock balance)");
    }

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
        vm.expectRevert(RomeClmmRouter.NotOwner.selector);
        router.unpause();
    }

    function test_nonPauser_cannot_pause() public {
        vm.prank(bob);
        vm.expectRevert(RomeClmmRouter.NotPauser.selector);
        router.pause();
    }

    function test_setPauser_rotation_and_zero() public {
        router.setPauser(alice);
        vm.prank(alice);
        router.pause();
        require(router.paused(), "alice should have been able to pause");
        router.unpause();

        router.setPauser(bob);
        vm.prank(alice);
        vm.expectRevert(RomeClmmRouter.NotPauser.selector);
        router.pause();

        router.setPauser(address(0));
        vm.prank(bob);
        vm.expectRevert(RomeClmmRouter.NotPauser.selector);
        router.pause();

        // owner can still pause directly regardless of pauser state.
        router.pause();
        require(router.paused(), "owner pause had no effect");
    }

    function test_freeze_does_NOT_stop_trading() public {
        _mockPrecompiles();
        router.freeze();
        uint64 out = router.swap(PID, true, 100, 0, 0, _oneTickArray());
        require(out == 0, "swap should have completed while frozen");
    }

    function test_freeze_blocks_register_and_unregister() public {
        router.freeze();
        vm.expectRevert(RomeClmmRouter.Frozen.selector);
        router.registerPool(PID2, _accts(PID2));
        vm.expectRevert(RomeClmmRouter.Frozen.selector);
        router.unregisterPool(PID);
    }

    function test_unregister_then_reregister() public {
        router.unregisterPool(PID);
        (bytes32 pool,,,,) = router.pools(PID);
        require(pool == 0, "row not cleared");

        bytes32[5] memory fresh = _accts(PID);
        fresh[1] = bytes32(uint256(0x9999));
        router.registerPool(PID, fresh);
        (bytes32 pool2, bytes32 vault0,,,) = router.pools(PID);
        require(pool2 == PID, "re-registration failed");
        require(vault0 == bytes32(uint256(0x9999)), "auxiliary account not updated");
    }

    function test_unregister_unknown_reverts() public {
        vm.expectRevert(RomeClmmRouter.NotRegistered.selector);
        router.unregisterPool(PID2);
    }

    function test_unregister_nonOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert(RomeClmmRouter.NotOwner.selector);
        router.unregisterPool(PID);
    }

    function test_admin_available_while_paused() public {
        router.pause();
        router.registerPool(PID2, _accts(PID2));
        router.unregisterPool(PID2);
        router.setPauser(alice);
        router.freeze();
    }

    function test_pause_during_pendingOwnership() public {
        router.transferOwnership(multisig);

        router.pause();
        require(router.paused(), "owner pause failed pre-transfer");
        router.unpause();

        router.setPauser(alice);
        vm.prank(alice);
        router.pause();
        require(router.paused(), "pauser pause failed pre-transfer");
        router.unpause();

        vm.prank(multisig);
        vm.expectRevert(RomeClmmRouter.NotPauser.selector);
        router.pause();

        vm.prank(multisig);
        vm.expectRevert(RomeClmmRouter.NotOwner.selector);
        router.unpause();

        vm.prank(multisig);
        router.acceptOwnership();

        vm.prank(alice);
        router.pause();
        require(router.paused(), "pauser pause failed post-transfer");
        vm.prank(multisig);
        router.unpause();
        require(!router.paused(), "new owner unpause failed post-transfer");

        vm.prank(alice);
        router.pause();
        vm.expectRevert(RomeClmmRouter.NotOwner.selector);
        router.unpause(); // called as address(this), the old owner
    }
}
