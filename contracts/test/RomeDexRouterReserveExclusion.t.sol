// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RomeDexRouter} from "../src/RomeDexRouter.sol";
import {StatefulCpiFixture, MockCpi} from "./StatefulCpiFixture.sol";

interface IHelperView {
    function ata(address user, bytes32 mint) external view returns (bytes32);
}

/// The load-bearing set: zapIn's
/// `reserveOut` must be `vault - counter`, not the raw vault balance, once
/// a pool's SwapV2 protocol_fees_a/b counter accrues. The router is
/// non-upgradeable, so a miss here ships forever on mainnet.
///
/// Each test drives the REAL, unmodified router through the recording
/// MockCpi and asserts the exact byte-encoded `_deposit` CPI (tag 0x02)
/// that zapIn issues — pinning `lp` computed off `vault - counter`, not
/// off the raw vault. A router that reads the raw vault (R-M1/R-M2) or
/// cross-wires the two offsets (R-M3) produces a DIFFERENT lp and this
/// exact-byte assertion reddens.
///
/// Both direction arms get their own pool/fixture and their own test —
/// symmetric-guard discipline: this workstream has three
/// times shipped only one arm of a two-sided guard.
contract RomeDexRouterReserveExclusionTest is StatefulCpiFixture {
    RomeDexRouter router;

    uint16 constant TOKEN_AMOUNT_OFFSET = 64;
    uint16 constant MINT_SUPPLY_OFFSET = 36;
    uint16 constant PROTOCOL_FEES_A_OFFSET = 292;
    uint16 constant PROTOCOL_FEES_B_OFFSET = 300;

    // Cross-language byte pin: the Rust layout test's own pinned constants
    // (program/src/state.rs:330-331). Reused here (not arbitrary values) so
    // R-M3 (cross-wiring aToB/bToA to the wrong offset) reddens ONLY because
    // these two seeds are UNEQUAL — a control that doesn't vary the world
    // proves nothing.
    uint64 constant TEST_PROTOCOL_FEES_A = 111_222;
    uint64 constant TEST_PROTOCOL_FEES_B = 333_444;

    bytes32 constant PID_AB = bytes32(uint256(0x1111));
    bytes32 constant AUTHORITY_AB = bytes32(uint256(0xB1));
    bytes32 constant VAULT_A_AB = bytes32(uint256(0xB2));
    bytes32 constant VAULT_B_AB = bytes32(uint256(0xB3));
    bytes32 constant POOL_MINT_AB = bytes32(uint256(0xB4));
    bytes32 constant MINT_A_AB = bytes32(uint256(0xA1));
    bytes32 constant MINT_B_AB = bytes32(uint256(0xA2));

    bytes32 constant PID_BA = bytes32(uint256(0x2222));
    bytes32 constant AUTHORITY_BA = bytes32(uint256(0xC1));
    bytes32 constant VAULT_A_BA = bytes32(uint256(0xC2));
    bytes32 constant VAULT_B_BA = bytes32(uint256(0xC3));
    bytes32 constant POOL_MINT_BA = bytes32(uint256(0xC4));
    bytes32 constant MINT_A_BA = bytes32(uint256(0xD1));
    bytes32 constant MINT_B_BA = bytes32(uint256(0xD2));

    function setUp() public {
        _setupStatefulCpi();
        router = new RomeDexRouter(bytes32(uint256(0xDE)));

        bytes32[7] memory ab;
        ab[0] = PID_AB;
        ab[1] = AUTHORITY_AB;
        ab[2] = VAULT_A_AB;
        ab[3] = VAULT_B_AB;
        ab[4] = POOL_MINT_AB;
        ab[5] = MINT_A_AB;
        ab[6] = MINT_B_AB;
        router.registerPool(PID_AB, ab);

        bytes32[7] memory ba;
        ba[0] = PID_BA;
        ba[1] = AUTHORITY_BA;
        ba[2] = VAULT_A_BA;
        ba[3] = VAULT_B_BA;
        ba[4] = POOL_MINT_BA;
        ba[5] = MINT_A_BA;
        ba[6] = MINT_B_BA;
        router.registerPool(PID_BA, ba);
    }

    /// R-T1: aToB=true, output side is vaultB / protocol_fees_b (offset 300).
    /// reserveOut must be `vaultB - protocol_fees_b`, NOT raw vaultB.
    function test_zapIn_aToB_excludesProtocolFeesB() public {
        uint64 got = 500_000;
        uint64 supply = 1_000_000;
        uint64 vaultBRaw = 2_000_000;
        uint64 maxOther = 10_000_000;
        uint64 minLp = 1;

        bytes32 outAta = IHelperView(HELPER_ADDR).ata(address(this), MINT_B_AB);
        MockCpi.Effect[] memory swapEffect = new MockCpi.Effect[](1);
        swapEffect[0] = MockCpi.Effect({acct: outAta, offset: TOKEN_AMOUNT_OFFSET, delta: int256(uint256(got))});
        cpi.queueBatch(swapEffect);

        cpi.set(POOL_MINT_AB, MINT_SUPPLY_OFFSET, supply);
        cpi.set(VAULT_B_AB, TOKEN_AMOUNT_OFFSET, vaultBRaw);
        cpi.set(PID_AB, PROTOCOL_FEES_B_OFFSET, TEST_PROTOCOL_FEES_B);

        router.zapIn(PID_AB, true, 500, minLp, maxOther);

        // reserveOut = vaultBRaw - TEST_PROTOCOL_FEES_B = 1_666_556
        // lp = floor(got * supply / reserveOut) * 999 / 1000 = 299_718
        uint64 expectedLp = 299_718;
        uint64 expectedMaxA = maxOther;
        uint64 expectedMaxB = got;
        bytes memory expected =
            abi.encodePacked(bytes1(0x02), _le(expectedLp), _le(expectedMaxA), _le(expectedMaxB));
        require(
            keccak256(cpi.recordedData(1)) == keccak256(expected),
            "zapIn aToB did not exclude protocol_fees_b from reserveOut"
        );
    }

    /// R-T2: aToB=false (bToA), output side is vaultA / protocol_fees_a
    /// (offset 292). Symmetric arm to R-T1 — its own mutation target.
    function test_zapIn_bToA_excludesProtocolFeesA() public {
        uint64 got = 700_000;
        uint64 supply = 2_000_000;
        uint64 vaultARaw = 3_000_000;
        uint64 maxOther = 10_000_000;
        uint64 minLp = 1;

        bytes32 outAta = IHelperView(HELPER_ADDR).ata(address(this), MINT_A_BA);
        MockCpi.Effect[] memory swapEffect = new MockCpi.Effect[](1);
        swapEffect[0] = MockCpi.Effect({acct: outAta, offset: TOKEN_AMOUNT_OFFSET, delta: int256(uint256(got))});
        cpi.queueBatch(swapEffect);

        cpi.set(POOL_MINT_BA, MINT_SUPPLY_OFFSET, supply);
        cpi.set(VAULT_A_BA, TOKEN_AMOUNT_OFFSET, vaultARaw);
        cpi.set(PID_BA, PROTOCOL_FEES_A_OFFSET, TEST_PROTOCOL_FEES_A);

        router.zapIn(PID_BA, false, 500, minLp, maxOther);

        // reserveOut = vaultARaw - TEST_PROTOCOL_FEES_A = 2_888_778
        // lp = floor(got * supply / reserveOut) * 999 / 1000 = 484_148
        uint64 expectedLp = 484_148;
        // aToB=false => (maxA, maxB) = (got, maxOther).
        uint64 expectedMaxA = got;
        uint64 expectedMaxB = maxOther;
        bytes memory expected =
            abi.encodePacked(bytes1(0x02), _le(expectedLp), _le(expectedMaxA), _le(expectedMaxB));
        require(
            keccak256(cpi.recordedData(1)) == keccak256(expected),
            "zapIn bToA did not exclude protocol_fees_a from reserveOut"
        );
    }

    function _le(uint64 v) internal pure returns (bytes8 r) {
        v = ((v & 0xFF00FF00FF00FF00) >> 8) | ((v & 0x00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000) >> 16) | ((v & 0x0000FFFF0000FFFF) << 16);
        v = (v >> 32) | (v << 32);
        r = bytes8(v);
    }
}
