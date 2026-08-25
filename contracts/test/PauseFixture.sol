// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Extended foundry cheatcode surface for the pause test suites — adds etch +
/// mockCall on top of the plain prank/expectRevert surface the governance
/// tests already use (kept as a SEPARATE interface/constant there so this
/// file stays independent of any other test file).
interface IVmPause {
    function etch(address, bytes calldata) external;
    function mockCall(address, bytes calldata, bytes calldata) external;
}

/// Shared precompile mock fixture for the trading-path pause tests. The
/// pause-blocks-* tests need NONE of this — the revert fires in
/// `_pool` before any precompile call, so a mock-free revert is itself proof
/// no CPI is reached. This fixture is only for the completion-path tests
/// (unpause restores trading / freeze does not stop trading / etc).
///
/// Etches nonzero code at the CPI/HELPER precompile addresses first —
/// mockCall against a code-less account is unreliable across foundry
/// versions — then mocks every selector the trading paths touch, at the
/// SELECTOR level (a 4-byte partial match, wildcard on the actual args) so
/// one mock covers every user/mint/pool combination the tests exercise.
///
/// CPI.account_u64_at always returns the SAME constant (1000) no matter
/// which account/offset is queried, so every before/after balance delta a
/// router computes is 0 — realized swap output, zapIn's `got`, etc. These
/// tests are pinning that the trading path COMPLETES post-unpause, not
/// measuring real swap economics (that's the on-chain harness's job).
abstract contract PauseFixture {
    IVmPause constant pvm = IVmPause(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address constant CPI_ADDR = 0xFF00000000000000000000000000000000000008;
    address constant HELPER_ADDR = 0xff00000000000000000000000000000000000009;

    function _mockPrecompiles() internal {
        pvm.etch(CPI_ADDR, hex"00");
        pvm.etch(HELPER_ADDR, hex"00");

        // IHelperProgram
        pvm.mockCall(HELPER_ADDR, abi.encodePacked(bytes4(keccak256("pda(address)"))), abi.encode(bytes32(uint256(1))));
        pvm.mockCall(
            HELPER_ADDR, abi.encodePacked(bytes4(keccak256("ata(address,bytes32)"))), abi.encode(bytes32(uint256(2)))
        );
        pvm.mockCall(HELPER_ADDR, abi.encodePacked(bytes4(keccak256("create_ata(address,bytes32)"))), "");

        // ICrossProgramInvocation — invoke's canonical signature uses the
        // AccountMeta tuple shape (bytes32,bool,bool)[]; only the 4-byte
        // selector prefix is matched, so the mock never needs to encode the
        // actual accounts/data.
        pvm.mockCall(CPI_ADDR, abi.encodePacked(bytes4(keccak256("invoke(bytes32,(bytes32,bool,bool)[],bytes)"))), "");
        pvm.mockCall(
            CPI_ADDR,
            abi.encodePacked(bytes4(keccak256("account_u64_at(bytes32,uint16)"))),
            abi.encode(uint64(1000))
        );
    }
}
