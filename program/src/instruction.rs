//! Instruction types

#![allow(clippy::too_many_arguments)]

#[cfg(feature = "fuzz")]
use arbitrary::Arbitrary;
use {
    crate::{
        curve::{base::SwapCurve, fees::Fees},
        error::SwapError,
    },
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program_error::ProgramError,
        program_pack::Pack,
        pubkey::Pubkey,
    },
    std::{convert::TryInto, mem::size_of},
};

/// CreatePool instruction data — create a NEW pool over two existing tokens in
/// ONE call, with NO ephemeral signers (the program creates the pool state PDA +
/// the LP mint PDA via `invoke_signed`, and the vaults/fee/destination are the
/// deterministic ATAs the caller pre-creates). This is what lets the EVM lane
/// create a pool via the CPI precompile. See docs/WS2_CREATEPOOL_DESIGN.md.
#[repr(C)]
#[derive(Debug, PartialEq)]
pub struct CreatePool {
    /// all swap fees (same struct as Initialize)
    pub fees: Fees,
    /// swap curve (ConstantProduct)
    pub swap_curve: SwapCurve,
    /// fee tier in basis points — part of the pool PDA seed so (pair, fee)
    /// de-duplicates the pool space.
    pub fee_bps: u16,
    /// bump for the pool state PDA `[b"cp_pool", mint_a, mint_b, fee_bps_le]`.
    pub pool_bump: u8,
    /// bump for the LP mint PDA `[b"cp_lp", pool]`.
    pub lp_bump: u8,
}

/// Swap instruction data
#[cfg_attr(feature = "fuzz", derive(Arbitrary))]
#[repr(C)]
#[derive(Clone, Debug, PartialEq)]
pub struct Swap {
    /// SOURCE amount to transfer, output to DESTINATION is based on the
    /// exchange rate
    pub amount_in: u64,
    /// Minimum amount of DESTINATION token to output, prevents excessive
    /// slippage
    pub minimum_amount_out: u64,
}

/// SwapExactOut instruction data
#[cfg_attr(feature = "fuzz", derive(Arbitrary))]
#[repr(C)]
#[derive(Clone, Debug, PartialEq)]
pub struct SwapExactOut {
    /// Exact amount of DESTINATION token the swapper wants to receive
    pub amount_out: u64,
    /// Maximum amount of SOURCE token the swapper is willing to pay, prevents
    /// excessive slippage
    pub maximum_amount_in: u64,
}

/// DepositAllTokenTypes instruction data
#[cfg_attr(feature = "fuzz", derive(Arbitrary))]
#[repr(C)]
#[derive(Clone, Debug, PartialEq)]
pub struct DepositAllTokenTypes {
    /// Pool token amount to transfer. token_a and token_b amount are set by
    /// the current exchange rate and size of the pool
    pub pool_token_amount: u64,
    /// Maximum token A amount to deposit, prevents excessive slippage
    pub maximum_token_a_amount: u64,
    /// Maximum token B amount to deposit, prevents excessive slippage
    pub maximum_token_b_amount: u64,
}

/// WithdrawAllTokenTypes instruction data
#[cfg_attr(feature = "fuzz", derive(Arbitrary))]
#[repr(C)]
#[derive(Clone, Debug, PartialEq)]
pub struct WithdrawAllTokenTypes {
    /// Amount of pool tokens to burn. User receives an output of token a
    /// and b based on the percentage of the pool tokens that are returned.
    pub pool_token_amount: u64,
    /// Minimum amount of token A to receive, prevents excessive slippage
    pub minimum_token_a_amount: u64,
    /// Minimum amount of token B to receive, prevents excessive slippage
    pub minimum_token_b_amount: u64,
}

/// Deposit one token type, exact amount in instruction data
#[cfg_attr(feature = "fuzz", derive(Arbitrary))]
#[repr(C)]
#[derive(Clone, Debug, PartialEq)]
pub struct DepositSingleTokenTypeExactAmountIn {
    /// Token amount to deposit
    pub source_token_amount: u64,
    /// Pool token amount to receive in exchange. The amount is set by
    /// the current exchange rate and size of the pool
    pub minimum_pool_token_amount: u64,
}

/// WithdrawSingleTokenTypeExactAmountOut instruction data
#[cfg_attr(feature = "fuzz", derive(Arbitrary))]
#[repr(C)]
#[derive(Clone, Debug, PartialEq)]
pub struct WithdrawSingleTokenTypeExactAmountOut {
    /// Amount of token A or B to receive
    pub destination_token_amount: u64,
    /// Maximum amount of pool tokens to burn. User receives an output of token
    /// A or B based on the percentage of the pool tokens that are returned.
    pub maximum_pool_token_amount: u64,
}

/// `InitializeConfig` instruction data (tag 8) — see the design plan.
#[repr(C)]
#[derive(Clone, Debug, PartialEq)]
pub struct InitializeConfig {
    /// Initial protocol admin.
    pub admin: Pubkey,
    /// Initial protocol treasury (CollectProtocolFees destination owner).
    pub treasury: Pubkey,
    /// Initial `pool_creation_mode` (0 = admin-only, 1 = permissionless).
    pub mode: u8,
}

/// `SetTreasury` instruction data (tag 9).
#[repr(C)]
#[derive(Clone, Debug, PartialEq)]
pub struct SetTreasury {
    /// New treasury.
    pub treasury: Pubkey,
}

/// `TransferAdmin` instruction data (tag 10) — step 1 of the two-step
/// admin transfer; writes `pending_admin` only.
#[repr(C)]
#[derive(Clone, Debug, PartialEq)]
pub struct TransferAdmin {
    /// Proposed new admin. `Pubkey::default()` cancels a pending transfer.
    pub pending_admin: Pubkey,
}

/// `SetPoolCreation` instruction data (tag 13).
#[repr(C)]
#[derive(Clone, Debug, PartialEq)]
pub struct SetPoolCreation {
    /// New `pool_creation_mode` (0 or 1).
    pub mode: u8,
}

/// Instructions supported by the token swap program.
#[repr(C)]
#[derive(Debug, PartialEq)]
pub enum SwapInstruction {
    ///   RESERVED — tag 0 (Initialize) was permanently retired in favor of
    ///   the single creation path, `CreatePool` (tag 7). Never reassign this
    ///   tag. Dispatching it returns the named error `InstructionRetired`.
    Initialize,

    ///   Swap the tokens in the pool. No fee account, no host fee — the
    ///   owner's slice of the trade fee accrues to a counter in swap state
    ///   (SwapV2 `protocol_fees_a`/`protocol_fees_b`), which this
    ///   instruction WRITES.
    ///
    ///   0. `[writable]` Token-swap
    ///   1. `[]` swap authority
    ///   2. `[]` user transfer authority
    ///   3. `[writable]` token_(A|B) SOURCE Account, amount is transferable by
    ///      user transfer authority,
    ///   4. `[writable]` token_(A|B) Base Account to swap INTO.  Must be the
    ///      SOURCE token.
    ///   5. `[writable]` token_(A|B) Base Account to swap FROM.  Must be the
    ///      DESTINATION token.
    ///   6. `[writable]` token_(A|B) DESTINATION Account assigned to USER as
    ///      the owner.
    ///   7. `[writable]` Pool token mint
    ///   8. `[]` Token (A|B) SOURCE mint
    ///   9. `[]` Token (A|B) DESTINATION mint
    ///   10. `[]` Token (A|B) SOURCE program id
    ///   11. `[]` Token (A|B) DESTINATION program id
    ///   12. `[]` Pool Token program id
    Swap(Swap),

