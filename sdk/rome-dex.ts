// rome-dex dual-lane SDK — authority-agnostic instruction builders.
//
// DESIGN-STAGE STUB. Typechecks + matches the on-chain account order in
// ../program/src/instruction.rs, but pool-address constants are TODO
// (filled post-deploy) and this has NOT been run against chain.
//
// -----------------------------------------------------------------------------
// The dual-lane thesis
// -----------------------------------------------------------------------------
// rome-dex is a fork of spl-token-swap. Every instruction takes an `authority`
// signer and operates on THAT authority's ATAs. The authority does not care
// whether it is:
//   - a Solana wallet pubkey (Solana lane: Phantom/direct signs the tx), OR
//   - an EVM user's Rome `external_auth` PDA (EVM lane: MetaMask signs an EVM
//     tx to the CPI precompile 0xFF..08; Rome auto-signs for the user's PDA).
//
// So a single builder emits ONE `RomeDexInstruction { program, accounts, data }`
// that is usable on BOTH lanes:
//   - EVM lane:   wrap it as `CPI.invoke(program, accounts, data)` calldata
//                 (see toCpiInvokeArgs / lib/cpi-precompile.ts AccountMeta shape).
//   - Solana lane: submit it directly as a Solana Instruction
//                 (see toSolanaInstruction / @solana/web3.js).
//
// The ONLY per-lane difference is how `authority` is produced:
//   - Solana wallet:      authorityFromSolana(wallet.publicKey)
//   - EVM EOA (Rome):     authorityFromEvm(eoaHexAddress)  -> deriveRomeUserPda
// Everything downstream (account order, data encoding, ATA derivation) is shared.

import { PublicKey, SystemProgram } from '@solana/web3.js';

const SystemProgramId = SystemProgram.programId;

// -----------------------------------------------------------------------------
// Program IDs / well-known Solana programs
// -----------------------------------------------------------------------------

/// Rome EVM program (devnet primary, hosts Hadrian 200010). Source of the
/// `external_auth` PDA for the EVM lane. Canonical in rome-protocol/registry
/// programs/index.json#primary[devnet] — mirrored here for the stub only.
export const ROME_EVM_PROGRAM = new PublicKey(
  'RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf',
);

/// rome-dex program id. TODO: fill post-deploy (fork of spl-token-swap; the
/// crate/program is renamed rome-dex only after a baseline build passes).
export const ROME_DEX_PROGRAM = new PublicKey(
  '11111111111111111111111111111111', // TODO(post-deploy): replace with rome-dex program id
);

export const SPL_TOKEN_PROGRAM = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

/// EVM CPI precompile — every Rome EVM network. An EVM tx whose `to` is this
/// address is interpreted as `invoke(bytes32 program, AccountMeta[], bytes)`
/// and routed into Solana.
export const CPI_PRECOMPILE = '0xFF00000000000000000000000000000000000008' as const;

// -----------------------------------------------------------------------------
// Pool constants — TODO: fill post-deploy from the initialized rome-dex pool.
// The pool + its vaults/mints are the app's own ALT (Jupiter-style) so the EVM
// lane lands as a single atomic leg. `swapAuthority` is derived, not a constant.
// -----------------------------------------------------------------------------

// SwapV2 drops the compiled-in fee-LP account entirely — the
// owner's slice of the trade fee accrues to a counter inside swap state
// (protocol_fees_a/b) instead of minting fee-LP into a dedicated account.
// `RomeDexPool` has no such field; collecting the counters is
// `buildCollectProtocolFees`.
export type RomeDexPool = {
  /// Token-swap state account (the "swap" account).
  swap: PublicKey;
  /// Pool LP token mint (SPL -> auto-ERC20 on Rome; dual-lane LP token).
  poolMint: PublicKey;
  /// Pool-owned vault holding token A (owned by swapAuthority).
  swapTokenA: PublicKey;
  /// Pool-owned vault holding token B (owned by swapAuthority).
  swapTokenB: PublicKey;
  /// Token A SPL mint.
  mintA: PublicKey;
  /// Token B SPL mint.
  mintB: PublicKey;
  /// SPL token program for token A (usually SPL_TOKEN_PROGRAM).
  tokenProgramA: PublicKey;
  /// SPL token program for token B.
  tokenProgramB: PublicKey;
  /// SPL token program for the pool/LP mint.
  poolTokenProgram: PublicKey;
};

