// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RomeClmmRouter} from "../src/RomeClmmRouter.sol";
import {StatefulCpiFixture, MockCpi} from "./StatefulCpiFixture.sol";

interface IHelperView {
    function ata(address user, bytes32 mint) external view returns (bytes32);
}

interface IVm {
    function expectRevert(bytes4) external;
}

/// First-ever executable coverage of RomeClmmRouter's EXISTING `swap()`
/// slippage mirror (`OutBelowMinimum`) — this contract is NOT touched by
/// this fix (its mirror already existed); these tests are mutation-proven by
/// deleting the check in the source and confirming
/// `test_clmm_swap_reverts_below_minOut` fails, then restoring it (see the
/// report for the paste of that RED output).
contract RomeClmmRouterSlippageCoverageTest is StatefulCpiFixture {
    IVm constant vm = IVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    RomeClmmRouter router;
    bytes32 constant PID = bytes32(uint256(0x1111));
    bytes32 constant MINT0 = bytes32(uint256(0x9001));
    bytes32 constant MINT1 = bytes32(uint256(0x9002));
    uint16 constant TOKEN_AMOUNT_OFFSET = 64;

    function setUp() public {
        _setupStatefulCpi();
        router = new RomeClmmRouter(bytes32(uint256(0xC1)));
        bytes32[5] memory a;
        a[0] = PID;
        a[1] = bytes32(uint256(0xAAA1)); // vault0
        a[2] = bytes32(uint256(0xAAA2)); // vault1
        a[3] = MINT0;
        a[4] = MINT1;
        router.registerPool(PID, a);
    }

    function _oneTickArray() internal pure returns (bytes32[] memory t) {
        t = new bytes32[](1);
        t[0] = bytes32(uint256(0x7777));
    }

    function _credit(bytes32 acct, int256 delta) internal {
        MockCpi.Effect[] memory e = new MockCpi.Effect[](1);
        e[0] = MockCpi.Effect({acct: acct, offset: TOKEN_AMOUNT_OFFSET, delta: delta});
        cpi.queueBatch(e);
    }

    function test_clmm_swap_reverts_below_minOut() public {
        bytes32 dstAta = IHelperView(HELPER_ADDR).ata(address(this), MINT1);
        uint64 minOut = 1000;
        _credit(dstAta, int256(uint256(minOut)) - 1);
        vm.expectRevert(RomeClmmRouter.OutBelowMinimum.selector);
        router.swap(PID, true, 500, minOut, 0, _oneTickArray());
    }

    function test_clmm_swap_passes_at_minOut() public {
        bytes32 dstAta = IHelperView(HELPER_ADDR).ata(address(this), MINT1);
        uint64 minOut = 1000;
        _credit(dstAta, int256(uint256(minOut)));
        uint64 out = router.swap(PID, true, 500, minOut, 0, _oneTickArray());
        require(out == minOut, "out != minOut at boundary");
    }
}