    ///   Deposit both types of tokens into the pool.  The output is a "pool"
    ///   token representing ownership in the pool. Inputs are converted to
    ///   the current ratio.
    ///
    ///   0. `[]` Token-swap
    ///   1. `[]` swap authority
    ///   2. `[]` user transfer authority
    ///   3. `[writable]` token_a user transfer authority can transfer amount,
    ///   4. `[writable]` token_b user transfer authority can transfer amount,
    ///   5. `[writable]` token_a Base Account to deposit into.
    ///   6. `[writable]` token_b Base Account to deposit into.
    ///   7. `[writable]` Pool MINT account, swap authority is the owner.
    ///   8. `[writable]` Pool Account to deposit the generated tokens, user is
    ///      the owner.
    ///   9. `[]` Token A mint
    ///   10. `[]` Token B mint
    ///   11. `[]` Token A program id
    ///   12. `[]` Token B program id
    ///   13. `[]` Pool Token program id
    DepositAllTokenTypes(DepositAllTokenTypes),

    ///   Withdraw both types of tokens from the pool at the current ratio,
    ///   given pool tokens. The pool tokens are burned in exchange for an
    ///   equivalent amount of token A and B.
    ///
    ///   0. `[]` Token-swap
    ///   1. `[]` swap authority
    ///   2. `[]` user transfer authority
    ///   3. `[writable]` Pool mint account, swap authority is the owner
    ///   4. `[writable]` SOURCE Pool account, amount is transferable by user
    ///      transfer authority.
    ///   5. `[writable]` token_a Swap Account to withdraw FROM.
    ///   6. `[writable]` token_b Swap Account to withdraw FROM.
    ///   7. `[writable]` token_a user Account to credit.
    ///   8. `[writable]` token_b user Account to credit.
    ///   9. `[]` Token A mint
    ///   10. `[]` Token B mint
    ///   11. `[]` Pool Token program id
    ///   12. `[]` Token A program id
    ///   13. `[]` Token B program id
    WithdrawAllTokenTypes(WithdrawAllTokenTypes),

    ///   Deposit one type of tokens into the pool. The output is a "pool"
    ///   token representing ownership into the pool. Input token is
    ///   converted as if a swap and deposit all token types were performed.
    ///
    ///   0. `[]` Token-swap
    ///   1. `[]` swap authority
    ///   2. `[]` user transfer authority
    ///   3. `[writable]` token_(A|B) SOURCE Account, amount is transferable by
    ///      user transfer authority,
    ///   4. `[writable]` token_a Swap Account, may deposit INTO.
    ///   5. `[writable]` token_b Swap Account, may deposit INTO.
    ///   6. `[writable]` Pool MINT account, swap authority is the owner.
    ///   7. `[writable]` Pool Account to deposit the generated tokens, user is
    ///      the owner.
    ///   8. `[]` Token (A|B) SOURCE mint
    ///   9. `[]` Token (A|B) SOURCE program id
    ///   10. `[]` Pool Token program id
    DepositSingleTokenTypeExactAmountIn(DepositSingleTokenTypeExactAmountIn),

    ///   Withdraw one token type from the pool at the current ratio given the
    ///   exact amount out expected.
    ///
    ///   0. `[]` Token-swap
    ///   1. `[]` swap authority
    ///   2. `[]` user transfer authority
    ///   3. `[writable]` Pool mint account, swap authority is the owner
    ///   4. `[writable]` SOURCE Pool account, amount is transferable by user
    ///      transfer authority.
    ///   5. `[writable]` token_a Swap Account to potentially withdraw from.
    ///   6. `[writable]` token_b Swap Account to potentially withdraw from.
    ///   7. `[writable]` token_(A|B) User Account to credit
    ///   8. `[]` Token (A|B) DESTINATION mint
    ///   9. `[]` Pool Token program id
    ///   10. `[]` Token (A|B) DESTINATION program id
    WithdrawSingleTokenTypeExactAmountOut(WithdrawSingleTokenTypeExactAmountOut),

    ///   Swap for an exact amount of destination token, paying up to a maximum
    ///   of source token. Same account layout as `Swap` — the program computes
    ///   the required input from the curve, delivers exactly `amount_out`, and
    ///   reverts if the required input exceeds `maximum_amount_in`.
    SwapExactOut(SwapExactOut),

    ///   Create a NEW constant-product pool over two existing tokens, with no
    ///   ephemeral signers (the program creates the pool state + LP mint PDAs).
    ///   The single creation path (tag 0 `Initialize` is retired).
    ///
    ///   0. `[signer, writable]` Creator / payer (a Solana wallet, or an EVM
    ///      user's external_auth PDA auto-signed by the CPI precompile).
    ///   1. `[writable]` Pool state PDA `[b"cp_pool", mint_a, mint_b, fee_bps_le]`.
    ///   2. `[]` Pool authority PDA `[pool]`.
    ///   3. `[]` Token A mint.  4. `[]` Token B mint.
    ///   5. `[writable]` Vault A — authority's ATA for mint A (pre-created + funded).
    ///   6. `[writable]` Vault B — authority's ATA for mint B (pre-created + funded).
    ///   7. `[writable]` LP mint PDA `[b"cp_lp", pool]` (created here).
    ///   8. `[writable]` Destination LP account PDA `[b"cp_dest", pool]` (created
    ///      here; owner = creator, so the creator holds the initial LP). No fee
    ///      LP account exists — protocol fees are counters in SwapV2 state.
    ///   9. `[]` Token program.  10. `[]` System program.
    ///   11. `[]` Protocol config PDA `[b"config"]` (readonly;
    ///       gate runs right after the payer signer check). Absent/uninitialized
    ///       config fails closed (`PoolCreationNotConfigured`); mode 0 requires
    ///       payer == config.admin (`PoolCreationRestricted`).
    CreatePool(CreatePool),

    ///   One-shot, upgrade-authority-gated: creates `[b"config"]` and sets its
    ///   initial admin/treasury/mode. See the design plan.
    ///
    ///   0. `[signer, writable]` Payer.
    ///   1. `[signer]` Upgrade authority (must match the authority parsed
    ///      from account 3).
    ///   2. `[writable]` Config PDA `[b"config"]` (created here).
    ///   3. `[]` This program's ProgramData account (the loader-derived
    ///      address; verified, never trusted).
    ///   4. `[]` System program.
    InitializeConfig(InitializeConfig),

    ///   Admin-signed: retargets the treasury `CollectProtocolFees` pays into.
    ///   Read live by collect — no caching.
    ///
    ///   0. `[writable]` Config PDA.  1. `[signer]` Admin.
    SetTreasury(SetTreasury),

    ///   Admin-signed: step 1 of 2. Writes `pending_admin` only — `admin`
    ///   itself is unchanged until `AcceptAdmin` runs (two-step).
    ///
    ///   0. `[writable]` Config PDA.  1. `[signer]` Current admin.
    TransferAdmin(TransferAdmin),

    ///   Pending-admin-signed: step 2 of 2. Promotes `pending_admin` to
    ///   `admin` and clears `pending_admin` back to default.
    ///
    ///   0. `[writable]` Config PDA.  1. `[signer]` Pending admin.
    AcceptAdmin,

    ///   PERMISSIONLESS. Zero instruction data — the amount moved is read
    ///   from state (the accrued counters), never from caller input; the
    ///   destination owner is read from `config.treasury`, never from caller
    ///   input (the design plan). Moves exactly the counters
    ///   vault → treasury-owned destination, then zeroes both counters.
    ///
    ///   Mixed-vault pools (vault A and vault B under DIFFERENT token
    ///   programs, e.g. one side Token-2022) need a token program PER
    ///   SIDE — a single shared program can serve only one side's vault,
    ///   permanently stranding the other's counter. Account 10 is
    ///   APPENDED at the end (not inserted) so indices 0-9 are unchanged.
    ///
    ///   0. `[writable]` Pool.  1. `[]` Pool authority.
    ///   2. `[writable]` Vault A.  3. `[writable]` Vault B.
    ///   4. `[writable]` Destination A (owner must == config.treasury).
    ///   5. `[writable]` Destination B (owner must == config.treasury).
    ///   6. `[]` Mint A.  7. `[]` Mint B.
    ///   8. `[]` Config PDA.  9. `[]` Token program A (must own Vault A).
    ///   10. `[]` Token program B (must own Vault B).
    CollectProtocolFees,

