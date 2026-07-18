// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RomeDexRouter} from "../src/RomeDexRouter.sol";

// Minimal foundry cheatcode surface (avoids an external forge-std dependency).
interface IVm {
    function prank(address) external;
    function expectRevert(bytes4) external;
}

// Governance / registry unit tests (audit MED). Exercise only pure storage +
// access-control paths — no Rome precompiles — so they run in plain forge.
// Trading paths stay covered on-chain by harness/router.test.mjs.
contract RomeDexRouterGovernanceTest {
    IVm constant vm = IVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    RomeDexRouter router;
    bytes32 constant DEX = bytes32(uint256(0xDE));
    address constant alice = address(0xA11CE);
    address constant multisig = address(0xACE);
    bytes32 constant PID = bytes32(uint256(0x1111));
    bytes32 constant PID2 = bytes32(uint256(0x2222));

    function _accts(bytes32 id) internal pure returns (bytes32[8] memory a) {
        a[0] = id; // registerPool requires a[0] == id
        for (uint256 i = 1; i < 8; i++) a[i] = bytes32(uint256(id) + i);
    }

    function setUp() public {
        router = new RomeDexRouter(DEX);
    }

    function test_registerPool_ownerCanAddNew() public {
        router.registerPool(PID, _accts(PID));
        (bytes32 swapState,,,,,,,) = router.pools(PID);
        require(swapState == PID, "not registered");
    }

    function test_registerPool_nonOwnerReverts() public {
        vm.prank(alice);
        vm.expectRevert(RomeDexRouter.NotOwner.selector);
        router.registerPool(PID, _accts(PID));
    }

    // The MED fix: a live pool cannot be silently overwritten.
    function test_registerPool_overwriteReverts() public {
        router.registerPool(PID, _accts(PID));
        vm.expectRevert(RomeDexRouter.AlreadyRegistered.selector);
        router.registerPool(PID, _accts(PID));
    }

    function test_registerPool_frozenReverts() public {
        router.freeze();
        vm.expectRevert(RomeDexRouter.Frozen.selector);
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

    function test_transferOwnership_onlyOwnerCanStart() public {
        vm.prank(alice);
        vm.expectRevert(RomeDexRouter.NotOwner.selector);
        router.transferOwnership(alice);
    }

    function test_acceptOwnership_onlyPending() public {
        router.transferOwnership(multisig);
        vm.prank(alice);
        vm.expectRevert(RomeDexRouter.NotPendingOwner.selector);
        router.acceptOwnership();
    }

    function test_newOwnerControlsRegistry() public {
        router.transferOwnership(multisig);
        vm.prank(multisig);
        router.acceptOwnership();
        vm.prank(multisig);
        router.registerPool(PID, _accts(PID));
        vm.expectRevert(RomeDexRouter.NotOwner.selector); // old owner now rejected
        router.registerPool(PID2, _accts(PID2));
    }
}