/// TODO(post-deploy): populate from the on-chain initialized pool + registry
/// chains/200010-hadrian. All-zero placeholder so the stub typechecks.
const TODO_PK = new PublicKey('11111111111111111111111111111111');
export const POOL: RomeDexPool = {
  swap: TODO_PK, // TODO(post-deploy)
  poolMint: TODO_PK, // TODO(post-deploy)
  swapTokenA: TODO_PK, // TODO(post-deploy)
  swapTokenB: TODO_PK, // TODO(post-deploy)
  mintA: TODO_PK, // TODO(post-deploy)
  mintB: TODO_PK, // TODO(post-deploy)
  tokenProgramA: SPL_TOKEN_PROGRAM,
  tokenProgramB: SPL_TOKEN_PROGRAM,
  poolTokenProgram: SPL_TOKEN_PROGRAM,
};

// -----------------------------------------------------------------------------
// AccountMeta / instruction shapes
//
// Cross-lane AccountMeta. Field order matches the CPI precompile's
// ICrossProgramInvocation.AccountMeta { pubkey, is_signer, is_writable }
// (the CPI precompile ABI) AND Solana's AccountMeta. We carry the pubkey
// as a web3.js PublicKey internally and project to the lane-specific shape.
// -----------------------------------------------------------------------------

export type AccountMeta = {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
};

/// The single object both lanes consume.
export type RomeDexInstruction = {
  /// Solana program the instruction targets (rome-dex program id).
  program: PublicKey;
  accounts: AccountMeta[];
  /// Instruction data, hex (0x-prefixed) — matches SwapInstruction::pack().
  data: `0x${string}`;
};

// -----------------------------------------------------------------------------
// Authority — lane-agnostic. A rome-dex authority is just a Solana pubkey; the
// only difference is where it comes from.
// -----------------------------------------------------------------------------

export type Authority = {
  /// The signing pubkey (Solana wallet, OR the EVM user's external_auth PDA).
  pubkey: PublicKey;
  /// Which lane produced it — informational; account order is identical.
  lane: 'solana' | 'evm';
};

/// Solana lane: the authority IS the wallet pubkey.
export function authorityFromSolana(walletPubkey: PublicKey): Authority {
  return { pubkey: walletPubkey, lane: 'solana' };
}

/// EVM lane: the authority is the EVM EOA's Rome external_auth PDA.
export function authorityFromEvm(evmAddress: `0x${string}`): Authority {
  return { pubkey: deriveRomeUserPda(evmAddress), lane: 'evm' };
}

// -----------------------------------------------------------------------------
// Derivation helpers
// -----------------------------------------------------------------------------

/// Rome `external_auth` PDA for an EVM EOA. Mirrors the derivation Rome uses
/// when auto-signing at the CPI precompile:
///   PDA(["EXTERNAL_AUTHORITY", eoaBytes20], ROME_EVM_PROGRAM)
export function deriveRomeUserPda(evmAddress: `0x${string}`): PublicKey {
  const eoaBytes = Buffer.from(evmAddress.slice(2), 'hex'); // 20 bytes
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('EXTERNAL_AUTHORITY'), eoaBytes],
    ROME_EVM_PROGRAM,
  );
  return pda;
}

/// Associated token account for (owner, mint) under a given token program.
/// The classic ATA derivation.
export function deriveAta(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = SPL_TOKEN_PROGRAM,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  );
  return ata;
}

/// rome-dex swap authority PDA (owns the pool vaults + LP mint).
/// From program/src/processor.rs:269 —
///   find_program_address([swap_account_bytes], rome_dex_program_id).
export function deriveSwapAuthority(
  swap: PublicKey,
  programId: PublicKey = ROME_DEX_PROGRAM,
): PublicKey {
  const [authority] = PublicKey.findProgramAddressSync(
    [swap.toBuffer()],
    programId,
  );
  return authority;
}

// -----------------------------------------------------------------------------
// Data encoding — mirrors SwapInstruction::pack() (instruction.rs).
// tag byte + little-endian u64 args.
// -----------------------------------------------------------------------------

const TAG = {
  Initialize: 0,
  Swap: 1,
  DepositAllTokenTypes: 2,
  WithdrawAllTokenTypes: 3,
  DepositSingleTokenTypeExactAmountIn: 4,
  WithdrawSingleTokenTypeExactAmountOut: 5,
  SwapExactOut: 6,
  CreatePool: 7,
  InitializeConfig: 8,
  SetTreasury: 9,
  TransferAdmin: 10,
  AcceptAdmin: 11,
  CollectProtocolFees: 12,
  SetPoolCreation: 13,
} as const;