    ///   Admin-signed: flips `pool_creation_mode` (0 or 1 only).
    ///
    ///   0. `[writable]` Config PDA.  1. `[signer]` Admin.
    SetPoolCreation(SetPoolCreation),
}

impl SwapInstruction {
    /// Unpacks a byte buffer into a
    /// [SwapInstruction](enum.SwapInstruction.html).
    pub fn unpack(input: &[u8]) -> Result<Self, ProgramError> {
        let (&tag, rest) = input.split_first().ok_or(SwapError::InvalidInstruction)?;
        Ok(match tag {
            // Tag 0 is a reserved unit variant — ANY trailing bytes are
            // ignored, so an old-format tag-0 payload still unpacks (into
            // `Self::Initialize`) and gets the NAMED error downstream
            // (`InstructionRetired`) rather than a generic InvalidInstruction.
            0 => {
                let _ = rest;
                Self::Initialize
            }
            1 => {
                let (amount_in, rest) = Self::unpack_u64(rest)?;
                let (minimum_amount_out, _rest) = Self::unpack_u64(rest)?;
                Self::Swap(Swap {
                    amount_in,
                    minimum_amount_out,
                })
            }
            2 => {
                let (pool_token_amount, rest) = Self::unpack_u64(rest)?;
                let (maximum_token_a_amount, rest) = Self::unpack_u64(rest)?;
                let (maximum_token_b_amount, _rest) = Self::unpack_u64(rest)?;
                Self::DepositAllTokenTypes(DepositAllTokenTypes {
                    pool_token_amount,
                    maximum_token_a_amount,
                    maximum_token_b_amount,
                })
            }
            3 => {
                let (pool_token_amount, rest) = Self::unpack_u64(rest)?;
                let (minimum_token_a_amount, rest) = Self::unpack_u64(rest)?;
                let (minimum_token_b_amount, _rest) = Self::unpack_u64(rest)?;
                Self::WithdrawAllTokenTypes(WithdrawAllTokenTypes {
                    pool_token_amount,
                    minimum_token_a_amount,
                    minimum_token_b_amount,
                })
            }
            4 => {
                let (source_token_amount, rest) = Self::unpack_u64(rest)?;
                let (minimum_pool_token_amount, _rest) = Self::unpack_u64(rest)?;
                Self::DepositSingleTokenTypeExactAmountIn(DepositSingleTokenTypeExactAmountIn {
                    source_token_amount,
                    minimum_pool_token_amount,
                })
            }
            5 => {
                let (destination_token_amount, rest) = Self::unpack_u64(rest)?;
                let (maximum_pool_token_amount, _rest) = Self::unpack_u64(rest)?;
                Self::WithdrawSingleTokenTypeExactAmountOut(WithdrawSingleTokenTypeExactAmountOut {
                    destination_token_amount,
                    maximum_pool_token_amount,
                })
            }
            6 => {
                let (amount_out, rest) = Self::unpack_u64(rest)?;
                let (maximum_amount_in, _rest) = Self::unpack_u64(rest)?;
                Self::SwapExactOut(SwapExactOut {
                    amount_out,
                    maximum_amount_in,
                })
            }
            7 => {
                // [fee_bps u16][pool_bump u8][lp_bump u8][fees(Fees::LEN)][swap_curve(rest)]
                // — fixed scalars first so SwapCurve can consume the remainder (tag 0).
                let (fee_bps, rest) = Self::unpack_u16(rest)?;
                let (&pool_bump, rest) = rest.split_first().ok_or(SwapError::InvalidInstruction)?;
                let (&lp_bump, rest) = rest.split_first().ok_or(SwapError::InvalidInstruction)?;
                if rest.len() >= Fees::LEN {
                    let (fees, rest) = rest.split_at(Fees::LEN);
                    let fees = Fees::unpack_unchecked(fees)?;
                    let swap_curve = SwapCurve::unpack_unchecked(rest)?;
                    Self::CreatePool(CreatePool { fees, swap_curve, fee_bps, pool_bump, lp_bump })
                } else {
                    return Err(SwapError::InvalidInstruction.into());
                }
            }
            8 => {
                let (admin, rest) = Self::unpack_pubkey(rest)?;
                let (treasury, rest) = Self::unpack_pubkey(rest)?;
                let (&mode, _rest) = rest.split_first().ok_or(SwapError::InvalidInstruction)?;
                Self::InitializeConfig(InitializeConfig { admin, treasury, mode })
            }
            9 => {
                let (treasury, _rest) = Self::unpack_pubkey(rest)?;
                Self::SetTreasury(SetTreasury { treasury })
            }
            10 => {
                let (pending_admin, _rest) = Self::unpack_pubkey(rest)?;
                Self::TransferAdmin(TransferAdmin { pending_admin })
            }
            11 => {
                let _ = rest;
                Self::AcceptAdmin
            }
            12 => {
                let _ = rest;
                Self::CollectProtocolFees
            }
            13 => {
                let (&mode, _rest) = rest.split_first().ok_or(SwapError::InvalidInstruction)?;
                Self::SetPoolCreation(SetPoolCreation { mode })
            }
            _ => return Err(SwapError::InvalidInstruction.into()),
        })
    }

    fn unpack_pubkey(input: &[u8]) -> Result<(Pubkey, &[u8]), ProgramError> {
        if input.len() >= 32 {
            let (bytes, rest) = input.split_at(32);
            let pubkey = Pubkey::try_from(bytes).map_err(|_| SwapError::InvalidInstruction)?;
            Ok((pubkey, rest))
        } else {
            Err(SwapError::InvalidInstruction.into())
        }
    }

    fn unpack_u16(input: &[u8]) -> Result<(u16, &[u8]), ProgramError> {
        if input.len() >= 2 {
            let (bytes, rest) = input.split_at(2);
            let v = u16::from_le_bytes(bytes.try_into().map_err(|_| SwapError::InvalidInstruction)?);
            Ok((v, rest))
        } else {
            Err(SwapError::InvalidInstruction.into())
        }
    }

    fn unpack_u64(input: &[u8]) -> Result<(u64, &[u8]), ProgramError> {
        if input.len() >= 8 {
            let (amount, rest) = input.split_at(8);
            let amount = amount
                .get(..8)
                .and_then(|slice| slice.try_into().ok())
                .map(u64::from_le_bytes)
                .ok_or(SwapError::InvalidInstruction)?;
            Ok((amount, rest))
        } else {
            Err(SwapError::InvalidInstruction.into())
        }
    }

