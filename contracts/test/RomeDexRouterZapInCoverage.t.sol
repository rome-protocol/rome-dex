// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RomeDexRouter} from "../src/RomeDexRouter.sol";
import {StatefulCpiFixture, MockCpi} from "./StatefulCpiFixture.sol";

interface IHelperView {
    function ata(address user, bytes32 mint) external view returns (bytes32);
}

interface IVm {
    function expectRevert(bytes4) external;
}

/// First-ever executable coverage of `zapIn`'s EXISTING `LpBelowMinimum`
/// guard (this fix touches `_swap`, not zapIn's own check — these tests are
/// mutation-proven by deleting the check in the source and confirming
/// `test_zapIn_reverts_below_minLp` fails, then restoring it; see the report
/// for the paste of that RED output).
///
/// `lp` is pinned to a deterministic value by controlling all three inputs
/// to zapIn's formula (`got`, pool-mint `supply`, `reserveOut`):
///   lp = floor(got * supply / reserveOut) * 999 / 1000
/// got = supply = reserveOut = 1000  =>  lp = floor(1000*1000/1000)*999/1000
///                                      = 1000 * 999 / 1000 = 999 (exact).
contract RomeDexRouterZapInCoverageTest is StatefulCpiFixture {
    IVm constant vm = IVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    RomeDexRouter router;
    bytes32 constant PID = bytes32(uint256(0x1111));
    bytes32 constant MINT_A = bytes32(uint256(0xA1));
    bytes32 constant MINT_B = bytes32(uint256(0xA2));
    uint16 constant TOKEN_AMOUNT_OFFSET = 64;
    uint16 constant MINT_SUPPLY_OFFSET = 36;

    // Pool accounts, named per RomeDexRouter.Pool field order.
    bytes32 constant AUTHORITY = bytes32(uint256(0xB1));
    bytes32 constant VAULT_A = bytes32(uint256(0xB2));
    bytes32 constant VAULT_B = bytes32(uint256(0xB3));
    bytes32 constant POOL_MINT = bytes32(uint256(0xB4));
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

        // got = 1000 (credit realized on the swap leg's output ATA).
        bytes32 outAta = IHelperView(HELPER_ADDR).ata(address(this), MINT_B);
        MockCpi.Effect[] memory swapEffect = new MockCpi.Effect[](1);
        swapEffect[0] = MockCpi.Effect({acct: outAta, offset: TOKEN_AMOUNT_OFFSET, delta: 1000});
        cpi.queueBatch(swapEffect);

        // supply = 1000, reserveOut (vaultB, since aToB=true) = 1000.
        cpi.set(POOL_MINT, MINT_SUPPLY_OFFSET, 1000);
        cpi.set(VAULT_B, TOKEN_AMOUNT_OFFSET, 1000);
    }

    function test_zapIn_reverts_below_minLp() public {
        vm.expectRevert(RomeDexRouter.LpBelowMinimum.selector);
        router.zapIn(PID, true, 500, 1000, 10_000); // lp=999 < minLp=1000
    }

    function test_zapIn_passes_at_minLp() public {
        router.zapIn(PID, true, 500, 999, 10_000); // lp=999 == minLp, must not revert
    }

    /// `_deposit`'s tag-0x02 encode (called via `this._deposit` from zapIn) is
    /// a textually DUPLICATED copy of addLiquidity's — RomeRouterVectors.t.sol
    /// only pins addLiquidity's copy, so this duplicate could drift unnoticed.
    /// Mirrors test_route_secondHop_swaps_realized_mid's recordedData(1) check:
    /// zapIn's invoke 0 is the swap leg, invoke 1 is _deposit's CPI.
    function test_zapIn_depositLeg_encodes_expected_tag() public {
        // aToB=true => (maxA, maxB) = (maxOther, got) = (10_000, 1000).
        uint64 lp = 999;
        uint64 maxA = 10_000;
        uint64 maxB = 1000;
        router.zapIn(PID, true, 500, lp, maxA);
        bytes memory expected = abi.encodePacked(bytes1(0x02), _le(lp), _le(maxA), _le(maxB));
        require(keccak256(cpi.recordedData(1)) == keccak256(expected), "_deposit did not emit expected tag-0x02 bytes");
    }

    function _le(uint64 v) internal pure returns (bytes8 r) {
        v = ((v & 0xFF00FF00FF00FF00) >> 8) | ((v & 0x00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000) >> 16) | ((v & 0x0000FFFF0000FFFF) << 16);
        v = (v >> 32) | (v << 32);
        r = bytes8(v);
    }
}