const u64le = (v: bigint | number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

const pack = (tag: number, ...args: (bigint | number)[]): `0x${string}` =>
  `0x${Buffer.concat([Buffer.from([tag]), ...args.map(u64le)]).toString('hex')}`;

// -----------------------------------------------------------------------------
// Shared user-ata / pool-account inputs
// -----------------------------------------------------------------------------

/// The user's ATAs for the two pool tokens + the LP token. Callers may pass
/// these explicitly or derive them from the authority via `userAtasFor()`.
export type UserAtas = {
  tokenA: PublicKey;
  tokenB: PublicKey;
  /// LP-token ATA (dual-lane held). Required for add/remove liquidity.
  poolToken?: PublicKey;
};

/// Derive the standard user ATAs for a pool from an authority.
export function userAtasFor(authority: Authority, pool: RomeDexPool): UserAtas {
  return {
    tokenA: deriveAta(authority.pubkey, pool.mintA, pool.tokenProgramA),
    tokenB: deriveAta(authority.pubkey, pool.mintB, pool.tokenProgramB),
    poolToken: deriveAta(authority.pubkey, pool.poolMint, pool.poolTokenProgram),
  };
}

const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const signer = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: false });

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

export type SwapDirection = 'AToB' | 'BToA';

export type BuildSwapParams = {
  authority: Authority;
  poolAccounts: RomeDexPool;
  /// Direction of the swap. Selects which pool vault is source vs destination
  /// and which of the user's ATAs is source vs destination.
  direction: SwapDirection;
  userAtas: UserAtas;
  amounts: { amountIn: bigint; minimumAmountOut: bigint };
  /// Program to target. Defaults to `ROME_DEX_PROGRAM` (still the all-zero
  /// placeholder until post-deploy) — the dress-rehearsal harness and any
  /// caller targeting a non-default deployment (e.g. the throwaway
  /// devnet-rehearsal program id) pass this explicitly. Threaded through
  /// `deriveSwapAuthority` and the returned `program:` field.
  programId?: PublicKey;
};

/// Build a Swap instruction.
///
/// Account order — SwapInstruction::Swap (instruction.rs:171-187, swap() builder):
/// 13 metas, no optional host-fee trailer — v2 has no fee account at all; the
/// owner's slice of the trade fee accrues into a counter in swap state
/// (protocol_fees_a/b), which this instruction WRITES (meta 0 is writable).
///   0.  [w] Token-swap                      (swap; writes the accrual counter)
///   1.  [] swap authority                   (derived)
///   2.  [signer] user transfer authority    (authority.pubkey)
///   3.  [w] source user ATA                 (userAtas source)
///   4.  [w] swap SOURCE vault               (pool source vault)
///   5.  [w] swap DESTINATION vault          (pool dest vault)
///   6.  [w] destination user ATA            (userAtas dest)
///   7.  [w] pool mint                       (poolMint)
///   8.  [] source mint                      (source SPL mint)
///   9.  [] destination mint                 (dest SPL mint)
///   10. [] source token program
///   11. [] destination token program
///   12. [] pool token program
export function buildSwap(p: BuildSwapParams): RomeDexInstruction {
  const programId = p.programId ?? ROME_DEX_PROGRAM;
  const pool = p.poolAccounts;
  const authority = deriveSwapAuthority(pool.swap, programId);
  const aToB = p.direction === 'AToB';

  const srcUser = aToB ? p.userAtas.tokenA : p.userAtas.tokenB;
  const dstUser = aToB ? p.userAtas.tokenB : p.userAtas.tokenA;
  const srcVault = aToB ? pool.swapTokenA : pool.swapTokenB;
  const dstVault = aToB ? pool.swapTokenB : pool.swapTokenA;
  const srcMint = aToB ? pool.mintA : pool.mintB;
  const dstMint = aToB ? pool.mintB : pool.mintA;
  const srcTokenProg = aToB ? pool.tokenProgramA : pool.tokenProgramB;
  const dstTokenProg = aToB ? pool.tokenProgramB : pool.tokenProgramA;

  const accounts: AccountMeta[] = [
    rw(pool.swap), // 0 — writable (writes the accrual counter)
    ro(authority), // 1
    signer(p.authority.pubkey), // 2
    rw(srcUser), // 3
    rw(srcVault), // 4
    rw(dstVault), // 5
    rw(dstUser), // 6
    rw(pool.poolMint), // 7
    ro(srcMint), // 8
    ro(dstMint), // 9
    ro(srcTokenProg), // 10
    ro(dstTokenProg), // 11
    ro(pool.poolTokenProgram), // 12
  ];

  return {
    program: programId,
    accounts,
    data: pack(TAG.Swap, p.amounts.amountIn, p.amounts.minimumAmountOut),
  };
}