    /// Packs a [SwapInstruction](enum.SwapInstruction.html) into a byte buffer.
    pub fn pack(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(size_of::<Self>());
        match self {
            Self::Initialize => {
                buf.push(0);
            }
            Self::Swap(Swap {
                amount_in,
                minimum_amount_out,
            }) => {
                buf.push(1);
                buf.extend_from_slice(&amount_in.to_le_bytes());
                buf.extend_from_slice(&minimum_amount_out.to_le_bytes());
            }
            Self::DepositAllTokenTypes(DepositAllTokenTypes {
                pool_token_amount,
                maximum_token_a_amount,
                maximum_token_b_amount,
            }) => {
                buf.push(2);
                buf.extend_from_slice(&pool_token_amount.to_le_bytes());
                buf.extend_from_slice(&maximum_token_a_amount.to_le_bytes());
                buf.extend_from_slice(&maximum_token_b_amount.to_le_bytes());
            }
            Self::WithdrawAllTokenTypes(WithdrawAllTokenTypes {
                pool_token_amount,
                minimum_token_a_amount,
                minimum_token_b_amount,
            }) => {
                buf.push(3);
                buf.extend_from_slice(&pool_token_amount.to_le_bytes());
                buf.extend_from_slice(&minimum_token_a_amount.to_le_bytes());
                buf.extend_from_slice(&minimum_token_b_amount.to_le_bytes());
            }
            Self::DepositSingleTokenTypeExactAmountIn(DepositSingleTokenTypeExactAmountIn {
                source_token_amount,
                minimum_pool_token_amount,
            }) => {
                buf.push(4);
                buf.extend_from_slice(&source_token_amount.to_le_bytes());
                buf.extend_from_slice(&minimum_pool_token_amount.to_le_bytes());
            }
            Self::WithdrawSingleTokenTypeExactAmountOut(
                WithdrawSingleTokenTypeExactAmountOut {
                    destination_token_amount,
                    maximum_pool_token_amount,
                },
            ) => {
                buf.push(5);
                buf.extend_from_slice(&destination_token_amount.to_le_bytes());
                buf.extend_from_slice(&maximum_pool_token_amount.to_le_bytes());
            }
            Self::SwapExactOut(SwapExactOut {
                amount_out,
                maximum_amount_in,
            }) => {
                buf.push(6);
                buf.extend_from_slice(&amount_out.to_le_bytes());
                buf.extend_from_slice(&maximum_amount_in.to_le_bytes());
            }
            Self::CreatePool(CreatePool {
                fees,
                swap_curve,
                fee_bps,
                pool_bump,
                lp_bump,
            }) => {
                buf.push(7);
                buf.extend_from_slice(&fee_bps.to_le_bytes());
                buf.push(*pool_bump);
                buf.push(*lp_bump);
                let mut fees_slice = [0u8; Fees::LEN];
                Pack::pack_into_slice(fees, &mut fees_slice[..]);
                buf.extend_from_slice(&fees_slice);
                let mut swap_curve_slice = [0u8; SwapCurve::LEN];
                Pack::pack_into_slice(swap_curve, &mut swap_curve_slice[..]);
                buf.extend_from_slice(&swap_curve_slice);
            }
            Self::InitializeConfig(InitializeConfig { admin, treasury, mode }) => {
                buf.push(8);
                buf.extend_from_slice(admin.as_ref());
                buf.extend_from_slice(treasury.as_ref());
                buf.push(*mode);
            }
            Self::SetTreasury(SetTreasury { treasury }) => {
                buf.push(9);
                buf.extend_from_slice(treasury.as_ref());
            }
            Self::TransferAdmin(TransferAdmin { pending_admin }) => {
                buf.push(10);
                buf.extend_from_slice(pending_admin.as_ref());
            }
            Self::AcceptAdmin => {
                buf.push(11);
            }
            Self::CollectProtocolFees => {
                buf.push(12);
            }
            Self::SetPoolCreation(SetPoolCreation { mode }) => {
                buf.push(13);
                buf.push(*mode);
            }
        }
        buf
    }
}

/// Creates a 'deposit_all_token_types' instruction.
pub fn deposit_all_token_types(
    program_id: &Pubkey,
    token_a_program_id: &Pubkey,
    token_b_program_id: &Pubkey,
    pool_token_program_id: &Pubkey,
    swap_pubkey: &Pubkey,
    authority_pubkey: &Pubkey,
    user_transfer_authority_pubkey: &Pubkey,
    deposit_token_a_pubkey: &Pubkey,
    deposit_token_b_pubkey: &Pubkey,
    swap_token_a_pubkey: &Pubkey,
    swap_token_b_pubkey: &Pubkey,
    pool_mint_pubkey: &Pubkey,
    destination_pubkey: &Pubkey,
    token_a_mint_pubkey: &Pubkey,
    token_b_mint_pubkey: &Pubkey,
    instruction: DepositAllTokenTypes,
) -> Result<Instruction, ProgramError> {
    let data = SwapInstruction::DepositAllTokenTypes(instruction).pack();

    let accounts = vec![
        AccountMeta::new_readonly(*swap_pubkey, false),
        AccountMeta::new_readonly(*authority_pubkey, false),
        AccountMeta::new_readonly(*user_transfer_authority_pubkey, true),
        AccountMeta::new(*deposit_token_a_pubkey, false),
        AccountMeta::new(*deposit_token_b_pubkey, false),
        AccountMeta::new(*swap_token_a_pubkey, false),
        AccountMeta::new(*swap_token_b_pubkey, false),
        AccountMeta::new(*pool_mint_pubkey, false),
        AccountMeta::new(*destination_pubkey, false),
        AccountMeta::new_readonly(*token_a_mint_pubkey, false),
        AccountMeta::new_readonly(*token_b_mint_pubkey, false),
        AccountMeta::new_readonly(*token_a_program_id, false),
        AccountMeta::new_readonly(*token_b_program_id, false),
        AccountMeta::new_readonly(*pool_token_program_id, false),
    ];

    Ok(Instruction {
        program_id: *program_id,
        accounts,
        data,
    })
}

/// Creates a 'withdraw_all_token_types' instruction.
pub fn withdraw_all_token_types(
    program_id: &Pubkey,
    pool_token_program_id: &Pubkey,
    token_a_program_id: &Pubkey,
    token_b_program_id: &Pubkey,
    swap_pubkey: &Pubkey,
    authority_pubkey: &Pubkey,
    user_transfer_authority_pubkey: &Pubkey,
    pool_mint_pubkey: &Pubkey,
    source_pubkey: &Pubkey,
    swap_token_a_pubkey: &Pubkey,
    swap_token_b_pubkey: &Pubkey,
    destination_token_a_pubkey: &Pubkey,
    destination_token_b_pubkey: &Pubkey,
    token_a_mint_pubkey: &Pubkey,
    token_b_mint_pubkey: &Pubkey,
    instruction: WithdrawAllTokenTypes,
) -> Result<Instruction, ProgramError> {
    let data = SwapInstruction::WithdrawAllTokenTypes(instruction).pack();

    // 14 metas (D8: no fee account slot — protocol fees are SwapV2 counters).
    let accounts = vec![
        AccountMeta::new_readonly(*swap_pubkey, false),
        AccountMeta::new_readonly(*authority_pubkey, false),
        AccountMeta::new_readonly(*user_transfer_authority_pubkey, true),
        AccountMeta::new(*pool_mint_pubkey, false),
        AccountMeta::new(*source_pubkey, false),
        AccountMeta::new(*swap_token_a_pubkey, false),
        AccountMeta::new(*swap_token_b_pubkey, false),
        AccountMeta::new(*destination_token_a_pubkey, false),
        AccountMeta::new(*destination_token_b_pubkey, false),
        AccountMeta::new_readonly(*token_a_mint_pubkey, false),
        AccountMeta::new_readonly(*token_b_mint_pubkey, false),
        AccountMeta::new_readonly(*pool_token_program_id, false),
        AccountMeta::new_readonly(*token_a_program_id, false),
        AccountMeta::new_readonly(*token_b_program_id, false),
    ];

    Ok(Instruction {
        program_id: *program_id,
        accounts,
        data,
    })
}

/// Creates a 'deposit_single_token_type_exact_amount_in' instruction.
pub fn deposit_single_token_type_exact_amount_in(
    program_id: &Pubkey,
    source_token_program_id: &Pubkey,
    pool_token_program_id: &Pubkey,
    swap_pubkey: &Pubkey,
    authority_pubkey: &Pubkey,
    user_transfer_authority_pubkey: &Pubkey,
    source_token_pubkey: &Pubkey,
    swap_token_a_pubkey: &Pubkey,
    swap_token_b_pubkey: &Pubkey,
    pool_mint_pubkey: &Pubkey,
    destination_pubkey: &Pubkey,
    source_mint_pubkey: &Pubkey,
    instruction: DepositSingleTokenTypeExactAmountIn,
) -> Result<Instruction, ProgramError> {
    let data = SwapInstruction::DepositSingleTokenTypeExactAmountIn(instruction).pack();

    let accounts = vec![
        AccountMeta::new_readonly(*swap_pubkey, false),
        AccountMeta::new_readonly(*authority_pubkey, false),
        AccountMeta::new_readonly(*user_transfer_authority_pubkey, true),
        AccountMeta::new(*source_token_pubkey, false),
        AccountMeta::new(*swap_token_a_pubkey, false),
        AccountMeta::new(*swap_token_b_pubkey, false),
        AccountMeta::new(*pool_mint_pubkey, false),
        AccountMeta::new(*destination_pubkey, false),
        AccountMeta::new_readonly(*source_mint_pubkey, false),
        AccountMeta::new_readonly(*source_token_program_id, false),
        AccountMeta::new_readonly(*pool_token_program_id, false),
    ];

    Ok(Instruction {
        program_id: *program_id,
        accounts,
        data,
    })
}

