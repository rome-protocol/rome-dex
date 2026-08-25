// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RomeDexRouter} from "../src/RomeDexRouter.sol";
import {RomeClmmRouter} from "../src/RomeClmmRouter.sol";
import {StatefulCpiFixture, MockCpi} from "./StatefulCpiFixture.sol";

interface IVmFile {
    function readFile(string calldata) external view returns (string memory);
    function parseBytes(string calldata) external pure returns (bytes memory);
}

interface IHelperView {
    function ata(address user, bytes32 mint) external view returns (bytes32);
}

/// Golden-vector pin (slippage mirror). Drives the REAL,
/// UNMODIFIED routers through the recording MockCpi and asserts the CPI
/// bytes they emit equal the SAME file the Rust `golden_vectors` tests
/// (program/src/instruction.rs, clmm/src/instruction.rs) assert against.
///
/// Anti-circularity: nothing here GENERATES the vector files — they were
/// authored by hand (all-distinct byte values so an endianness or off-by-one
/// mutation can't hide) and checked in at contracts/test/vectors/*.hex. This
/// suite and the Rust suite each independently parse/produce against that
/// one shared file. A mismatch on either side is a real encoding bug, found
/// BEFORE any behavioural change in this slice.
contract RomeRouterVectorsTest is StatefulCpiFixture {
    IVmFile constant fvm = IVmFile(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    RomeDexRouter dex;
    RomeClmmRouter clmm;

    bytes32 constant DEX_PROGRAM = bytes32(uint256(0xDE));
    bytes32 constant CLMM_PROGRAM = bytes32(uint256(0xC1));
    bytes32 constant PID = bytes32(uint256(0x1111));

    bytes32 constant CLMM_MINT0 = bytes32(uint256(0x9001));
    bytes32 constant CLMM_MINT1 = bytes32(uint256(0x9002));
    uint16 constant TOKEN_AMOUNT_OFFSET = 64;

    function _dexAccts(bytes32 id) internal pure returns (bytes32[7] memory a) {
        a[0] = id;
        for (uint256 i = 1; i < 7; i++) a[i] = bytes32(uint256(id) + i);
    }

    function _clmmAccts(bytes32 id) internal pure returns (bytes32[5] memory a) {
        a[0] = id;
        a[1] = bytes32(uint256(0xAAA1)); // vault0
        a[2] = bytes32(uint256(0xAAA2)); // vault1
        a[3] = CLMM_MINT0;
        a[4] = CLMM_MINT1;
    }

    function setUp() public {
        _setupStatefulCpi();
        dex = new RomeDexRouter(DEX_PROGRAM);
        clmm = new RomeClmmRouter(CLMM_PROGRAM);
        dex.registerPool(PID, _dexAccts(PID));
        clmm.registerPool(PID, _clmmAccts(PID));
    }

    function _vector(string memory name) internal view returns (bytes memory) {
        return fvm.parseBytes(fvm.readFile(string.concat("test/vectors/", name)));
    }

    // ── DEX router — swap (tag 1) ────────────────────────────────────────────
    // The router now enforces `out >= minOut` (the slippage-mirror fix), so
    // this vector queues a credit clearing the pinned minOut exactly — the
    // point of this test is the ENCODING, which the mirror check runs after
    // recording; the credit just keeps the call from reverting.
    function test_vector_dex_swap() public {
        bytes32[7] memory a = _dexAccts(PID);
        bytes32 dstAta = IHelperView(HELPER_ADDR).ata(address(this), a[6]); // mintB
        MockCpi.Effect[] memory effects = new MockCpi.Effect[](1);
        effects[0] = MockCpi.Effect({acct: dstAta, offset: TOKEN_AMOUNT_OFFSET, delta: int256(0x1112131415161718)});
        cpi.queueBatch(effects);

        dex.swap(PID, true, 0x0102030405060708, 0x1112131415161718);
        assertEq(cpi.recordedData(0), _vector("dex_swap.hex"));
    }

    // u64::MAX / 0 boundary — the all-0xFF pattern can't hide an endianness
    // or off-by-one mutation the way a mid-range value could.
    function test_vector_dex_swap_boundary() public {
        dex.swap(PID, true, type(uint64).max, 0);
        assertEq(cpi.recordedData(0), _vector("dex_swap_boundary.hex"));
    }

    // ── DEX router — swapExactOut (tag 6) ────────────────────────────────────
    function test_vector_dex_exactOut() public {
        dex.swapExactOut(PID, true, 0x6162636465666768, 0x7172737475767778);
        assertEq(cpi.recordedData(0), _vector("dex_exact_out.hex"));
    }

    // ── DEX router — addLiquidity / deposit (tag 2) ──────────────────────────
    function test_vector_dex_deposit() public {
        dex.addLiquidity(PID, 0x0102030405060708, 0x1112131415161718, 0x2122232425262728);
        assertEq(cpi.recordedData(0), _vector("dex_deposit.hex"));
    }

    // ── DEX router — removeLiquidity / withdraw (tag 3) ──────────────────────
    function test_vector_dex_withdraw() public {
        dex.removeLiquidity(PID, 0x3132333435363738, 0x4142434445464748, 0x5152535455565758);
        assertEq(cpi.recordedData(0), _vector("dex_withdraw.hex"));
    }

    // ── CLMM router — swap (tag 7) ───────────────────────────────────────────
    // The CURRENT (unmodified) CLMM router already reverts `out < minOut`, so
    // each vector queues a credit on the realized destination ATA equal to
    // minOut — satisfies the existing guard at the exact boundary without
    // touching the pinned instruction arguments.
    function test_vector_clmm_swap_zeroForOne() public {
        bytes32 dstAta = IHelperView(HELPER_ADDR).ata(address(this), CLMM_MINT1);
        MockCpi.Effect[] memory effects = new MockCpi.Effect[](1);
        effects[0] = MockCpi.Effect({acct: dstAta, offset: TOKEN_AMOUNT_OFFSET, delta: int256(0x1112131415161718)});
        cpi.queueBatch(effects);

        bytes32[] memory tickArrays = new bytes32[](1);
        tickArrays[0] = bytes32(uint256(0x7777));
        clmm.swap(PID, true, 0x0102030405060708, 0x1112131415161718, 0x2122232425262728292a2b2c2d2e2f30, tickArrays);
        assertEq(cpi.recordedData(0), _vector("clmm_swap_zero_for_one.hex"));
    }

    function test_vector_clmm_swap_oneForZero() public {
        bytes32 dstAta = IHelperView(HELPER_ADDR).ata(address(this), CLMM_MINT0);
        MockCpi.Effect[] memory effects = new MockCpi.Effect[](1);
        effects[0] = MockCpi.Effect({acct: dstAta, offset: TOKEN_AMOUNT_OFFSET, delta: int256(0x4142434445464748)});
        cpi.queueBatch(effects);

        bytes32[] memory tickArrays = new bytes32[](1);
        tickArrays[0] = bytes32(uint256(0x7777));
        clmm.swap(PID, false, 0x3132333435363738, 0x4142434445464748, 0x5152535455565758595a5b5c5d5e5f60, tickArrays);
        assertEq(cpi.recordedData(0), _vector("clmm_swap_one_for_zero.hex"));
    }

    function assertEq(bytes memory a, bytes memory b) internal pure {
        require(keccak256(a) == keccak256(b) && a.length == b.length, "vector mismatch");
    }
}