export type BuildSwapExactOutParams = {
  authority: Authority;
  poolAccounts: RomeDexPool;
  direction: SwapDirection;
  userAtas: UserAtas;
  /// Exact destination amount to receive, and the max source the user will pay.
  amounts: { amountOut: bigint; maximumAmountIn: bigint };
  /// See `BuildSwapParams.programId`.
  programId?: PublicKey;
};

/// Build a SwapExactOut instruction. Identical account layout to `buildSwap`
/// (SwapInstruction::SwapExactOut, tag 6) — the program solves the curve for
/// the required input, delivers exactly `amountOut`, and reverts if the input
/// would exceed `maximumAmountIn`.
export function buildSwapExactOut(p: BuildSwapExactOutParams): RomeDexInstruction {
  const swap = buildSwap({
    authority: p.authority,
    poolAccounts: p.poolAccounts,
    direction: p.direction,
    userAtas: p.userAtas,
    amounts: { amountIn: 0n, minimumAmountOut: 0n }, // reuse account layout
    programId: p.programId,
  });
  return {
    ...swap,
    data: pack(TAG.SwapExactOut, p.amounts.amountOut, p.amounts.maximumAmountIn),
  };
}

export type BuildAddLiquidityParams = {
  authority: Authority;
  poolAccounts: RomeDexPool;
  userAtas: UserAtas; // tokenA, tokenB, poolToken (LP destination) required
  amounts: {
    poolTokenAmount: bigint;
    maximumTokenAAmount: bigint;
    maximumTokenBAmount: bigint;
  };
  /// See `BuildSwapParams.programId`.
  programId?: PublicKey;
};

/// Build a DepositAllTokenTypes (add liquidity) instruction.
///
/// Account order — SwapInstruction::DepositAllTokenTypes
/// (instruction.rs:194-208, deposit_all_token_types() builder) — UNCHANGED
/// from v1 (tag 2 shape is untouched by SwapV2):
///   0.  [] Token-swap
///   1.  [] swap authority
///   2.  [signer] user transfer authority
///   3.  [w] user token A source ATA
///   4.  [w] user token B source ATA
///   5.  [w] swap token A vault
///   6.  [w] swap token B vault
///   7.  [w] pool mint
///   8.  [w] destination pool-token (LP) ATA
///   9.  [] token A mint
///   10. [] token B mint
///   11. [] token A program
///   12. [] token B program
///   13. [] pool token program
export function buildAddLiquidity(p: BuildAddLiquidityParams): RomeDexInstruction {
  const programId = p.programId ?? ROME_DEX_PROGRAM;
  const pool = p.poolAccounts;
  const authority = deriveSwapAuthority(pool.swap, programId);
  if (!p.userAtas.poolToken) {
    throw new Error('buildAddLiquidity: userAtas.poolToken (LP ATA) is required');
  }

  const accounts: AccountMeta[] = [
    ro(pool.swap), // 0
    ro(authority), // 1
    signer(p.authority.pubkey), // 2
    rw(p.userAtas.tokenA), // 3
    rw(p.userAtas.tokenB), // 4
    rw(pool.swapTokenA), // 5
    rw(pool.swapTokenB), // 6
    rw(pool.poolMint), // 7
    rw(p.userAtas.poolToken), // 8
    ro(pool.mintA), // 9
    ro(pool.mintB), // 10
    ro(pool.tokenProgramA), // 11
    ro(pool.tokenProgramB), // 12
    ro(pool.poolTokenProgram), // 13
  ];

  return {
    program: programId,
    accounts,
    data: pack(
      TAG.DepositAllTokenTypes,
      p.amounts.poolTokenAmount,
      p.amounts.maximumTokenAAmount,
      p.amounts.maximumTokenBAmount,
    ),
  };
}

export type BuildRemoveLiquidityParams = {
  authority: Authority;
  poolAccounts: RomeDexPool;
  userAtas: UserAtas; // tokenA, tokenB (credit) + poolToken (LP source) required
  amounts: {
    poolTokenAmount: bigint;
    minimumTokenAAmount: bigint;
    minimumTokenBAmount: bigint;
  };
  /// See `BuildSwapParams.programId`.
  programId?: PublicKey;
};