/// Creates a 'withdraw_single_token_type_exact_amount_out' instruction.
pub fn withdraw_single_token_type_exact_amount_out(
    program_id: &Pubkey,
    pool_token_program_id: &Pubkey,
    destination_token_program_id: &Pubkey,
    swap_pubkey: &Pubkey,
    authority_pubkey: &Pubkey,
    user_transfer_authority_pubkey: &Pubkey,
    pool_mint_pubkey: &Pubkey,
    pool_token_source_pubkey: &Pubkey,
    swap_token_a_pubkey: &Pubkey,
    swap_token_b_pubkey: &Pubkey,
    destination_pubkey: &Pubkey,
    destination_mint_pubkey: &Pubkey,
    instruction: WithdrawSingleTokenTypeExactAmountOut,
) -> Result<Instruction, ProgramError> {
    let data = SwapInstruction::WithdrawSingleTokenTypeExactAmountOut(instruction).pack();

    // 11 metas (D9: no fee account slot).
    let accounts = vec![
        AccountMeta::new_readonly(*swap_pubkey, false),
        AccountMeta::new_readonly(*authority_pubkey, false),
        AccountMeta::new_readonly(*user_transfer_authority_pubkey, true),
        AccountMeta::new(*pool_mint_pubkey, false),
        AccountMeta::new(*pool_token_source_pubkey, false),
        AccountMeta::new(*swap_token_a_pubkey, false),
        AccountMeta::new(*swap_token_b_pubkey, false),
        AccountMeta::new(*destination_pubkey, false),
        AccountMeta::new_readonly(*destination_mint_pubkey, false),
        AccountMeta::new_readonly(*pool_token_program_id, false),
        AccountMeta::new_readonly(*destination_token_program_id, false),
    ];

    Ok(Instruction {
        program_id: *program_id,
        accounts,
        data,
    })
}

/// Creates a 'swap' instruction.
pub fn swap(
    program_id: &Pubkey,
    source_token_program_id: &Pubkey,
    destination_token_program_id: &Pubkey,
    pool_token_program_id: &Pubkey,
    swap_pubkey: &Pubkey,
    authority_pubkey: &Pubkey,
    user_transfer_authority_pubkey: &Pubkey,
    source_pubkey: &Pubkey,
    swap_source_pubkey: &Pubkey,
    swap_destination_pubkey: &Pubkey,
    destination_pubkey: &Pubkey,
    pool_mint_pubkey: &Pubkey,
    source_mint_pubkey: &Pubkey,
    destination_mint_pubkey: &Pubkey,
    instruction: Swap,
) -> Result<Instruction, ProgramError> {
    let data = SwapInstruction::Swap(instruction).pack();

    // 13 metas, no optional trailing account (D7/D12): no fee slot, no host
    // fee. meta[0] (swap state) is WRITABLE — the swap now writes the
    // accrual counter (A10; on-chain client change).
    let accounts = vec![
        AccountMeta::new(*swap_pubkey, false),
        AccountMeta::new_readonly(*authority_pubkey, false),
        AccountMeta::new_readonly(*user_transfer_authority_pubkey, true),
        AccountMeta::new(*source_pubkey, false),
        AccountMeta::new(*swap_source_pubkey, false),
        AccountMeta::new(*swap_destination_pubkey, false),
        AccountMeta::new(*destination_pubkey, false),
        AccountMeta::new(*pool_mint_pubkey, false),
        AccountMeta::new_readonly(*source_mint_pubkey, false),
        AccountMeta::new_readonly(*destination_mint_pubkey, false),
        AccountMeta::new_readonly(*source_token_program_id, false),
        AccountMeta::new_readonly(*destination_token_program_id, false),
        AccountMeta::new_readonly(*pool_token_program_id, false),
    ];

    Ok(Instruction {
        program_id: *program_id,
        accounts,
        data,
    })
}

/// Creates a 'swap_exact_out' instruction. Same account layout as `swap`.
pub fn swap_exact_out(
    program_id: &Pubkey,
    source_token_program_id: &Pubkey,
    destination_token_program_id: &Pubkey,
    pool_token_program_id: &Pubkey,
    swap_pubkey: &Pubkey,
    authority_pubkey: &Pubkey,
    user_transfer_authority_pubkey: &Pubkey,
    source_pubkey: &Pubkey,
    swap_source_pubkey: &Pubkey,
    swap_destination_pubkey: &Pubkey,
    destination_pubkey: &Pubkey,
    pool_mint_pubkey: &Pubkey,
    source_mint_pubkey: &Pubkey,
    destination_mint_pubkey: &Pubkey,
    instruction: SwapExactOut,
) -> Result<Instruction, ProgramError> {
    let data = SwapInstruction::SwapExactOut(instruction).pack();

    // 13 metas, meta[0] writable — same reasoning as `swap` above.
    let accounts = vec![
        AccountMeta::new(*swap_pubkey, false),
        AccountMeta::new_readonly(*authority_pubkey, false),
        AccountMeta::new_readonly(*user_transfer_authority_pubkey, true),
        AccountMeta::new(*source_pubkey, false),
        AccountMeta::new(*swap_source_pubkey, false),
        AccountMeta::new(*swap_destination_pubkey, false),
        AccountMeta::new(*destination_pubkey, false),
        AccountMeta::new(*pool_mint_pubkey, false),
        AccountMeta::new_readonly(*source_mint_pubkey, false),
        AccountMeta::new_readonly(*destination_mint_pubkey, false),
        AccountMeta::new_readonly(*source_token_program_id, false),
        AccountMeta::new_readonly(*destination_token_program_id, false),
        AccountMeta::new_readonly(*pool_token_program_id, false),
    ];

    Ok(Instruction {
        program_id: *program_id,
        accounts,
        data,
    })
}

/// Creates an `initialize_config` instruction (tag 8).
pub fn initialize_config(
    program_id: &Pubkey,
    payer_pubkey: &Pubkey,
    upgrade_authority_pubkey: &Pubkey,
    config_pubkey: &Pubkey,
    programdata_pubkey: &Pubkey,
    instruction: InitializeConfig,
) -> Result<Instruction, ProgramError> {
    let data = SwapInstruction::InitializeConfig(instruction).pack();
    let accounts = vec![
        AccountMeta::new(*payer_pubkey, true),
        AccountMeta::new_readonly(*upgrade_authority_pubkey, true),
        AccountMeta::new(*config_pubkey, false),
        AccountMeta::new_readonly(*programdata_pubkey, false),
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
    ];
    Ok(Instruction {
        program_id: *program_id,
        accounts,
        data,
    })
}

/// Creates a `set_treasury` instruction (tag 9).
pub fn set_treasury(
    program_id: &Pubkey,
    config_pubkey: &Pubkey,
    admin_pubkey: &Pubkey,
    instruction: SetTreasury,
) -> Result<Instruction, ProgramError> {
    let data = SwapInstruction::SetTreasury(instruction).pack();
    let accounts = vec![
        AccountMeta::new(*config_pubkey, false),
        AccountMeta::new_readonly(*admin_pubkey, true),
    ];
    Ok(Instruction {
        program_id: *program_id,
        accounts,
        data,
    })
}

