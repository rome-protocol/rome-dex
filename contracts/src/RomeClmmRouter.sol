// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface ICrossProgramInvocation {
    struct AccountMeta {
        bytes32 pubkey;
        bool is_signer;
        bool is_writable;
    }
    function invoke(bytes32 program_id, AccountMeta[] memory accounts, bytes memory data) external;
    function account_u64_at(bytes32 pubkey, uint16 offset) external view returns (uint64);
}

interface IHelperProgram {
    function pda(address user) external view returns (bytes32);
    function ata(address user, bytes32 mint) external view returns (bytes32);
    function create_ata(address user, bytes32 mint) external;
}

/// @title RomeClmmRouter — the EVM lane's single-leg path into the rome-dex CLMM SWAP.
/// @notice Raw `CPI.invoke` of a CLMM swap (pool + 2 vaults + 1-3 tick arrays +
///         user ATAs + token program) is >1232B of calldata, so the proxy
///         holder-stages it into ~3 legs. This router stores each pool's fixed
///         accounts once and assembles the metas in EVM memory, dropping user
///         calldata enough to land the swap in a SINGLE atomic leg.
///
///         SCOPE — SWAP ONLY. CLMM liquidity ops (open / increase / decrease /
///         collect / close) act on a per-user Position PDA whose `owner` must
///         sign; a contract can auto-sign only its OWN external_auth PDA, never
///         the user's, so those ops stay on the direct CPI-precompile path
///         (Rome auto-signs the user's PDA there). This router deliberately does
///         NOT expose them — folding them would require the router to custody
///         positions, breaking the dual-lane, user-owned-position model.
///
///         Security model (mirrors RomeDexRouter, proven on-chain):
///         • custody-less — tokens move user-ATA → user-ATA; the router holds nothing.
///         • the user grants the router's external_auth PDA an SPL delegate
///           allowance on the input ATA (ERC-20-approve-style); the router CPIs
///           the swap with that PDA as the transfer authority and Rome auto-signs
///           it (a contract signs only its own PDA; a bare call grants nothing).
///         • every user ATA is derived from msg.sender on-chain — no injection.
///         • one hardcoded CLMM program, one instruction shape (exact-in swap,
///           tag 7) — NOT an arbitrary-invoke passthrough.
contract RomeClmmRouter {
    ICrossProgramInvocation constant CPI =
        ICrossProgramInvocation(0xFF00000000000000000000000000000000000008);
    IHelperProgram constant HELPER =
        IHelperProgram(0xff00000000000000000000000000000000000009);
    /// TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
    bytes32 constant TOKEN_PROGRAM =
        0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9;
    /// SPL token account layout: amount u64 at offset 64 (mint 32 + owner 32).
    uint16 constant TOKEN_AMOUNT_OFFSET = 64;
    /// CLMM Swap instruction tag (clmm/src/instruction.rs).
    bytes1 constant SWAP_TAG = 0x07;

    /// The one Solana CLMM program this router will ever invoke.
    bytes32 public immutable CLMM_PROGRAM;
    address public owner;
    address public pendingOwner;
    bool public frozen;

    /// A CLMM pool's fixed accounts (tick arrays are NOT here — they depend on
    /// the live price and are passed per-swap).
    struct Pool {
        bytes32 pool; // the pool PDA (== id)
        bytes32 vault0;
        bytes32 vault1;
        bytes32 mint0;
        bytes32 mint1;
    }
    mapping(bytes32 => Pool) public pools; // id = pool PDA

    event PoolRegistered(bytes32 indexed id);
    event RegistryFrozen();
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Swapped(address indexed user, bytes32 indexed poolId, bool zeroForOne, uint64 amountIn, uint64 amountOut);

    error NotOwner();
    error NotPendingOwner();
    error Frozen();
    error UnknownPool();
    error BadRegistration();
    error AlreadyRegistered();
    error NoTickArrays();
    error OutBelowMinimum();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(bytes32 clmmProgram) {
        CLMM_PROGRAM = clmmProgram;
        owner = msg.sender;
    }

    // ── registry (owner-gated; freezable; add-only) ──────────────────────────
    function registerPool(bytes32 id, bytes32[5] calldata a) external onlyOwner {
        if (frozen) revert Frozen();
        if (id == 0 || a[0] != id) revert BadRegistration();
        if (pools[id].pool != 0) revert AlreadyRegistered();
        pools[id] = Pool(a[0], a[1], a[2], a[3], a[4]);
        emit PoolRegistered(id);
    }

    function freeze() external onlyOwner {
        frozen = true;
        emit RegistryFrozen();
    }

    // ── two-step ownership ────────────────────────────────────────────────────
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // ── swap (the one foldable CLMM op) ──────────────────────────────────────
    /// Exact-in CLMM swap in ONE atomic leg. `zeroForOne` picks direction
    /// (true = token0 in / token1 out, price falls). `tickArrays` is the walk-
    /// order window (the array holding the current tick first; the caller reads
    /// the live pool tick to build it). `sqrtPriceLimit` = 0 → band edge.
    /// The user must have SPL-delegated the input ATA to this router's PDA.
    function swap(
        bytes32 poolId,
        bool zeroForOne,
        uint64 amountIn,
        uint64 minOut,
        uint128 sqrtPriceLimit,
        bytes32[] calldata tickArrays
    ) external returns (uint64 out) {
        if (tickArrays.length == 0 || tickArrays.length > 3) revert NoTickArrays();
        Pool memory p = _pool(poolId);
        // vault0/vault1 pass in FIXED order (the program matches them to
        // pool.vault_0/_1); only the mints are direction-ordered here.
        (bytes32 srcMint, bytes32 dstMint) =
            zeroForOne ? (p.mint0, p.mint1) : (p.mint1, p.mint0);
        // In-flow: provision the caller's destination ATA (idempotent).
        HELPER.create_ata(msg.sender, dstMint);
        bytes32 dstAta = HELPER.ata(msg.sender, dstMint);
        uint64 before = CPI.account_u64_at(dstAta, TOKEN_AMOUNT_OFFSET);

        // CLMM swap account layout (clmm/src/processor.rs::swap):
        // [pool(w), authority(signer), user_src(w), user_dst(w),
        //  vault0(w), vault1(w), token_program, tick_array_0..2(w)].
        // Note: vault0/vault1 are passed in FIXED order (not src/dst-ordered) —
        // the program matches them to pool.vault_0/pool.vault_1.
        uint256 n = 7 + tickArrays.length;
        ICrossProgramInvocation.AccountMeta[] memory m = new ICrossProgramInvocation.AccountMeta[](n);
        m[0] = _w(p.pool);
        m[1] = _signer(HELPER.pda(address(this)));
        m[2] = _w(HELPER.ata(msg.sender, srcMint));
        m[3] = _w(dstAta);
        m[4] = _w(p.vault0);
        m[5] = _w(p.vault1);
        m[6] = _ro(TOKEN_PROGRAM);
        for (uint256 i = 0; i < tickArrays.length; i++) {
            m[7 + i] = _w(tickArrays[i]);
        }
        // data = tag(1) | zeroForOne(1) | amountIn(u64 LE) | minOut(u64 LE) | sqrtLimit(u128 LE)
        CPI.invoke(
            CLMM_PROGRAM,
            m,
            abi.encodePacked(SWAP_TAG, bytes1(zeroForOne ? 0x01 : 0x00), _le64(amountIn), _le64(minOut), _le128(sqrtPriceLimit))
        );
        out = CPI.account_u64_at(dstAta, TOKEN_AMOUNT_OFFSET) - before;
        // The CLMM program already enforces min_amount_out on-chain; this is a
        // defense-in-depth mirror against a mis-encoded leg.
        if (out < minOut) revert OutBelowMinimum();
        emit Swapped(msg.sender, poolId, zeroForOne, amountIn, out);
    }

    // ── internals ─────────────────────────────────────────────────────────────
    function _pool(bytes32 id) internal view returns (Pool memory p) {
        p = pools[id];
        if (p.pool == 0) revert UnknownPool();
    }

    function _le64(uint64 v) internal pure returns (bytes8 r) {
        v = ((v & 0xFF00FF00FF00FF00) >> 8) | ((v & 0x00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000) >> 16) | ((v & 0x0000FFFF0000FFFF) << 16);
        v = (v >> 32) | (v << 32);
        r = bytes8(v);
    }

    function _le128(uint128 v) internal pure returns (bytes16 r) {
        // Low 8 bytes then high 8 bytes, each little-endian (matches u128 LE).
        bytes8 lo = _le64(uint64(v));
        bytes8 hi = _le64(uint64(v >> 64));
        r = bytes16(abi.encodePacked(lo, hi));
    }

    function _ro(bytes32 k) internal pure returns (ICrossProgramInvocation.AccountMeta memory) {
        return ICrossProgramInvocation.AccountMeta(k, false, false);
    }

    function _w(bytes32 k) internal pure returns (ICrossProgramInvocation.AccountMeta memory) {
        return ICrossProgramInvocation.AccountMeta(k, false, true);
    }

    function _signer(bytes32 k) internal pure returns (ICrossProgramInvocation.AccountMeta memory) {
        return ICrossProgramInvocation.AccountMeta(k, true, false);
    }
}