/// Build a WithdrawAllTokenTypes (remove liquidity) instruction.
///
/// Account order — SwapInstruction::WithdrawAllTokenTypes
/// (instruction.rs:215-229, withdraw_all_token_types() builder): 14 metas —
/// v2 has no fee account slot (D8: protocol fees are SwapV2 counters, not a
/// spendable account), everything after it shifts down one vs. v1.
///   0.  [] Token-swap
///   1.  [] swap authority
///   2.  [signer] user transfer authority
///   3.  [w] pool mint
///   4.  [w] SOURCE pool-token (LP) ATA (burned)
///   5.  [w] swap token A vault (withdraw from)
///   6.  [w] swap token B vault (withdraw from)
///   7.  [w] user token A destination ATA (credit)
///   8.  [w] user token B destination ATA (credit)
///   9.  [] token A mint
///   10. [] token B mint
///   11. [] pool token program
///   12. [] token A program
///   13. [] token B program
export function buildRemoveLiquidity(p: BuildRemoveLiquidityParams): RomeDexInstruction {
  const programId = p.programId ?? ROME_DEX_PROGRAM;
  const pool = p.poolAccounts;
  const authority = deriveSwapAuthority(pool.swap, programId);
  if (!p.userAtas.poolToken) {
    throw new Error('buildRemoveLiquidity: userAtas.poolToken (LP ATA) is required');
  }

  const accounts: AccountMeta[] = [
    ro(pool.swap), // 0
    ro(authority), // 1
    signer(p.authority.pubkey), // 2
    rw(pool.poolMint), // 3
    rw(p.userAtas.poolToken), // 4
    rw(pool.swapTokenA), // 5
    rw(pool.swapTokenB), // 6
    rw(p.userAtas.tokenA), // 7
    rw(p.userAtas.tokenB), // 8
    ro(pool.mintA), // 9
    ro(pool.mintB), // 10
    ro(pool.poolTokenProgram), // 11
    ro(pool.tokenProgramA), // 12
    ro(pool.tokenProgramB), // 13
  ];

  return {
    program: programId,
    accounts,
    data: pack(
      TAG.WithdrawAllTokenTypes,
      p.amounts.poolTokenAmount,
      p.amounts.minimumTokenAAmount,
      p.amounts.minimumTokenBAmount,
    ),
  };
}

/// rome-dex protocol config PDA `[b"config"]` (admin/treasury/mode).
/// Read by CreatePool (gate) and CollectProtocolFees (destination + mode);
/// written by InitializeConfig/SetTreasury/TransferAdmin/AcceptAdmin/
/// SetPoolCreation.
export function deriveConfigPda(programId: PublicKey = ROME_DEX_PROGRAM): PublicKey {
  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    programId,
  );
  return config;
}

export type BuildCollectProtocolFeesParams = {
  poolAccounts: RomeDexPool;
  /// Destination token accounts — owner MUST equal config.treasury or the
  /// program rejects the instruction; the program reads the treasury live,
  /// never caches it.
  destinationA: PublicKey;
  destinationB: PublicKey;
  /// See `BuildSwapParams.programId`.
  programId?: PublicKey;
};

/// Build a CollectProtocolFees instruction (tag 12). PERMISSIONLESS —
/// zero instruction data; the amount moved is read from the swap-state
/// counters, never from caller input, and the destination owner is checked
/// against `config.treasury`, never trusted from caller input
/// (instruction.rs:331-347, processor.rs:550-561, builder :968-980).
///
/// 11 metas, per-side token programs (indices 9/10) — a mixed-vault pool
/// (vault A and vault B under different token programs, e.g. one side
/// Token-2022) needs both; a single shared program can only ever serve one
/// side's vault.
///   0.  [w] Pool
///   1.  [] Pool authority
///   2.  [w] Vault A
///   3.  [w] Vault B
///   4.  [w] Destination A (owner must == config.treasury)
///   5.  [w] Destination B (owner must == config.treasury)
///   6.  [] Mint A
///   7.  [] Mint B
///   8.  [] Config PDA
///   9.  [] Token program A (must own Vault A)
///   10. [] Token program B (must own Vault B)
export function buildCollectProtocolFees(p: BuildCollectProtocolFeesParams): RomeDexInstruction {
  const programId = p.programId ?? ROME_DEX_PROGRAM;
  const pool = p.poolAccounts;
  const authority = deriveSwapAuthority(pool.swap, programId);
  const config = deriveConfigPda(programId);

  const accounts: AccountMeta[] = [
    rw(pool.swap), // 0
    ro(authority), // 1
    rw(pool.swapTokenA), // 2
    rw(pool.swapTokenB), // 3
    rw(p.destinationA), // 4
    rw(p.destinationB), // 5
    ro(pool.mintA), // 6
    ro(pool.mintB), // 7
    ro(config), // 8
    ro(pool.tokenProgramA), // 9
    ro(pool.tokenProgramB), // 10
  ];

  return {
    program: programId,
    accounts,
    data: `0x${Buffer.from([TAG.CollectProtocolFees]).toString('hex')}`,
  };
}

