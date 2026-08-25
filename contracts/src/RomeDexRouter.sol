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
///         Security model. Bullet 2 is proven both on-chain
///         (harness/probe-origin-pda-signer.mjs) and in rome-evm source. Bullet 4 is a
///         source-audit fact that becomes on-chain-true at deploy, via bytecode +
///         immutables verification. Bullets 1 and 3 also rest on the HELPER precompile
///         and stay unproven until this router is deployed and exercised.
///         • custody-less — tokens move user-ATA → user-ATA; the router holds nothing.
///         • the user grants the router's external_auth PDA an SPL delegate allowance
///           (ERC20-approve-style); the router CPIs with that PDA as the transfer
///           authority and Rome auto-signs it. rome-evm pushes signer seeds for the
///           CALLER's external_auth PDA and nothing else (anchored on the
///           caller; salts only extend that base), so any
///           other EOA's PDA presented as a signer is rejected by the runtime as
///           PrivilegeEscalation: calling a contract grants it nothing without an
///           explicit approve. Every external_auth PDA is derived under rome-evm's OWN
///           program id, so rome-evm is the one program that could sign a stranger's —
///           the runtime enforces this deterministically, but only because rome-evm
///           declines to present those seeds. A code choice, not a structural guarantee,
///           so re-verify per rome-evm build and chain.
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
    /// SwapV2 tail counters (account-relative, includes the leading version
    /// byte) — see program/src/state.rs:209,226,353-359. protocol_fees_a
    /// accrues from AtoB swaps (token-A units, backed by vault A);
    /// protocol_fees_b accrues from BtoA swaps (token-B units, vault B).
    uint16 constant PROTOCOL_FEES_A_OFFSET = 292;
    uint16 constant PROTOCOL_FEES_B_OFFSET = 300;

    /// The one Solana program this router will ever invoke.
    bytes32 public immutable DEX_PROGRAM;
    address public owner;
    /// Two-step ownership: proposed next owner, until it accepts. Lets the owner
    /// hand control to a multisig/timelock without risking a typo-locked address.
    address public pendingOwner;
    bool public frozen;
    /// Single pauser address (rotatable via setPauser; zero disables it). The
    /// operator fans its own key out if it wants more than one hot pauser —
    /// a set adds storage + enumeration to a non-upgradeable contract for
    /// nothing. owner can always pause directly too (see pause()).
    address public pauser;
    bool public paused;

    struct Pool {
        bytes32 swapState;
        bytes32 authority;
        bytes32 vaultA;
        bytes32 vaultB;
        bytes32 poolMint;
        bytes32 mintA;
        bytes32 mintB;
    }
    mapping(bytes32 => Pool) public pools; // id = swapState

    event PoolRegistered(bytes32 indexed id);
    event RegistryFrozen();
    event PoolUnregistered(bytes32 indexed id);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Swapped(address indexed user, bytes32 indexed poolId, bool aToB, uint64 amountIn, uint64 amountOut);
    // Named PausedBy (not Paused) to avoid clashing with the error below.
    event PausedBy(address indexed account);
    event Unpaused(address indexed account);
    event PauserSet(address indexed previousPauser, address indexed newPauser);

    error NotOwner();
    error NotPendingOwner();
    error Frozen();
    error UnknownPool();
    error BadRegistration();
    error AlreadyRegistered();
    error LpBelowMinimum();
    error Paused();
    error NotPauser();
    error NotRegistered();
    /// Defense-in-depth mirror of the DEX program's exact-in slippage guard
    /// (tag 0x01) — mirrors RomeClmmRouter's identically-named error.
    error OutBelowMinimum();
    /// Defense-in-depth mirror of the DEX program's exact-out slippage guard
    /// (tag 0x06, INPUT-side only — see `_swap`).
    error InAboveMaximum();
    /// Every tag reaching _swap's slippage dispatch must declare which side it
    /// bounds (0x01=output, 0x06=input). This is deliberately NOT an `else`
    /// falling through to the exact-out branch: a future tag landing there by
    /// default would inherit exact-out semantics with srcBefore defaulted to
    /// 0, so `spent = 0 - srcAfter` underflow-reverts when srcAfter > 0 —
    /// but silently PASSES (spent == 0 <= y) when the source ATA drains to
    /// exactly 0. A false negative on a slippage check can't be fixed after
    /// deploy, so an unrecognized tag must revert loudly instead.
    error UnboundedTag();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(bytes32 dexProgram) {
        DEX_PROGRAM = dexProgram;
        owner = msg.sender;
    }

    // ── registry (owner-gated; freezable) ────────────────────────────────────
    /// Add-only in place: a live row can never be silently overwritten
    /// (AlreadyRegistered). To correct a mis-registration, use unregisterPool()
    /// then registerPool() — two owner-gated txs, two events, both blocked once
    /// freeze() is called. freeze() permanently locks the REGISTRY; it does NOT
    /// stop trading against rows already registered — pause() does that.
    function registerPool(bytes32 id, bytes32[7] calldata a) external onlyOwner {
        if (frozen) revert Frozen();
        if (id == 0 || a[0] != id) revert BadRegistration();
        if (pools[id].swapState != 0) revert AlreadyRegistered();
        pools[id] = Pool(a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
        emit PoolRegistered(id);
    }

    /// Removes a row so it can be re-registered with corrected accounts. Pool
    /// ids are REUSABLE by design — the id is the on-chain swapState PDA, and
    /// a re-registration only re-points the auxiliary accounts stored here;
    /// the Solana program validates them against real pool state at CPI time,
    /// so a wrong row fails closed, never a silent theft. Available even while
    /// frozen is false is required for the incident flow: pause() → this →
    /// registerPool() with corrected accounts → verify → unpause().
    function unregisterPool(bytes32 id) external onlyOwner {
        if (frozen) revert Frozen();
        if (pools[id].swapState == 0) revert NotRegistered();
        delete pools[id];
        emit PoolUnregistered(id);
    }

    function freeze() external onlyOwner {
        frozen = true;
        emit RegistryFrozen();
    }

    // ── pause (trading kill switch; independent of freeze) ──────────────────
    /// Callable by the pauser OR the owner. Idempotent — a 3am double-pause
    /// must not revert.
    function pause() external {
        if (msg.sender != pauser && msg.sender != owner) revert NotPauser();
        paused = true;
        emit PausedBy(msg.sender);
    }

    /// Owner-only (not the pauser) — bounds a compromised pauser key to an
    /// owner-undoable DoS, and prevents flapping during an incident.
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// Rotates the pauser. Zero address disables pauser-initiated pause with
    /// no special-cased branch elsewhere — pause() simply never matches it.
    function setPauser(address p) external onlyOwner {
        emit PauserSet(pauser, p);
        pauser = p;
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
        ICrossProgramInvocation.AccountMeta[] memory m = new ICrossProgramInvocation.AccountMeta[](14);
        m[0] = _ro(p.swapState);
        m[1] = _ro(p.authority);
        m[2] = _signer(HELPER.pda(address(this)));
        m[3] = _w(p.poolMint);
        m[4] = _w(HELPER.ata(msg.sender, p.poolMint));
        m[5] = _w(p.vaultA);
        m[6] = _w(p.vaultB);
        m[7] = _w(HELPER.ata(msg.sender, p.mintA));
        m[8] = _w(HELPER.ata(msg.sender, p.mintB));
        m[9] = _ro(p.mintA);
        m[10] = _ro(p.mintB);
        m[11] = _ro(TOKEN_PROGRAM);
        m[12] = _ro(TOKEN_PROGRAM);
        m[13] = _ro(TOKEN_PROGRAM);
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
        // _swap already computes (and now returns) this exact before/after
        // delta on this exact ATA internally — nothing moves between a
        // separate read here and the one inside _swap, so reusing the
        // return value drops 2 precompile reads + 1 ATA derivation vs.
        // re-deriving and re-reading outAta ourselves.
        uint64 got = _swap(poolId, aToB, 0x01, amountIn, 1);
        // lp = floor(got × lpSupply / postSwapReserveOut), shaved 0.1% so the
        // pool's ceil-div token requirement never exceeds `got`.
        uint64 supply = CPI.account_u64_at(p.poolMint, MINT_SUPPLY_OFFSET);
        // reserveOut is the LP-OWNED reserve, not the raw vault balance: v2
        // accrues protocol fees into a counter inside swap state rather than
        // minting fee-LP, so `vault` overstates what LP actually owns once a
        // counter is nonzero. Direction-keyed: aToB pairs
        // vaultB with protocol_fees_b (both token-B denominated), bToA pairs
        // vaultA with protocol_fees_a. Checked subtraction is intentional and
        // fail-closed: this read happens after _swap's CPI on the SAME pool
        // account already succeeded, and the v2 program refuses any non-v2
        // state (state.rs:78-86) — the invariant counter <= vault holds
        // atomically inside this tx, so the only way this can revert is the
        // program's own invariant being broken, which should halt, not
        // silently mis-price the deposit.
        uint64 vaultOut = CPI.account_u64_at(aToB ? p.vaultB : p.vaultA, TOKEN_AMOUNT_OFFSET);
        uint64 counterOut = CPI.account_u64_at(p.swapState, aToB ? PROTOCOL_FEES_B_OFFSET : PROTOCOL_FEES_A_OFFSET);
        uint64 reserveOut = vaultOut - counterOut;
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
    /// THE CHOKEPOINT: every trading path (swap, swapExactOut, addLiquidity,
    /// removeLiquidity, zapIn, route, _swap) resolves its pool here FIRST,
    /// before any create_ata/CPI.invoke — so a single check here is a
    /// complete trading kill switch. Checked before the UnknownPool lookup so
    /// the revert is a stable `Paused` whether or not the id is registered, and
    /// so we fail fast without loading the pool struct. (It does NOT hide the
    /// registry — `pools` is public and readable paused or not.)
    function _pool(bytes32 id) internal view returns (Pool memory p) {
        if (paused) revert Paused();
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
        bytes32 srcAta = HELPER.ata(msg.sender, srcMint);
        bytes32 dstAta = HELPER.ata(msg.sender, dstMint);
        uint64 before = CPI.account_u64_at(dstAta, TOKEN_AMOUNT_OFFSET);
        // tag 0x06 (exact-out) bounds the INPUT side — the pre-CPI source
        // balance is only needed for that tag, so the extra precompile read
        // is skipped on the hot exact-in (0x01) path.
        uint64 srcBefore;
        if (tag == 0x06) srcBefore = CPI.account_u64_at(srcAta, TOKEN_AMOUNT_OFFSET);
        ICrossProgramInvocation.AccountMeta[] memory m = new ICrossProgramInvocation.AccountMeta[](13);
        // meta[0] is WRITABLE (was RO in v1) — Swap/SwapExactOut now write
        // the protocol_fees_a/b accrual counter into pool state on every
        // trade (program/src/instruction.rs:171-187).
        m[0] = _w(p.swapState);
        m[1] = _ro(p.authority);
        m[2] = _signer(HELPER.pda(address(this)));
        m[3] = _w(srcAta);
        m[4] = _w(srcVault);
        m[5] = _w(dstVault);
        m[6] = _w(dstAta);
        m[7] = _w(p.poolMint);
        m[8] = _ro(srcMint);
        m[9] = _ro(dstMint);
        m[10] = _ro(TOKEN_PROGRAM);
        m[11] = _ro(TOKEN_PROGRAM);
        m[12] = _ro(TOKEN_PROGRAM);
        CPI.invoke(DEX_PROGRAM, m, abi.encodePacked(bytes1(tag), _le(x), _le(y)));
        out = CPI.account_u64_at(dstAta, TOKEN_AMOUNT_OFFSET) - before;
        // Defense-in-depth mirror of the DEX program's own on-chain slippage
        // guard (processor.rs) — dispatched on `tag` because the bound
        // SEMANTICS differ: 0x01 bounds the OUTPUT (y = minOut), 0x06 bounds
        // the INPUT (y = maxIn, input-side only — mirrors EXACTLY what the
        // program checks; an output-side check on exact-out would brick
        // legitimate trades against a fee-bearing destination mint).
        if (tag == 0x01) {
            if (out < y) revert OutBelowMinimum();
        } else if (tag == 0x06) {
            uint64 spent = srcBefore - CPI.account_u64_at(srcAta, TOKEN_AMOUNT_OFFSET);
            if (spent > y) revert InAboveMaximum();
        } else {
            revert UnboundedTag();
        }
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