/// Creates a `transfer_admin` instruction (tag 10).
pub fn transfer_admin(
    program_id: &Pubkey,
    config_pubkey: &Pubkey,
    admin_pubkey: &Pubkey,
    instruction: TransferAdmin,
) -> Result<Instruction, ProgramError> {
    let data = SwapInstruction::TransferAdmin(instruction).pack();
    let accounts = vec![
        AccountMeta::new(*config_pubkey, false),
        AccountMeta::new_readonly(*admin_pubkey, true),
    ];
    Ok(Instruction {
        program_id: *program_id,
        accounts,
        data,
    })
}

/// Creates an `accept_admin` instruction (tag 11).
pub fn accept_admin(
    program_id: &Pubkey,
    config_pubkey: &Pubkey,
    pending_admin_pubkey: &Pubkey,
) -> Result<Instruction, ProgramError> {
    let data = SwapInstruction::AcceptAdmin.pack();
    let accounts = vec![
        AccountMeta::new(*config_pubkey, false),
        AccountMeta::new_readonly(*pending_admin_pubkey, true),
    ];
    Ok(Instruction {
        program_id: *program_id,
        accounts,
        data,
    })
}

/// Creates a `collect_protocol_fees` instruction (tag 12). Every meta is
/// non-signer — the instruction is permissionless by construction. Takes
/// a token program PER SIDE (account 10 is appended, not inserted — see
/// the `CollectProtocolFees` doc comment) so a mixed-vault pool (vault A
/// and vault B under different token programs) can be served in one call.
#[allow(clippy::too_many_arguments)]
pub fn collect_protocol_fees(
    program_id: &Pubkey,
    pool_pubkey: &Pubkey,
    pool_authority_pubkey: &Pubkey,
    vault_a_pubkey: &Pubkey,
    vault_b_pubkey: &Pubkey,
    dest_a_pubkey: &Pubkey,
    dest_b_pubkey: &Pubkey,
    mint_a_pubkey: &Pubkey,
    mint_b_pubkey: &Pubkey,
    config_pubkey: &Pubkey,
    token_program_a_pubkey: &Pubkey,
    token_program_b_pubkey: &Pubkey,
) -> Result<Instruction, ProgramError> {
    let data = SwapInstruction::CollectProtocolFees.pack();
    let accounts = vec![
        AccountMeta::new(*pool_pubkey, false),
        AccountMeta::new_readonly(*pool_authority_pubkey, false),
        AccountMeta::new(*vault_a_pubkey, false),
        AccountMeta::new(*vault_b_pubkey, false),
        AccountMeta::new(*dest_a_pubkey, false),
        AccountMeta::new(*dest_b_pubkey, false),
        AccountMeta::new_readonly(*mint_a_pubkey, false),
        AccountMeta::new_readonly(*mint_b_pubkey, false),
        AccountMeta::new_readonly(*config_pubkey, false),
        AccountMeta::new_readonly(*token_program_a_pubkey, false),
        AccountMeta::new_readonly(*token_program_b_pubkey, false),
    ];
    Ok(Instruction {
        program_id: *program_id,
        accounts,
        data,
    })
}

/// Creates a `set_pool_creation` instruction (tag 13).
pub fn set_pool_creation(
    program_id: &Pubkey,
    config_pubkey: &Pubkey,
    admin_pubkey: &Pubkey,
    instruction: SetPoolCreation,
) -> Result<Instruction, ProgramError> {
    let data = SwapInstruction::SetPoolCreation(instruction).pack();
    let accounts = vec![
        AccountMeta::new(*config_pubkey, false),
        AccountMeta::new_readonly(*admin_pubkey, true),
    ];
    Ok(Instruction {
        program_id: *program_id,
        accounts,
        data,
    })
}

/// Unpacks a reference from a bytes buffer.
/// TODO actually pack / unpack instead of relying on normal memory layout.
pub fn unpack<T>(input: &[u8]) -> Result<&T, ProgramError> {
    if input.len() < size_of::<u8>() + size_of::<T>() {
        return Err(ProgramError::InvalidAccountData);
    }
    #[allow(clippy::cast_ptr_alignment)]
    let val: &T = unsafe { &*(&input[1] as *const u8 as *const T) };
    Ok(val)
}

#[cfg(test)]
mod tests {
    use {super::*, crate::curve::base::CurveType, std::sync::Arc};

    /// Tag 0 is a reserved unit variant: `pack` emits just
    /// the tag byte; `unpack` ignores any trailing bytes (so an old-format
    /// tag-0 payload — fees + curve, the pre-v2 `Initialize` shape —
    /// still unpacks into `Self::Initialize`, letting the processor return
    /// the NAMED error `InstructionRetired` downstream instead of a generic
    /// unpack failure).
    #[test]
    fn tag0_reserved() {
        let check = SwapInstruction::Initialize;
        assert_eq!(check.pack(), vec![0u8]);
        assert_eq!(SwapInstruction::unpack(&[0u8]).unwrap(), check);

        // Old-format payload (arbitrary trailing bytes) still unpacks as the
        // reserved variant — trailing bytes are ignored, never rejected.
        let mut legacy_tag0 = vec![0u8];
        legacy_tag0.extend_from_slice(&[0xAAu8; 97]); // Fees::LEN + SwapCurve::LEN-ish junk
        assert_eq!(SwapInstruction::unpack(&legacy_tag0).unwrap(), check);
    }

    #[test]
    fn pack_create_pool() {
        let fees = Fees {
            trade_fee_numerator: 25,
            trade_fee_denominator: 10_000,
            owner_trade_fee_numerator: 5,
            owner_trade_fee_denominator: 10_000,
            owner_withdraw_fee_numerator: 0,
            owner_withdraw_fee_denominator: 10_000,
            host_fee_numerator: 0,
            host_fee_denominator: 10_000,
        };
        let curve_type = CurveType::ConstantProduct;
        let calculator = Arc::new(crate::curve::constant_product::ConstantProductCurve {});
        let swap_curve = SwapCurve {
            curve_type,
            calculator,
        };
        let fee_bps: u16 = 30;
        let pool_bump: u8 = 254;
        let lp_bump: u8 = 253;
        let check = SwapInstruction::CreatePool(CreatePool {
            fees: fees.clone(),
            swap_curve: swap_curve.clone(),
            fee_bps,
            pool_bump,
            lp_bump,
        });
        let packed = check.pack();
        // [7][fee_bps u16][pool_bump][lp_bump][fees(Fees::LEN)][swap_curve(SwapCurve::LEN)]
        let mut expect = vec![7u8];
        expect.extend_from_slice(&fee_bps.to_le_bytes());
        expect.push(pool_bump);
        expect.push(lp_bump);
        let mut fees_slice = [0u8; Fees::LEN];
        Pack::pack_into_slice(&fees, &mut fees_slice[..]);
        expect.extend_from_slice(&fees_slice);
        let mut curve_slice = [0u8; SwapCurve::LEN];
        Pack::pack_into_slice(&swap_curve, &mut curve_slice[..]);
        expect.extend_from_slice(&curve_slice);
        assert_eq!(packed, expect);
        let unpacked = SwapInstruction::unpack(&packed).unwrap();
        assert_eq!(unpacked, check);
    }

    #[test]
    fn pack_swap() {
        let amount_in: u64 = 2;
        let minimum_amount_out: u64 = 10;
        let check = SwapInstruction::Swap(Swap {
            amount_in,
            minimum_amount_out,
        });
        let packed = check.pack();
        let mut expect = vec![1];
        expect.extend_from_slice(&amount_in.to_le_bytes());
        expect.extend_from_slice(&minimum_amount_out.to_le_bytes());
        assert_eq!(packed, expect);
        let unpacked = SwapInstruction::unpack(&expect).unwrap();
        assert_eq!(unpacked, check);
    }