// -----------------------------------------------------------------------------
// Genesis / admin builders (dress-rehearsal harness).
//
// Unlike the hot-path builders above, these take `programId` EXPLICITLY (no
// default to `ROME_DEX_PROGRAM`) — that constant is still the all-zero
// placeholder, and a genesis/admin instruction silently targeting it would
// be a real hazard, not a convenience default. The dress-rehearsal ceremony
// and any real deploy always know their program id up front.
// -----------------------------------------------------------------------------

const pubkeyBytes = (pk: PublicKey): Buffer => Buffer.from(pk.toBytes());

/// tag + raw byte buffers (pubkeys, u8 mode flags, …) — the sibling of
/// `pack()` above for instructions whose payload isn't u64 args.
const packBytes = (tag: number, ...parts: Buffer[]): `0x${string}` =>
  `0x${Buffer.concat([Buffer.from([tag]), ...parts]).toString('hex')}`;

/// `Fees` wire shape — 8 u64 LE fields, mirroring
/// `program/src/curve/fees.rs` / `deploy/lib/genesis-codec.mjs::encodeFees`.
/// `ownerWithdrawFee*`/`hostFee*` default to 0n — no curated tier ever sets
/// them, but the on-chain layout is a fixed 64 bytes so they must still be
/// emitted.
export type FeesInput = {
  tradeFeeNumerator: bigint;
  tradeFeeDenominator: bigint;
  ownerTradeFeeNumerator: bigint;
  ownerTradeFeeDenominator: bigint;
  ownerWithdrawFeeNumerator?: bigint;
  ownerWithdrawFeeDenominator?: bigint;
  hostFeeNumerator?: bigint;
  hostFeeDenominator?: bigint;
};

/// Encode a `Fees` struct — matches `program/src/instruction.rs`'s pack arm
/// for `CreatePool` and `deploy/lib/genesis-codec.mjs::encodeFees` field order.
export function encodeFees(f: FeesInput): Buffer {
  return Buffer.concat([
    u64le(f.tradeFeeNumerator),
    u64le(f.tradeFeeDenominator),
    u64le(f.ownerTradeFeeNumerator),
    u64le(f.ownerTradeFeeDenominator),
    u64le(f.ownerWithdrawFeeNumerator ?? 0n),
    u64le(f.ownerWithdrawFeeDenominator ?? 0n),
    u64le(f.hostFeeNumerator ?? 0n),
    u64le(f.hostFeeDenominator ?? 0n),
  ]);
}

/// `curve_type` byte (0 = ConstantProduct) + 32-byte all-zero calculator
/// region — the only curve genesis ever creates. Matches
/// `harness/createPoolLib.mjs::CURVE_CONSTANT_PRODUCT`.
export const CURVE_CONSTANT_PRODUCT: Buffer = Buffer.concat([Buffer.from([0]), Buffer.alloc(32)]);

/// Every PDA `CreatePool` needs, derived the SAME way as
/// `harness/createPoolLib.mjs::resolveCreatePool` (the on-chain-proven
/// derivation) — reimplemented here (not imported) so the SDK has no
/// dependency on the harness package; the byte/meta-order pin tests
/// (`harness/rome-dex-sdk.test.mjs`) assert the two never drift apart.
export function deriveCreatePoolAddresses(
  mintA: PublicKey,
  mintB: PublicKey,
  feeBps: number,
  programId: PublicKey,
): {
  pool: PublicKey; poolBump: number;
  swapAuthority: PublicKey;
  lpMint: PublicKey; lpBump: number;
  dest: PublicKey;
  config: PublicKey;
} {
  const feeBpsBuf = Buffer.alloc(2);
  feeBpsBuf.writeUInt16LE(feeBps);
  const [pool, poolBump] = PublicKey.findProgramAddressSync(
    [Buffer.from('cp_pool'), mintA.toBuffer(), mintB.toBuffer(), feeBpsBuf],
    programId,
  );
  const swapAuthority = deriveSwapAuthority(pool, programId);
  const [lpMint, lpBump] = PublicKey.findProgramAddressSync(
    [Buffer.from('cp_lp'), pool.toBuffer()],
    programId,
  );
  const [dest] = PublicKey.findProgramAddressSync(
    [Buffer.from('cp_dest'), pool.toBuffer()],
    programId,
  );
  const config = deriveConfigPda(programId);
  return { pool, poolBump, swapAuthority, lpMint, lpBump, dest, config };
}

