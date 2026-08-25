// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Etch-only cheatcode surface — separate from PauseFixture's IVmPause (which
/// adds mockCall) because this fixture never mocks a selector; it etches REAL
/// runtime code that carries state across calls.
interface IVmEtch {
    function etch(address, bytes calldata) external;
}

/// Runtime code etched at the CPI precompile address (0xFF..08). Unlike
/// PauseFixture's mockCall (constant return, every delta collapses to 0),
/// this actually tracks per-account, per-offset u64 balances so a router's
/// before/after read produces a REAL, test-controlled delta — required to
/// exercise the slippage mirror at all.
contract MockCpi {
    struct AccountMeta {
        bytes32 pubkey;
        bool is_signer;
        bool is_writable;
    }

    /// A balance mutation applied to one (account, offset) cell. `delta` is
    /// signed so a spend (source ATA debited) and a credit (destination ATA
    /// credited) are both expressible with the same queue.
    struct Effect {
        bytes32 acct;
        uint16 offset;
        int256 delta;
    }

    mapping(bytes32 => mapping(uint16 => uint64)) public bal;

    // FIFO queue of effect batches — one batch per expected `invoke()` call,
    // consumed in call order. A test queues exactly as many batches as the
    // router makes CPI.invoke calls in the scenario under test; a call past
    // the queue's end is a no-op (some ops, e.g. addLiquidity, invoke without
    // any test needing to track a balance delta).
    Effect[][] private queue;
    uint256 private queueHead;

    // Recorder — every invoke's (program_id, data) in call order. Doubles as
    // golden-vector capture and as the route/zapIn mid-hop byte pin.
    bytes32[] public recordedProgramId;
    bytes[] public recordedData;
    // Per-invoke account-meta snapshots, in call order (makes
    // account-list changes — count, pubkey order, writability, signer flags
    // — testable, not just review-only).
    AccountMeta[][] private recordedAccountsInternal;

    /// Seeds one (account, offset) cell to an absolute value — the "before"
    /// state a test sets up prior to calling the router.
    function set(bytes32 acct, uint16 offset, uint64 v) external {
        bal[acct][offset] = v;
    }

    /// Queues one batch of effects to be applied on the NEXT invoke() call
    /// (FIFO — the Nth queueBatch call backs the Nth invoke() call).
    function queueBatch(Effect[] calldata effects) external {
        Effect[] storage batch = queue.push();
        for (uint256 i = 0; i < effects.length; i++) {
            batch.push(effects[i]);
        }
    }

    function recordedCount() external view returns (uint256) {
        return recordedData.length;
    }

    function invoke(bytes32 program_id, AccountMeta[] memory accounts, bytes memory data) external {
        recordedProgramId.push(program_id);
        recordedData.push(data);
        recordedAccountsInternal.push();
        AccountMeta[] storage slot = recordedAccountsInternal[recordedAccountsInternal.length - 1];
        for (uint256 i = 0; i < accounts.length; i++) {
            slot.push(accounts[i]);
        }
        if (queueHead < queue.length) {
            Effect[] storage effects = queue[queueHead];
            queueHead++;
            for (uint256 i = 0; i < effects.length; i++) {
                int256 next = int256(uint256(bal[effects[i].acct][effects[i].offset])) + effects[i].delta;
                require(next >= 0, "MockCpi: negative balance");
                bal[effects[i].acct][effects[i].offset] = uint64(uint256(next));
            }
        }
    }

    function account_u64_at(bytes32 pubkey, uint16 offset) external view returns (uint64) {
        return bal[pubkey][offset];
    }

    /// Number of metas passed to the Nth invoke() call.
    function recordedAccountsCount(uint256 callIdx) external view returns (uint256) {
        return recordedAccountsInternal[callIdx].length;
    }

    /// The Ith meta of the Nth invoke() call — full tuple so a test can
    /// assert pubkey, is_signer, and is_writable in one read.
    function recordedAccountAt(uint256 callIdx, uint256 i) external view returns (AccountMeta memory) {
        return recordedAccountsInternal[callIdx][i];
    }
}

/// Runtime code etched at the HELPER precompile address (0xFF..09).
/// `ata`/`pda` are DISTINCT per input (keccak, not a constant) — the
/// PauseFixture mock's constant bytes32(2) makes every user/mint combination
/// collapse onto the same account, which would make source and destination
/// ATAs indistinguishable and every delta computation degenerate.
contract MockHelper {
    function ata(address user, bytes32 mint) external pure returns (bytes32) {
        return keccak256(abi.encode("ata", user, mint));
    }

    function pda(address user) external pure returns (bytes32) {
        return keccak256(abi.encode("pda", user));
    }

    function create_ata(address, bytes32) external {}
}

/// Etches MockCpi/MockHelper's runtime code at the real precompile addresses,
/// then hands back typed handles so a test can call `set`/`queueBatch`/
/// `recordedData` on them directly (etch replaces CODE only — constructor
/// state does not survive it, so all mock state is set via these setters
/// AFTER etching, never via a constructor).
abstract contract StatefulCpiFixture {
    IVmEtch constant svm = IVmEtch(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address constant CPI_ADDR = 0xFF00000000000000000000000000000000000008;
    address constant HELPER_ADDR = 0xff00000000000000000000000000000000000009;

    MockCpi cpi;

    function _setupStatefulCpi() internal {
        svm.etch(CPI_ADDR, address(new MockCpi()).code);
        svm.etch(HELPER_ADDR, address(new MockHelper()).code);
        cpi = MockCpi(CPI_ADDR);
    }
}
