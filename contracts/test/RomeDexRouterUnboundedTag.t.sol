// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RomeDexRouter} from "../src/RomeDexRouter.sol";
import {StatefulCpiFixture, MockCpi} from "./StatefulCpiFixture.sol";

interface IVm {
    function expectRevert(bytes4) external;
}

/// Test-only harness: `_swap`'s dispatch is the target, but `_swap` is
/// internal — this subclass exposes it directly (internal functions are
/// callable, unmodified, from a derived contract) so a tag outside the
/// closed {0x01, 0x06} set the real call sites use can still be driven
/// through the real dispatch code, proving the new `else { revert
/// UnboundedTag(); }` branch is live rather than dead code.
contract SwapDispatchHarness is RomeDexRouter {
    constructor(bytes32 dexProgram) RomeDexRouter(dexProgram) {}

    function callSwap(bytes32 poolId, bool aToB, uint8 tag, uint64 x, uint64 y) external returns (uint64) {
        return _swap(poolId, aToB, tag, x, y);
    }
}

contract RomeDexRouterUnboundedTagTest is StatefulCpiFixture {
    IVm constant vm = IVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    SwapDispatchHarness router;
    bytes32 constant PID = bytes32(uint256(0x1111));
    bytes32 constant MINT_A = bytes32(uint256(0xA1));
    bytes32 constant MINT_B = bytes32(uint256(0xA2));

    function setUp() public {
        _setupStatefulCpi();
        router = new SwapDispatchHarness(bytes32(uint256(0xDE)));
        bytes32[7] memory a;
        a[0] = PID;
        a[1] = bytes32(uint256(0xB1)); // authority
        a[2] = bytes32(uint256(0xB2)); // vaultA
        a[3] = bytes32(uint256(0xB3)); // vaultB
        a[4] = bytes32(uint256(0xB4)); // poolMint
        a[5] = MINT_A;
        a[6] = MINT_B;
        router.registerPool(PID, a);
    }

    /// No tag outside {0x01, 0x06} ever reaches _swap through a real call
    /// site (all five are literal-tag), but the dispatch itself must reject
    /// one — this is the one path that proves the branch is bound, not dead.
    function test_unrecognizedTag_reverts_unboundedTag() public {
        vm.expectRevert(RomeDexRouter.UnboundedTag.selector);
        router.callSwap(PID, true, 0x03, 500, 1);
    }
}