export type BuildCreatePoolParams = {
  programId: PublicKey;
  /// Creator/payer — a Solana wallet, or an EVM user's `external_auth` PDA
  /// (CPI-precompile-signed). Under `pool_creation_mode` 0 this must equal
  /// `config.admin`.
  payer: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  feeBps: number;
  fees: FeesInput;
  /// Authority PDA's pre-created + pre-funded ATAs for mintA/mintB. The
  /// program does not create these — the caller must, before this
  /// instruction runs.
  vaultA: PublicKey;
  vaultB: PublicKey;
  tokenProgram?: PublicKey;
};

/// Build a CreatePool instruction (tag 7). Account order — 12 metas,
/// `harness/createPoolLib.mjs::buildCreatePoolIx` field-for-field (that
/// builder is the on-chain-proven producer; pinned by
/// `harness/rome-dex-sdk.test.mjs`):
///   0. [signer,w] payer   1. [w] pool   2. [] pool authority
///   3. [] mint A   4. [] mint B   5. [w] vault A   6. [w] vault B
///   7. [w] LP mint   8. [w] destination LP account
///   9. [] token program   10. [] system program   11. [] config PDA
export function buildCreatePool(p: BuildCreatePoolParams): RomeDexInstruction {
  const tokenProgram = p.tokenProgram ?? SPL_TOKEN_PROGRAM;
  const { pool, poolBump, swapAuthority, lpMint, lpBump, dest, config } =
    deriveCreatePoolAddresses(p.mintA, p.mintB, p.feeBps, p.programId);

  const accounts: AccountMeta[] = [
    { pubkey: p.payer, isSigner: true, isWritable: true }, // 0
    rw(pool), // 1
    ro(swapAuthority), // 2
    ro(p.mintA), // 3
    ro(p.mintB), // 4
    rw(p.vaultA), // 5
    rw(p.vaultB), // 6
    rw(lpMint), // 7
    rw(dest), // 8
    ro(tokenProgram), // 9
    ro(SystemProgramId), // 10
    ro(config), // 11
  ];

  const feeBpsBuf = Buffer.alloc(2);
  feeBpsBuf.writeUInt16LE(p.feeBps);
  const data = packBytes(
    TAG.CreatePool,
    feeBpsBuf,
    Buffer.from([poolBump, lpBump]),
    encodeFees(p.fees),
    CURVE_CONSTANT_PRODUCT,
  );

  return { program: p.programId, accounts, data };
}

export type BuildInitializeConfigParams = {
  programId: PublicKey;
  payer: PublicKey;
  upgradeAuthority: PublicKey;
  programData: PublicKey;
  admin: PublicKey;
  treasury: PublicKey;
  /// 0 = admin-only, 1 = permissionless.
  mode: number;
  config?: PublicKey;
};

/// Build an InitializeConfig instruction (tag 8) — one-shot, upgrade-
/// authority-gated. Account order mirrors the ceremony's own ix
/// (`deploy/genesis-pools.mjs:677-687`) and `instruction.rs::initialize_config`:
///   0. [signer,w] payer   1. [signer] upgrade authority
///   2. [w] config PDA   3. [] ProgramData   4. [] system program
export function buildInitializeConfig(p: BuildInitializeConfigParams): RomeDexInstruction {
  const config = p.config ?? deriveConfigPda(p.programId);
  const accounts: AccountMeta[] = [
    { pubkey: p.payer, isSigner: true, isWritable: true }, // 0
    { pubkey: p.upgradeAuthority, isSigner: true, isWritable: false }, // 1
    rw(config), // 2
    ro(p.programData), // 3
    ro(SystemProgramId), // 4
  ];
  const data = packBytes(
    TAG.InitializeConfig,
    pubkeyBytes(p.admin),
    pubkeyBytes(p.treasury),
    Buffer.from([p.mode]),
  );
  return { program: p.programId, accounts, data };
}

export type BuildSetTreasuryParams = {
  programId: PublicKey;
  admin: PublicKey;
  treasury: PublicKey;
  config?: PublicKey;
};

