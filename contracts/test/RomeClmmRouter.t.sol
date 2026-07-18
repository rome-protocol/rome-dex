// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RomeClmmRouter} from "../src/RomeClmmRouter.sol";

// Minimal foundry cheatcode surface (avoids an external forge-std dependency).
interface IVm {
    function prank(address) external;
    function expectRevert(bytes4) external;
}

// Governance / registry unit tests for the CLMM swap router. Exercise only
// pure storage + access-control + parameter-guard paths — no Rome precompiles —
// so they run in plain forge. The swap path itself is covered on-chain by
// harness/clmm.test.mjs (EVM-lane router swap).
contract RomeClmmRouterGovernanceTest {
    IVm constant vm = IVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    RomeClmmRouter router;
    bytes32 constant CLMM = bytes32(uint256(0xC1));
    address constant alice = address(0xA11CE);
    address constant multisig = address(0xACE);
    bytes32 constant PID = bytes32(uint256(0x1111));
    bytes32 constant PID2 = bytes32(uint256(0x2222));

    function _accts(bytes32 id) internal pure returns (bytes32[5] memory a) {
        a[0] = id; // registerPool requires a[0] == id
        for (uint256 i = 1; i < 5; i++) a[i] = bytes32(uint256(id) + i);
    }

    function setUp() public {
        router = new RomeClmmRouter(CLMM);
    }

    function test_registerPool_ownerCanAddNew() public {
        router.registerPool(PID, _accts(PID));
        (bytes32 pool,,,,) = router.pools(PID);
        require(pool == PID, "not registered");
    }

    function test_registerPool_nonOwnerReverts() public {
        vm.prank(alice);
        vm.expectRevert(RomeClmmRouter.NotOwner.selector);
        router.registerPool(PID, _accts(PID));
    }

    function test_registerPool_overwriteReverts() public {
        router.registerPool(PID, _accts(PID));
        vm.expectRevert(RomeClmmRouter.AlreadyRegistered.selector);
        router.registerPool(PID, _accts(PID));
    }

    function test_registerPool_idMismatchReverts() public {
        bytes32[5] memory a = _accts(PID);
        a[0] = PID2; // a[0] must equal id
        vm.expectRevert(RomeClmmRouter.BadRegistration.selector);
        router.registerPool(PID, a);
    }

    function test_registerPool_frozenReverts() public {
        router.freeze();
        vm.expectRevert(RomeClmmRouter.Frozen.selector);
        router.registerPool(PID, _accts(PID));
    }

    function test_transferOwnership_twoStep() public {
        router.transferOwnership(multisig);
        require(router.owner() == address(this), "owner changed early");
        require(router.pendingOwner() == multisig, "no pending");
        vm.prank(multisig);
        router.acceptOwnership();
        require(router.owner() == multisig, "owner not moved");
        require(router.pendingOwner() == address(0), "pending not cleared");
    }

    function test_acceptOwnership_onlyPending() public {
        router.transferOwnership(multisig);
        vm.prank(alice);
        vm.expectRevert(RomeClmmRouter.NotPendingOwner.selector);
        router.acceptOwnership();
    }

    // Swap must reject an empty or >3 tick-array window before touching state.
    function test_swap_emptyTickArraysReverts() public {
        router.registerPool(PID, _accts(PID));
        bytes32[] memory none = new bytes32[](0);
        vm.expectRevert(RomeClmmRouter.NoTickArrays.selector);
        router.swap(PID, true, 1, 0, 0, none);
    }

    function test_swap_tooManyTickArraysReverts() public {
        router.registerPool(PID, _accts(PID));
        bytes32[] memory four = new bytes32[](4);
        vm.expectRevert(RomeClmmRouter.NoTickArrays.selector);
        router.swap(PID, true, 1, 0, 0, four);
    }

    function test_swap_unknownPoolReverts() public {
        bytes32[] memory one = new bytes32[](1);
        vm.expectRevert(RomeClmmRouter.UnknownPool.selector);
        router.swap(PID2, true, 1, 0, 0, one);
    }
}
