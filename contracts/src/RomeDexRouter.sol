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

/// @title RomeDexRouter — the EVM lane's single-leg, custody-less path into rome-dex.
/// @notice Raw `CPI.invoke` calldata carries ~96B per account meta → a 14-account swap
///         is 1540B, larger than a whole Solana tx (1232B), so the proxy must holder-
///         stage it into 4 legs. This router stores each pool's fixed accounts once and
///         assembles the metas in EVM memory — user calldata drops to ~130B and the tx
///         fits a single atomic leg.
///
///         Security model (proven on-chain, harness/probe-delegate.mjs):
///         • custody-less — tokens move user-ATA → user-ATA; the router holds nothing.
///         • the user grants the router's external_auth PDA an SPL delegate allowance
///           (ERC20-approve-style); the router CPIs with that PDA as the transfer
///           authority and Rome auto-signs it (a contract can sign only its OWN PDA —
///           the send-gate rejects origin-PDA signing, so calling a contract grants it
///           nothing without an explicit approve).
///         • every user-side ATA is derived from msg.sender on-chain — no account
///           injection: a victim's allowance cannot be routed to an attacker.
///         • one hardcoded swap program, fixed instruction shapes — this is NOT an
///           arbitrary-invoke passthrough (that is the raw precompile's job).
contract RomeDexRouter {
    ICrossProgramInvocation constant CPI =
        ICrossProgramInvocation(0xFF00000000000000000000000000000000000008);
    IHelperProgram constant HELPER =
        IHelperProgram(0xff00000000000000000000000000000000000009);
    /// TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
    bytes32 constant TOKEN_PROGRAM =
        0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9;
    /// SPL token account layout: amount u64 at offset 64 (mint 32 + owner 32).
    uint16 constant TOKEN_AMOUNT_OFFSET = 64;

    /// The one Solana program this router will ever invoke.
    bytes32 public immutable DEX_PROGRAM;
    address public owner;
    /// Two-step ownership: proposed next owner, until it accepts. Lets the owner
    /// hand control to a multisig/timelock without risking a typo-locked address.
    address public pendingOwner;
    bool public frozen;

    struct Pool {
        bytes32 swapState;
        bytes32 authority;
        bytes32 vaultA;
        bytes32 vaultB;
        bytes32 poolMint;
        bytes32 feeAccount;
        bytes32 mintA;
        bytes32 mintB;
    }
    mapping(bytes32 => Pool) public pools; // id = swapState

    event PoolRegistered(bytes32 indexed id);
    event RegistryFrozen();
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Swapped(address indexed user, bytes32 indexed poolId, bool aToB, uint64 amountIn, uint64 amountOut);

    error NotOwner();
    error NotPendingOwner();
    error Frozen();
    error UnknownPool();
    error BadRegistration();
    error AlreadyRegistered();
    error LpBelowMinimum();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(bytes32 dexProgram) {
        DEX_PROGRAM = dexProgram;
        owner = msg.sender;
    }

    // ── registry (owner-gated; freezable) ────────────────────────────────────
    /// Add-only: a live pool's accounts can never be silently overwritten. To
    /// correct a mis-registration, freeze() is the lock; there is no in-place edit.
    function registerPool(bytes32 id, bytes32[8] calldata a) external onlyOwner {
        if (frozen) revert Frozen();
        if (id == 0 || a[0] != id) revert BadRegistration();
        if (pools[id].swapState != 0) revert AlreadyRegistered();
        pools[id] = Pool(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]);
        emit PoolRegistered(id);
    }

    function freeze() external onlyOwner {
        frozen = true;
        emit RegistryFrozen();
    }

    // ── two-step ownership (move control to a multisig without lock risk) ──────
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

    // ── trading ───────────────────────────────────────────────────────────────
    // ATA creation is folded INTO swap / swapExactOut / addLiquidity /
    // removeLiquidity (create_ata is idempotent, and create+CPI lands in ONE tx on
    // Rome — verified on Hadrian, both the atomic proxy and hadrian-lt; the
    // fresh-key acceptance is harness/newuser.test.mjs). A brand-new user needs no
    // separate "create account" step for those; the op provisions any user ATA it
    // touches. EXCEPTION: zapIn (swap+deposit) is already at Rome's atomic CU
    // ceiling, so it does NOT fold creation — the app creates its output/LP ATAs
    // as separate lightweight in-flow txs (see zapIn). The delegate approve-once
    // (SPL Approve) is the only other user-signed prerequisite — the ERC-20
    // approve UX, not a pre-creation by us.

    function swap(bytes32 poolId, bool aToB, uint64 amountIn, uint64 minOut) external {
        Pool memory p = _pool(poolId);
        HELPER.create_ata(msg.sender, aToB ? p.mintB : p.mintA); // in-flow dst ATA
        uint64 out = _swap(poolId, aToB, 0x01, amountIn, minOut);
        emit Swapped(msg.sender, poolId, aToB, amountIn, out);
    }

    /// Exact-out (on-chain tag 6): deliver exactly `amountOut`, spend ≤ `maxIn`.
    function swapExactOut(bytes32 poolId, bool aToB, uint64 amountOut, uint64 maxIn) external {
        Pool memory p = _pool(poolId);
        HELPER.create_ata(msg.sender, aToB ? p.mintB : p.mintA); // in-flow dst ATA
        _swap(poolId, aToB, 0x06, amountOut, maxIn);
        // amountIn field carries maxIn (the input BOUND) — the realized input is
        // ≤ this and isn't returned by the CPI; indexers should treat it as such.
        emit Swapped(msg.sender, poolId, aToB, maxIn, amountOut);
    }

    function addLiquidity(bytes32 poolId, uint64 lp, uint64 maxA, uint64 maxB) external {
        Pool memory p = _pool(poolId);
        // In-flow: provision the caller's LP output ATA (always new on a first
        // deposit) plus both token ATAs, then deposit — one tx.
        HELPER.create_ata(msg.sender, p.mintA);
        HELPER.create_ata(msg.sender, p.mintB);
        HELPER.create_ata(msg.sender, p.poolMint);
        ICrossProgramInvocation.AccountMeta[] memory m = new ICrossProgramInvocation.AccountMeta[](14);
        m[0] = _ro(p.swapState);
        m[1] = _ro(p.authority);
        m[2] = _signer(HELPER.pda(address(this)));
        m[3] = _w(HELPER.ata(msg.sender, p.mintA));
        m[4] = _w(HELPER.ata(msg.sender, p.mintB));
        m[5] = _w(p.vaultA);
        m[6] = _w(p.vaultB);
        m[7] = _w(p.poolMint);
        m[8] = _w(HELPER.ata(msg.sender, p.poolMint));
        m[9] = _ro(p.mintA);
        m[10] = _ro(p.mintB);
        m[11] = _ro(TOKEN_PROGRAM);
        m[12] = _ro(TOKEN_PROGRAM);
        m[13] = _ro(TOKEN_PROGRAM);
        CPI.invoke(DEX_PROGRAM, m, abi.encodePacked(bytes1(0x02), _le(lp), _le(maxA), _le(maxB)));
    }

    function removeLiquidity(bytes32 poolId, uint64 lp, uint64 minA, uint64 minB) external {
        Pool memory p = _pool(poolId);
        // In-flow: provision the caller's two output token ATAs (either side may
        // be new if they never held it), then withdraw — one tx. The LP ATA
        // already exists (the caller must hold LP to remove it).
        HELPER.create_ata(msg.sender, p.mintA);
        HELPER.create_ata(msg.sender, p.mintB);
        ICrossProgramInvocation.AccountMeta[] memory m = new ICrossProgramInvocation.AccountMeta[](15);
        m[0] = _ro(p.swapState);
        m[1] = _ro(p.authority);
        m[2] = _signer(HELPER.pda(address(this)));
        m[3] = _w(p.poolMint);
        m[4] = _w(HELPER.ata(msg.sender, p.poolMint));
        m[5] = _w(p.vaultA);
        m[6] = _w(p.vaultB);
        m[7] = _w(HELPER.ata(msg.sender, p.mintA));
        m[8] = _w(HELPER.ata(msg.sender, p.mintB));
        m[9] = _w(p.feeAccount);
        m[10] = _ro(p.mintA);
        m[11] = _ro(p.mintB);
        m[12] = _ro(TOKEN_PROGRAM);
        m[13] = _ro(TOKEN_PROGRAM);
        m[14] = _ro(TOKEN_PROGRAM);
        CPI.invoke(DEX_PROGRAM, m, abi.encodePacked(bytes1(0x03), _le(lp), _le(minA), _le(minB)));
    }

    /// SPL mint layout: supply u64 at offset 36 (COption<Pubkey> mint_authority = 4+32).
    uint16 constant MINT_SUPPLY_OFFSET = 36;

    /// Atomic zap-in: swap `amountIn` of the input side, then deposit BOTH sides
    /// for LP — one EVM tx, all-or-nothing. The realized swap output AND the pool
    /// state are read back on-chain (account_u64_at), so the LP amount is computed
    /// from post-swap reserves — no stale off-chain quote can strand the deposit.
    /// `minLp` is the slippage floor; `maxOther` bounds the pre-held other-side spend.
    function zapIn(bytes32 poolId, bool aToB, uint64 amountIn, uint64 minLp, uint64 maxOther) external {
        Pool memory p = _pool(poolId);
        // NOTE: unlike swap/addLiquidity, zapIn does NOT fold ATA creation. It is
        // the heaviest op (swap + deposit ≈ Rome's atomic CU ceiling); adding the
        // create_ata CPIs tips it over ("Too many CU for atomic transaction",
        // verified on Hadrian). The app provisions the output-side ATA and the LP
        // ATA in-flow as separate lightweight txs first (routerZapIn), so a new
        // user still needs no pre-creation by us — just an extra signature or two.
        bytes32 outAta = HELPER.ata(msg.sender, aToB ? p.mintB : p.mintA);
        uint64 outBefore = CPI.account_u64_at(outAta, TOKEN_AMOUNT_OFFSET);
        _swap(poolId, aToB, 0x01, amountIn, 1);
        uint64 got = CPI.account_u64_at(outAta, TOKEN_AMOUNT_OFFSET) - outBefore;
        // lp = floor(got × lpSupply / postSwapReserveOut), shaved 0.1% so the
        // pool's ceil-div token requirement never exceeds `got`.
        uint64 supply = CPI.account_u64_at(p.poolMint, MINT_SUPPLY_OFFSET);
        uint64 reserveOut = CPI.account_u64_at(aToB ? p.vaultB : p.vaultA, TOKEN_AMOUNT_OFFSET);
        uint64 lp = uint64((uint256(got) * supply / reserveOut) * 999 / 1000);
        if (lp < minLp) revert LpBelowMinimum();
        (uint64 maxA, uint64 maxB) = aToB ? (maxOther, got) : (got, maxOther);
        this._deposit(msg.sender, poolId, lp, maxA, maxB);
    }

    /// external-for-self so zapIn can reuse the deposit meta assembly with the
    /// original user's ATAs. Reverts for any other caller.
    function _deposit(address user, bytes32 poolId, uint64 lp, uint64 maxA, uint64 maxB) external {
        if (msg.sender != address(this)) revert NotOwner();
        Pool memory p = _pool(poolId);
        ICrossProgramInvocation.AccountMeta[] memory m = new ICrossProgramInvocation.AccountMeta[](14);
        m[0] = _ro(p.swapState);
        m[1] = _ro(p.authority);
        m[2] = _signer(HELPER.pda(address(this)));
        m[3] = _w(HELPER.ata(user, p.mintA));
        m[4] = _w(HELPER.ata(user, p.mintB));
        m[5] = _w(p.vaultA);
        m[6] = _w(p.vaultB);
        m[7] = _w(p.poolMint);
        m[8] = _w(HELPER.ata(user, p.poolMint));
        m[9] = _ro(p.mintA);
        m[10] = _ro(p.mintB);
        m[11] = _ro(TOKEN_PROGRAM);
        m[12] = _ro(TOKEN_PROGRAM);
        m[13] = _ro(TOKEN_PROGRAM);
        CPI.invoke(DEX_PROGRAM, m, abi.encodePacked(bytes1(0x02), _le(lp), _le(maxA), _le(maxB)));
    }

    /// Atomic 2-pool route (e.g. USDC→SOL on one tier, SOL→USDC on another —
    /// or A→B→C across pairs). The mid amount is read back on-chain, so the
    /// second hop swaps exactly what the first yielded. One EVM tx, atomic.
    function route(bytes32 poolA, bool aToB1, bytes32 poolB, bool aToB2, uint64 amountIn, uint64 minOut) external {
        Pool memory p1 = _pool(poolA);
        Pool memory p2 = _pool(poolB);
        bytes32 midMint = aToB1 ? p1.mintB : p1.mintA;
        // In-flow: provision the intermediate + final output ATAs up front so each
        // hop's pre/post balance read hits a live account (_swap no longer creates).
        HELPER.create_ata(msg.sender, midMint);
        HELPER.create_ata(msg.sender, aToB2 ? p2.mintB : p2.mintA);
        bytes32 midAta = HELPER.ata(msg.sender, midMint);
        uint64 midBefore = CPI.account_u64_at(midAta, TOKEN_AMOUNT_OFFSET);
        _swap(poolA, aToB1, 0x01, amountIn, 1);
        uint64 mid = CPI.account_u64_at(midAta, TOKEN_AMOUNT_OFFSET) - midBefore;
        _swap(poolB, aToB2, 0x01, mid, minOut);
    }

    // ── internals ─────────────────────────────────────────────────────────────
    function _pool(bytes32 id) internal view returns (Pool memory p) {
        p = pools[id];
        if (p.swapState == 0) revert UnknownPool();
    }

    function _swap(bytes32 poolId, bool aToB, uint8 tag, uint64 x, uint64 y) internal returns (uint64 out) {
        Pool memory p = _pool(poolId);
        (bytes32 srcMint, bytes32 dstMint, bytes32 srcVault, bytes32 dstVault) = aToB
            ? (p.mintA, p.mintB, p.vaultA, p.vaultB)
            : (p.mintB, p.mintA, p.vaultB, p.vaultA);
        // Caller provisions the receiving ATA before calling _swap (public swap /
        // swapExactOut fold it in; route / zapIn create up-front). _swap stays lean
        // so the heavy zapIn (swap+deposit) fits Rome's atomic CU ceiling.
        bytes32 dstAta = HELPER.ata(msg.sender, dstMint);
        uint64 before = CPI.account_u64_at(dstAta, TOKEN_AMOUNT_OFFSET);
        ICrossProgramInvocation.AccountMeta[] memory m = new ICrossProgramInvocation.AccountMeta[](14);
        m[0] = _ro(p.swapState);
        m[1] = _ro(p.authority);
        m[2] = _signer(HELPER.pda(address(this)));
        m[3] = _w(HELPER.ata(msg.sender, srcMint));
        m[4] = _w(srcVault);
        m[5] = _w(dstVault);
        m[6] = _w(dstAta);
        m[7] = _w(p.poolMint);
        m[8] = _w(p.feeAccount);
        m[9] = _ro(srcMint);
        m[10] = _ro(dstMint);
        m[11] = _ro(TOKEN_PROGRAM);
        m[12] = _ro(TOKEN_PROGRAM);
        m[13] = _ro(TOKEN_PROGRAM);
        CPI.invoke(DEX_PROGRAM, m, abi.encodePacked(bytes1(tag), _le(x), _le(y)));
        out = CPI.account_u64_at(dstAta, TOKEN_AMOUNT_OFFSET) - before;
    }

    function _le(uint64 v) internal pure returns (bytes8 r) {
        // u64 little-endian, as SwapInstruction::pack expects.
        v = ((v & 0xFF00FF00FF00FF00) >> 8) | ((v & 0x00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000) >> 16) | ((v & 0x0000FFFF0000FFFF) << 16);
        v = (v >> 32) | (v << 32);
        r = bytes8(v);
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