/// Build a SetTreasury instruction (tag 9). `0. [w] config  1. [signer] admin`.
export function buildSetTreasury(p: BuildSetTreasuryParams): RomeDexInstruction {
  const config = p.config ?? deriveConfigPda(p.programId);
  const accounts: AccountMeta[] = [rw(config), { pubkey: p.admin, isSigner: true, isWritable: false }];
  const data = packBytes(TAG.SetTreasury, pubkeyBytes(p.treasury));
  return { program: p.programId, accounts, data };
}

export type BuildTransferAdminParams = {
  programId: PublicKey;
  admin: PublicKey;
  /// Proposed new admin. `PublicKey.default` cancels a pending transfer.
  pendingAdmin: PublicKey;
  config?: PublicKey;
};

/// Build a TransferAdmin instruction (tag 10), step 1 of 2 — writes
/// `pending_admin` only. `0. [w] config  1. [signer] current admin`.
export function buildTransferAdmin(p: BuildTransferAdminParams): RomeDexInstruction {
  const config = p.config ?? deriveConfigPda(p.programId);
  const accounts: AccountMeta[] = [rw(config), { pubkey: p.admin, isSigner: true, isWritable: false }];
  const data = packBytes(TAG.TransferAdmin, pubkeyBytes(p.pendingAdmin));
  return { program: p.programId, accounts, data };
}

export type BuildAcceptAdminParams = {
  programId: PublicKey;
  pendingAdmin: PublicKey;
  config?: PublicKey;
};

/// Build an AcceptAdmin instruction (tag 11), step 2 of 2 — zero payload.
/// `0. [w] config  1. [signer] pending admin`.
export function buildAcceptAdmin(p: BuildAcceptAdminParams): RomeDexInstruction {
  const config = p.config ?? deriveConfigPda(p.programId);
  const accounts: AccountMeta[] = [rw(config), { pubkey: p.pendingAdmin, isSigner: true, isWritable: false }];
  const data = packBytes(TAG.AcceptAdmin);
  return { program: p.programId, accounts, data };
}

export type BuildSetPoolCreationParams = {
  programId: PublicKey;
  admin: PublicKey;
  /// 0 = admin-only, 1 = permissionless.
  mode: number;
  config?: PublicKey;
};

/// Build a SetPoolCreation instruction (tag 13). `0. [w] config  1. [signer] admin`.
export function buildSetPoolCreation(p: BuildSetPoolCreationParams): RomeDexInstruction {
  const config = p.config ?? deriveConfigPda(p.programId);
  const accounts: AccountMeta[] = [rw(config), { pubkey: p.admin, isSigner: true, isWritable: false }];
  const data = packBytes(TAG.SetPoolCreation, Buffer.from([p.mode]));
  return { program: p.programId, accounts, data };
}

// -----------------------------------------------------------------------------
// Lane projections — turn one RomeDexInstruction into a lane-native shape.
// -----------------------------------------------------------------------------

const pkToBytes32Hex = (pk: PublicKey): `0x${string}` =>
  `0x${Buffer.from(pk.toBytes()).toString('hex')}`;

/// EVM lane: arguments for `CPI.invoke(bytes32 program, AccountMeta[], bytes)`.
/// AccountMeta field order = { pubkey, is_signer, is_writable }, matching
/// the CPI precompile's CPI_INVOKE_ABI. Encode with the CPI_INVOKE_ABI
/// on the caller side (viem/ethers) and send to CPI_PRECOMPILE.
export function toCpiInvokeArgs(ix: RomeDexInstruction): {
  program_id: `0x${string}`;
  accounts: { pubkey: `0x${string}`; is_signer: boolean; is_writable: boolean }[];
  data: `0x${string}`;
} {
  return {
    program_id: pkToBytes32Hex(ix.program),
    accounts: ix.accounts.map((a) => ({
      pubkey: pkToBytes32Hex(a.pubkey),
      is_signer: a.isSigner,
      is_writable: a.isWritable,
    })),
    data: ix.data,
  };
}

/// Solana lane: a plain object shaped like @solana/web3.js `TransactionInstruction`
/// input (programId + keys[] + data Buffer). Kept dependency-light — the caller
/// can `new TransactionInstruction(toSolanaInstruction(ix))`.
export function toSolanaInstruction(ix: RomeDexInstruction): {
  programId: PublicKey;
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  data: Buffer;
} {
  return {
    programId: ix.program,
    keys: ix.accounts.map((a) => ({
      pubkey: a.pubkey,
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data.slice(2), 'hex'),
  };
}