    #[test]
    fn pack_deposit() {
        let pool_token_amount: u64 = 5;
        let maximum_token_a_amount: u64 = 10;
        let maximum_token_b_amount: u64 = 20;
        let check = SwapInstruction::DepositAllTokenTypes(DepositAllTokenTypes {
            pool_token_amount,
            maximum_token_a_amount,
            maximum_token_b_amount,
        });
        let packed = check.pack();
        let mut expect = vec![2];
        expect.extend_from_slice(&pool_token_amount.to_le_bytes());
        expect.extend_from_slice(&maximum_token_a_amount.to_le_bytes());
        expect.extend_from_slice(&maximum_token_b_amount.to_le_bytes());
        assert_eq!(packed, expect);
        let unpacked = SwapInstruction::unpack(&expect).unwrap();
        assert_eq!(unpacked, check);
    }

    #[test]
    fn pack_withdraw() {
        let pool_token_amount: u64 = 1212438012089;
        let minimum_token_a_amount: u64 = 102198761982612;
        let minimum_token_b_amount: u64 = 2011239855213;
        let check = SwapInstruction::WithdrawAllTokenTypes(WithdrawAllTokenTypes {
            pool_token_amount,
            minimum_token_a_amount,
            minimum_token_b_amount,
        });
        let packed = check.pack();
        let mut expect = vec![3];
        expect.extend_from_slice(&pool_token_amount.to_le_bytes());
        expect.extend_from_slice(&minimum_token_a_amount.to_le_bytes());
        expect.extend_from_slice(&minimum_token_b_amount.to_le_bytes());
        assert_eq!(packed, expect);
        let unpacked = SwapInstruction::unpack(&expect).unwrap();
        assert_eq!(unpacked, check);
    }

    #[test]
    fn pack_deposit_one_exact_in() {
        let source_token_amount: u64 = 10;
        let minimum_pool_token_amount: u64 = 5;
        let check = SwapInstruction::DepositSingleTokenTypeExactAmountIn(
            DepositSingleTokenTypeExactAmountIn {
                source_token_amount,
                minimum_pool_token_amount,
            },
        );
        let packed = check.pack();
        let mut expect = vec![4];
        expect.extend_from_slice(&source_token_amount.to_le_bytes());
        expect.extend_from_slice(&minimum_pool_token_amount.to_le_bytes());
        assert_eq!(packed, expect);
        let unpacked = SwapInstruction::unpack(&expect).unwrap();
        assert_eq!(unpacked, check);
    }

    /// Golden-vector fixtures shared with the Solidity router tests
    /// (contracts/test/vectors/*.hex) — see docs on `golden_vectors` below.
    fn decode_hex_vector(s: &str) -> Vec<u8> {
        let s = s.trim().trim_start_matches("0x");
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Pins the router's CPI byte encoding against the SAME file the
    /// Solidity `RomeDexRouter` recorder tests assert against — a mismatch
    /// here means the router encodes a different instruction than this
    /// program parses, independent of which side is "wrong".
    #[test]
    fn golden_vectors() {
        let dex_swap = decode_hex_vector(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/test/vectors/dex_swap.hex"
        )));
        let check = SwapInstruction::Swap(Swap {
            amount_in: 0x0102030405060708,
            minimum_amount_out: 0x1112131415161718,
        });
        assert_eq!(check.pack(), dex_swap);
        assert_eq!(SwapInstruction::unpack(&dex_swap).unwrap(), check);

        let dex_exact_out = decode_hex_vector(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/test/vectors/dex_exact_out.hex"
        )));
        let check = SwapInstruction::SwapExactOut(SwapExactOut {
            amount_out: 0x6162636465666768,
            maximum_amount_in: 0x7172737475767778,
        });
        assert_eq!(check.pack(), dex_exact_out);
        assert_eq!(SwapInstruction::unpack(&dex_exact_out).unwrap(), check);

        let dex_deposit = decode_hex_vector(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/test/vectors/dex_deposit.hex"
        )));
        let check = SwapInstruction::DepositAllTokenTypes(DepositAllTokenTypes {
            pool_token_amount: 0x0102030405060708,
            maximum_token_a_amount: 0x1112131415161718,
            maximum_token_b_amount: 0x2122232425262728,
        });
        assert_eq!(check.pack(), dex_deposit);
        assert_eq!(SwapInstruction::unpack(&dex_deposit).unwrap(), check);

        let dex_withdraw = decode_hex_vector(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/test/vectors/dex_withdraw.hex"
        )));
        let check = SwapInstruction::WithdrawAllTokenTypes(WithdrawAllTokenTypes {
            pool_token_amount: 0x3132333435363738,
            minimum_token_a_amount: 0x4142434445464748,
            minimum_token_b_amount: 0x5152535455565758,
        });
        assert_eq!(check.pack(), dex_withdraw);
        assert_eq!(SwapInstruction::unpack(&dex_withdraw).unwrap(), check);

        // u64::MAX / 0 boundary — an endianness or off-by-one mutation on the
        // top byte can hide in a mid-range value; the all-0xFF pattern can't.
        let dex_swap_boundary = decode_hex_vector(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/test/vectors/dex_swap_boundary.hex"
        )));
        let check = SwapInstruction::Swap(Swap {
            amount_in: u64::MAX,
            minimum_amount_out: 0,
        });
        assert_eq!(check.pack(), dex_swap_boundary);
        assert_eq!(SwapInstruction::unpack(&dex_swap_boundary).unwrap(), check);
    }

    // `golden_vector_genesis_initialize` (tag-0 Initialize genesis-ceremony
    // encoding, and its fixture `contracts/test/vectors/dex_genesis_initialize.hex`)
    // deleted for real (the design record): the JS ceremony it
    // mirrored is rebuilt on CreatePool + InitializeConfig — see
    // `golden_vector_create_pool_data` / `golden_vector_initialize_config_data`
    // below, which are the live replacements.

    /// Golden vector shared with the JS ceremony's `genesis-codec.mjs`
    /// (`encodeCreatePoolData`, which delegates to
    /// `harness/createPoolLib.mjs::createPoolData`) — packs a FIXED
    /// `CreatePool` instruction and writes it to
    /// `contracts/test/vectors/dex_create_pool_data.hex`. Layout:
    /// `[7][fee_bps u16][pool_bump][lp_bump][fees(64)][swap_curve(33)]`.
    #[test]
    fn golden_vector_create_pool_data() {
        let fees = Fees {
            trade_fee_numerator: 25,
            trade_fee_denominator: 10_000,
            owner_trade_fee_numerator: 5,
            owner_trade_fee_denominator: 10_000,
            owner_withdraw_fee_numerator: 0,
            owner_withdraw_fee_denominator: 0,
            host_fee_numerator: 0,
            host_fee_denominator: 0,
        };
        let swap_curve = SwapCurve {
            curve_type: CurveType::ConstantProduct,
            calculator: Arc::new(crate::curve::constant_product::ConstantProductCurve {}),
        };
        let check = SwapInstruction::CreatePool(CreatePool {
            fees,
            swap_curve,
            fee_bps: 30,
            pool_bump: 254,
            lp_bump: 253,
        });
        let packed = check.pack();
        assert_eq!(packed.len(), 102);

        let hex = format!("0x{}", packed.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/test/vectors/dex_create_pool_data.hex"
        );
        std::fs::write(path, &hex).expect("write dex_create_pool_data.hex");
        let read_back = std::fs::read_to_string(path).unwrap();
        assert_eq!(read_back, hex);

        assert_eq!(SwapInstruction::unpack(&packed).unwrap(), check);
    }

    /// Golden vector shared with the JS ceremony's `genesis-codec.mjs`
    /// (`encodeInitializeConfigData`) — packs a FIXED `InitializeConfig`
    /// instruction and writes it to
    /// `contracts/test/vectors/dex_initialize_config_data.hex`. Layout:
    /// `[8][admin:32][treasury:32][mode:1]`, same fixture values as
    /// `pack_initialize_config` above.
    #[test]
    fn golden_vector_initialize_config_data() {
        let admin = Pubkey::new_from_array([11u8; 32]);
        let treasury = Pubkey::new_from_array([22u8; 32]);
        let check = SwapInstruction::InitializeConfig(InitializeConfig {
            admin,
            treasury,
            mode: 1,
        });
        let packed = check.pack();
        assert_eq!(packed.len(), 66);

        let hex = format!("0x{}", packed.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/test/vectors/dex_initialize_config_data.hex"
        );
        std::fs::write(path, &hex).expect("write dex_initialize_config_data.hex");
        let read_back = std::fs::read_to_string(path).unwrap();
        assert_eq!(read_back, hex);

        assert_eq!(SwapInstruction::unpack(&packed).unwrap(), check);
    }

    /// Tag 8, exact packed byte vector: `[8][admin:32][treasury:32][mode:1]`
    /// — 66 bytes total (65-byte payload + tag).
    #[test]
    fn pack_initialize_config() {
        let admin = Pubkey::new_from_array([11u8; 32]);
        let treasury = Pubkey::new_from_array([22u8; 32]);
        let mode: u8 = 1;
        let check = SwapInstruction::InitializeConfig(InitializeConfig {
            admin,
            treasury,
            mode,
        });
        let packed = check.pack();
        let mut expect = vec![8u8];
        expect.extend_from_slice(admin.as_ref());
        expect.extend_from_slice(treasury.as_ref());
        expect.push(mode);
        assert_eq!(expect.len(), 66);
        assert_eq!(packed, expect);
        let unpacked = SwapInstruction::unpack(&expect).unwrap();
        assert_eq!(unpacked, check);
    }

    #[test]
    fn pack_set_treasury() {
        let treasury = Pubkey::new_from_array([33u8; 32]);
        let check = SwapInstruction::SetTreasury(SetTreasury { treasury });
        let packed = check.pack();
        let mut expect = vec![9u8];
        expect.extend_from_slice(treasury.as_ref());
        assert_eq!(packed, expect);
        let unpacked = SwapInstruction::unpack(&expect).unwrap();
        assert_eq!(unpacked, check);
    }

    /// Golden vector shared with the dress-rehearsal SDK builder tests
    /// (`sdk/rome-dex.ts::buildSetTreasury`, pinned in
    /// `harness/rome-dex-sdk.test.mjs`) — SAME fixture value as
    /// `pack_set_treasury` above, additionally WRITTEN to
    /// `contracts/test/vectors/dex_set_treasury_data.hex` so the SDK can
    /// byte-compare against a Rust-generated fixture rather than a
    /// hand-copied constant.
    #[test]
    fn golden_vector_set_treasury_data() {
        let treasury = Pubkey::new_from_array([33u8; 32]);
        let check = SwapInstruction::SetTreasury(SetTreasury { treasury });
        let packed = check.pack();
        assert_eq!(packed.len(), 33);

        let hex = format!("0x{}", packed.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/test/vectors/dex_set_treasury_data.hex"
        );
        std::fs::write(path, &hex).expect("write dex_set_treasury_data.hex");
        let read_back = std::fs::read_to_string(path).unwrap();
        assert_eq!(read_back, hex);

        assert_eq!(SwapInstruction::unpack(&packed).unwrap(), check);
    }

    #[test]
    fn pack_transfer_admin() {
        let pending_admin = Pubkey::new_from_array([44u8; 32]);
        let check = SwapInstruction::TransferAdmin(TransferAdmin { pending_admin });
        let packed = check.pack();
        let mut expect = vec![10u8];
        expect.extend_from_slice(pending_admin.as_ref());
        assert_eq!(packed, expect);
        let unpacked = SwapInstruction::unpack(&expect).unwrap();
        assert_eq!(unpacked, check);
    }

    /// Golden vector shared with `sdk/rome-dex.ts::buildTransferAdmin` — same
    /// fixture as `pack_transfer_admin`, written to
    /// `contracts/test/vectors/dex_transfer_admin_data.hex`.
    #[test]
    fn golden_vector_transfer_admin_data() {
        let pending_admin = Pubkey::new_from_array([44u8; 32]);
        let check = SwapInstruction::TransferAdmin(TransferAdmin { pending_admin });
        let packed = check.pack();
        assert_eq!(packed.len(), 33);

        let hex = format!("0x{}", packed.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/test/vectors/dex_transfer_admin_data.hex"
        );
        std::fs::write(path, &hex).expect("write dex_transfer_admin_data.hex");
        let read_back = std::fs::read_to_string(path).unwrap();
        assert_eq!(read_back, hex);

        assert_eq!(SwapInstruction::unpack(&packed).unwrap(), check);
    }

    /// Zero-payload tags (11, 12): pack emits just the tag byte; unpack
    /// ignores trailing bytes — same discipline as tag 0 (`tag0_reserved`).
    #[test]
    fn pack_accept_admin() {
        let check = SwapInstruction::AcceptAdmin;
        assert_eq!(check.pack(), vec![11u8]);
        assert_eq!(SwapInstruction::unpack(&[11u8]).unwrap(), check);
    }

    /// Golden vector shared with `sdk/rome-dex.ts::buildAcceptAdmin` — the
    /// tag-11 zero-payload byte, written to
    /// `contracts/test/vectors/dex_accept_admin_data.hex`.
    #[test]
    fn golden_vector_accept_admin_data() {
        let check = SwapInstruction::AcceptAdmin;
        let packed = check.pack();
        assert_eq!(packed, vec![11u8]);

        let hex = format!("0x{}", packed.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/test/vectors/dex_accept_admin_data.hex"
        );
        std::fs::write(path, &hex).expect("write dex_accept_admin_data.hex");
        let read_back = std::fs::read_to_string(path).unwrap();
        assert_eq!(read_back, hex);

        assert_eq!(SwapInstruction::unpack(&packed).unwrap(), check);
    }

    #[test]
    fn pack_collect_protocol_fees() {
        let check = SwapInstruction::CollectProtocolFees;
        assert_eq!(check.pack(), vec![12u8]);
        assert_eq!(SwapInstruction::unpack(&[12u8]).unwrap(), check);
    }

    #[test]
    fn pack_set_pool_creation() {
        let mode: u8 = 1;
        let check = SwapInstruction::SetPoolCreation(SetPoolCreation { mode });
        let packed = check.pack();
        let expect = vec![13u8, mode];
        assert_eq!(packed, expect);
        let unpacked = SwapInstruction::unpack(&expect).unwrap();
        assert_eq!(unpacked, check);
    }

    /// Golden vector shared with `sdk/rome-dex.ts::buildSetPoolCreation` —
    /// same fixture (mode=1) as `pack_set_pool_creation`, written to
    /// `contracts/test/vectors/dex_set_pool_creation_data.hex`.
    #[test]
    fn golden_vector_set_pool_creation_data() {
        let mode: u8 = 1;
        let check = SwapInstruction::SetPoolCreation(SetPoolCreation { mode });
        let packed = check.pack();
        assert_eq!(packed, vec![13u8, mode]);

        let hex = format!("0x{}", packed.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/test/vectors/dex_set_pool_creation_data.hex"
        );
        std::fs::write(path, &hex).expect("write dex_set_pool_creation_data.hex");
        let read_back = std::fs::read_to_string(path).unwrap();
        assert_eq!(read_back, hex);

        assert_eq!(SwapInstruction::unpack(&packed).unwrap(), check);
    }

    #[test]
    fn pack_withdraw_one_exact_out() {
        let destination_token_amount: u64 = 102198761982612;
        let maximum_pool_token_amount: u64 = 1212438012089;
        let check = SwapInstruction::WithdrawSingleTokenTypeExactAmountOut(
            WithdrawSingleTokenTypeExactAmountOut {
                destination_token_amount,
                maximum_pool_token_amount,
            },
        );
        let packed = check.pack();
        let mut expect = vec![5];
        expect.extend_from_slice(&destination_token_amount.to_le_bytes());
        expect.extend_from_slice(&maximum_pool_token_amount.to_le_bytes());
        assert_eq!(packed, expect);
        let unpacked = SwapInstruction::unpack(&expect).unwrap();
        assert_eq!(unpacked, check);
    }
}
