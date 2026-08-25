//! State transition types

use {
    crate::curve::{base::SwapCurve, fees::Fees},
    arrayref::{array_mut_ref, array_ref, array_refs, mut_array_refs},
    enum_dispatch::enum_dispatch,
    solana_program::{
        program_error::ProgramError,
        program_pack::{IsInitialized, Pack, Sealed},
        pubkey::Pubkey,
    },
    std::sync::Arc,
};

/// Trait representing access to program state across all versions
#[enum_dispatch]
pub trait SwapState {
    /// Is the swap initialized, with data written to it
    fn is_initialized(&self) -> bool;
    /// Bump seed used to generate the program address / authority
    fn bump_seed(&self) -> u8;
    /// Token program ID associated with the swap
    fn token_program_id(&self) -> &Pubkey;
    /// Address of token A liquidity account
    fn token_a_account(&self) -> &Pubkey;
    /// Address of token B liquidity account
    fn token_b_account(&self) -> &Pubkey;
    /// Address of pool token mint
    fn pool_mint(&self) -> &Pubkey;

    /// Address of token A mint
    fn token_a_mint(&self) -> &Pubkey;
    /// Address of token B mint
    fn token_b_mint(&self) -> &Pubkey;

    /// Accrued protocol fee, source-side-A swaps (u64, counter — never a
    /// spendable account; see `Processor::lp_owned`).
    fn protocol_fees_a(&self) -> u64;
    /// Accrued protocol fee, source-side-B swaps.
    fn protocol_fees_b(&self) -> u64;

    /// Fees associated with swap
    fn fees(&self) -> &Fees;
    /// Curve associated with swap
    fn swap_curve(&self) -> &SwapCurve;
}

/// All versions of SwapState
#[enum_dispatch(SwapState)]
pub enum SwapVersion {
    /// Latest version, used for all new swaps
    SwapV2,
}

/// SwapVersion does not implement program_pack::Pack because there are size
/// checks on pack and unpack that would break backwards compatibility, so
/// special implementations are provided here
impl SwapVersion {
    /// Size of the latest version of the SwapState
    pub const LATEST_LEN: usize = 1 + SwapV2::LEN; // add one for the version enum

    /// Pack a swap into a byte array, based on its version
    pub fn pack(src: Self, dst: &mut [u8]) -> Result<(), ProgramError> {
        match src {
            Self::SwapV2(swap_info) => {
                dst[0] = 2;
                SwapV2::pack(swap_info, &mut dst[1..])
            }
        }
    }

    /// Unpack the swap account based on its version, returning the result as a
    /// SwapState trait object
    pub fn unpack(input: &[u8]) -> Result<Arc<dyn SwapState>, ProgramError> {
        let (&version, rest) = input
            .split_first()
            .ok_or(ProgramError::InvalidAccountData)?;
        match version {
            2 => Ok(Arc::new(SwapV2::unpack(rest)?)),
            // Unknown version (including the retired v1 shape, `1`) is the
            // same "uninitialized" refusal a zeroed account produces —
            // mainnet is greenfield, so a v1 read path is code mainnet can
            // never execute; a dedicated error is over-engineering for a
            // byte mainnet can never contain.
            _ => Err(ProgramError::UninitializedAccount),
        }
    }

    /// Special check to be done before any instruction processing, works for
    /// all versions
    pub fn is_initialized(input: &[u8]) -> bool {
        match Self::unpack(input) {
            Ok(swap) => swap.is_initialized(),
            Err(_) => false,
        }
    }
}

/// Program state, v2: drops `pool_fee_account` (the compiled-in-owner LP-mint
/// fee custody slot); adds `protocol_fees_a`/`protocol_fees_b` counters at
/// the tail (drop-then-append versioning). See the design plan
/// for the offset table (the router reads these two u64s directly).
#[repr(C)]
#[derive(Debug, Default, PartialEq)]
pub struct SwapV2 {
    /// Initialized state.
    pub is_initialized: bool,
    /// Bump seed used in program address.
    /// The program address is created deterministically with the bump seed,
    /// swap program id, and swap account pubkey.  This program address has
    /// authority over the swap's token A account, token B account, and pool
    /// token mint.
    pub bump_seed: u8,

    /// Program ID of the tokens being exchanged.
    pub token_program_id: Pubkey,

    /// Token A
    pub token_a: Pubkey,
    /// Token B
    pub token_b: Pubkey,

    /// Pool tokens are issued when A or B tokens are deposited.
    /// Pool tokens can be withdrawn back to the original A or B token.
    pub pool_mint: Pubkey,

    /// Mint information for token A
    pub token_a_mint: Pubkey,
    /// Mint information for token B
    pub token_b_mint: Pubkey,

    /// All fee information
    pub fees: Fees,

    /// Swap curve parameters, to be unpacked and used by the SwapCurve, which
    /// calculates swaps, deposits, and withdrawals
    pub swap_curve: SwapCurve,

    /// Accrued protocol fee from AtoB-direction swaps (source-side token A
    /// units). Tokens are already in the `token_a` vault (both curve paths
    /// fold the fee into `new_swap_source_amount`); this is pure bookkeeping
    /// over tokens that physically arrived. Only shrinks via a future
    /// permissionless collect (not this slice) — no instruction in this
    /// slice names it as a source of funds.
    pub protocol_fees_a: u64,
    /// Accrued protocol fee from BtoA-direction swaps (source-side token B
    /// units).
    pub protocol_fees_b: u64,
}

impl SwapState for SwapV2 {
    fn is_initialized(&self) -> bool {
        self.is_initialized
    }

    fn bump_seed(&self) -> u8 {
        self.bump_seed
    }

    fn token_program_id(&self) -> &Pubkey {
        &self.token_program_id
    }

    fn token_a_account(&self) -> &Pubkey {
        &self.token_a
    }

    fn token_b_account(&self) -> &Pubkey {
        &self.token_b
    }

    fn pool_mint(&self) -> &Pubkey {
        &self.pool_mint
    }

    fn token_a_mint(&self) -> &Pubkey {
        &self.token_a_mint
    }

    fn token_b_mint(&self) -> &Pubkey {
        &self.token_b_mint
    }

    fn protocol_fees_a(&self) -> u64 {
        self.protocol_fees_a
    }

    fn protocol_fees_b(&self) -> u64 {
        self.protocol_fees_b
    }

    fn fees(&self) -> &Fees {
        &self.fees
    }

    fn swap_curve(&self) -> &SwapCurve {
        &self.swap_curve
    }
}

impl Sealed for SwapV2 {}
impl IsInitialized for SwapV2 {
    fn is_initialized(&self) -> bool {
        self.is_initialized
    }
}

impl Pack for SwapV2 {
    const LEN: usize = 307;

    fn pack_into_slice(&self, output: &mut [u8]) {
        let output = array_mut_ref![output, 0, 307];
        let (
            is_initialized,
            bump_seed,
            token_program_id,
            token_a,
            token_b,
            pool_mint,
            token_a_mint,
            token_b_mint,
            fees,
            swap_curve,
            protocol_fees_a,
            protocol_fees_b,
        ) = mut_array_refs![output, 1, 1, 32, 32, 32, 32, 32, 32, 64, 33, 8, 8];
        is_initialized[0] = self.is_initialized as u8;
        bump_seed[0] = self.bump_seed;
        token_program_id.copy_from_slice(self.token_program_id.as_ref());
        token_a.copy_from_slice(self.token_a.as_ref());
        token_b.copy_from_slice(self.token_b.as_ref());
        pool_mint.copy_from_slice(self.pool_mint.as_ref());
        token_a_mint.copy_from_slice(self.token_a_mint.as_ref());
        token_b_mint.copy_from_slice(self.token_b_mint.as_ref());
        self.fees.pack_into_slice(&mut fees[..]);
        self.swap_curve.pack_into_slice(&mut swap_curve[..]);
        *protocol_fees_a = self.protocol_fees_a.to_le_bytes();
        *protocol_fees_b = self.protocol_fees_b.to_le_bytes();
    }

    /// Unpacks a byte buffer into a [SwapV2](struct.SwapV2.html).
    fn unpack_from_slice(input: &[u8]) -> Result<Self, ProgramError> {
        let input = array_ref![input, 0, 307];
        #[allow(clippy::ptr_offset_with_cast)]
        let (
            is_initialized,
            bump_seed,
            token_program_id,
            token_a,
            token_b,
            pool_mint,
            token_a_mint,
            token_b_mint,
            fees,
            swap_curve,
            protocol_fees_a,
            protocol_fees_b,
        ) = array_refs![input, 1, 1, 32, 32, 32, 32, 32, 32, 64, 33, 8, 8];
        Ok(Self {
            is_initialized: match is_initialized {
                [0] => false,
                [1] => true,
                _ => return Err(ProgramError::InvalidAccountData),
            },
            bump_seed: bump_seed[0],
            token_program_id: Pubkey::new_from_array(*token_program_id),
            token_a: Pubkey::new_from_array(*token_a),
            token_b: Pubkey::new_from_array(*token_b),
            pool_mint: Pubkey::new_from_array(*pool_mint),
            token_a_mint: Pubkey::new_from_array(*token_a_mint),
            token_b_mint: Pubkey::new_from_array(*token_b_mint),
            fees: Fees::unpack_from_slice(fees)?,
            swap_curve: SwapCurve::unpack_from_slice(swap_curve)?,
            protocol_fees_a: u64::from_le_bytes(*protocol_fees_a),
            protocol_fees_b: u64::from_le_bytes(*protocol_fees_b),
        })
    }
}

#[cfg(test)]
mod tests {
    use {super::*, crate::curve::offset::OffsetCurve, std::convert::TryInto};

    const TEST_FEES: Fees = Fees {
        trade_fee_numerator: 1,
        trade_fee_denominator: 4,
        owner_trade_fee_numerator: 3,
        owner_trade_fee_denominator: 10,
        owner_withdraw_fee_numerator: 2,
        owner_withdraw_fee_denominator: 7,
        host_fee_numerator: 5,
        host_fee_denominator: 20,
    };

    const TEST_BUMP_SEED: u8 = 255;
    const TEST_TOKEN_PROGRAM_ID: Pubkey = Pubkey::new_from_array([1u8; 32]);
    const TEST_TOKEN_A: Pubkey = Pubkey::new_from_array([2u8; 32]);
    const TEST_TOKEN_B: Pubkey = Pubkey::new_from_array([3u8; 32]);
    const TEST_POOL_MINT: Pubkey = Pubkey::new_from_array([4u8; 32]);
    const TEST_TOKEN_A_MINT: Pubkey = Pubkey::new_from_array([5u8; 32]);
    const TEST_TOKEN_B_MINT: Pubkey = Pubkey::new_from_array([6u8; 32]);
    const TEST_PROTOCOL_FEES_A: u64 = 111_222;
    const TEST_PROTOCOL_FEES_B: u64 = 333_444;

    const TEST_CURVE_TYPE: u8 = 2;
    const TEST_TOKEN_B_OFFSET: u64 = 1_000_000_000;
    const TEST_CURVE: OffsetCurve = OffsetCurve {
        token_b_offset: TEST_TOKEN_B_OFFSET,
    };

    #[test]
    fn swap_version_pack() {
        let curve_type = TEST_CURVE_TYPE.try_into().unwrap();
        let calculator = Arc::new(TEST_CURVE);
        let swap_curve = SwapCurve {
            curve_type,
            calculator,
        };
        let swap_info = SwapVersion::SwapV2(SwapV2 {
            is_initialized: true,
            bump_seed: TEST_BUMP_SEED,
            token_program_id: TEST_TOKEN_PROGRAM_ID,
            token_a: TEST_TOKEN_A,
            token_b: TEST_TOKEN_B,
            pool_mint: TEST_POOL_MINT,
            token_a_mint: TEST_TOKEN_A_MINT,
            token_b_mint: TEST_TOKEN_B_MINT,
            fees: TEST_FEES,
            swap_curve: swap_curve.clone(),
            protocol_fees_a: TEST_PROTOCOL_FEES_A,
            protocol_fees_b: TEST_PROTOCOL_FEES_B,
        });

        let mut packed = [0u8; SwapVersion::LATEST_LEN];
        SwapVersion::pack(swap_info, &mut packed).unwrap();
        assert_eq!(packed[0], 2);
        let unpacked = SwapVersion::unpack(&packed).unwrap();

        assert!(unpacked.is_initialized());
        assert_eq!(unpacked.bump_seed(), TEST_BUMP_SEED);
        assert_eq!(*unpacked.token_program_id(), TEST_TOKEN_PROGRAM_ID);
        assert_eq!(*unpacked.token_a_account(), TEST_TOKEN_A);
        assert_eq!(*unpacked.token_b_account(), TEST_TOKEN_B);
        assert_eq!(*unpacked.pool_mint(), TEST_POOL_MINT);
        assert_eq!(*unpacked.token_a_mint(), TEST_TOKEN_A_MINT);
        assert_eq!(*unpacked.token_b_mint(), TEST_TOKEN_B_MINT);
        assert_eq!(unpacked.protocol_fees_a(), TEST_PROTOCOL_FEES_A);
        assert_eq!(unpacked.protocol_fees_b(), TEST_PROTOCOL_FEES_B);
        assert_eq!(*unpacked.fees(), TEST_FEES);
        assert_eq!(*unpacked.swap_curve(), swap_curve);
    }

    /// Pins the offset table exactly: LEN/LATEST_LEN and the tail
    /// counters at account-relative bytes 292/300 (the router reads
    /// these two u64s directly).
    #[test]
    fn swap_v2_offsets_pinned() {
        assert_eq!(SwapV2::LEN, 307);
        assert_eq!(SwapVersion::LATEST_LEN, 308);

        let curve_type = TEST_CURVE_TYPE.try_into().unwrap();
        let calculator = Arc::new(TEST_CURVE);
        let swap_curve = SwapCurve {
            curve_type,
            calculator,
        };
        let swap_info = SwapV2 {
            is_initialized: true,
            bump_seed: TEST_BUMP_SEED,
            token_program_id: TEST_TOKEN_PROGRAM_ID,
            token_a: TEST_TOKEN_A,
            token_b: TEST_TOKEN_B,
            pool_mint: TEST_POOL_MINT,
            token_a_mint: TEST_TOKEN_A_MINT,
            token_b_mint: TEST_TOKEN_B_MINT,
            fees: TEST_FEES,
            swap_curve,
            protocol_fees_a: TEST_PROTOCOL_FEES_A,
            protocol_fees_b: TEST_PROTOCOL_FEES_B,
        };
        let mut packed = [0u8; SwapVersion::LATEST_LEN];
        SwapVersion::pack(SwapVersion::SwapV2(swap_info), &mut packed).unwrap();

        // account-relative offsets (version byte included at 0)
        assert_eq!(
            u64::from_le_bytes(packed[292..300].try_into().unwrap()),
            TEST_PROTOCOL_FEES_A
        );
        assert_eq!(
            u64::from_le_bytes(packed[300..308].try_into().unwrap()),
            TEST_PROTOCOL_FEES_B
        );
    }

    #[test]
    fn swap_v2_pack() {
        let curve_type = TEST_CURVE_TYPE.try_into().unwrap();
        let calculator = Arc::new(TEST_CURVE);
        let swap_curve = SwapCurve {
            curve_type,
            calculator,
        };
        let swap_info = SwapV2 {
            is_initialized: true,
            bump_seed: TEST_BUMP_SEED,
            token_program_id: TEST_TOKEN_PROGRAM_ID,
            token_a: TEST_TOKEN_A,
            token_b: TEST_TOKEN_B,
            pool_mint: TEST_POOL_MINT,
            token_a_mint: TEST_TOKEN_A_MINT,
            token_b_mint: TEST_TOKEN_B_MINT,
            fees: TEST_FEES,
            swap_curve,
            protocol_fees_a: TEST_PROTOCOL_FEES_A,
            protocol_fees_b: TEST_PROTOCOL_FEES_B,
        };

        let mut packed = [0u8; SwapV2::LEN];
        SwapV2::pack_into_slice(&swap_info, &mut packed);
        let unpacked = SwapV2::unpack(&packed).unwrap();
        assert_eq!(swap_info, unpacked);

        let mut packed = vec![1u8, TEST_BUMP_SEED];
        packed.extend_from_slice(&TEST_TOKEN_PROGRAM_ID.to_bytes());
        packed.extend_from_slice(&TEST_TOKEN_A.to_bytes());
        packed.extend_from_slice(&TEST_TOKEN_B.to_bytes());
        packed.extend_from_slice(&TEST_POOL_MINT.to_bytes());
        packed.extend_from_slice(&TEST_TOKEN_A_MINT.to_bytes());
        packed.extend_from_slice(&TEST_TOKEN_B_MINT.to_bytes());
        packed.extend_from_slice(&TEST_FEES.trade_fee_numerator.to_le_bytes());
        packed.extend_from_slice(&TEST_FEES.trade_fee_denominator.to_le_bytes());
        packed.extend_from_slice(&TEST_FEES.owner_trade_fee_numerator.to_le_bytes());
        packed.extend_from_slice(&TEST_FEES.owner_trade_fee_denominator.to_le_bytes());
        packed.extend_from_slice(&TEST_FEES.owner_withdraw_fee_numerator.to_le_bytes());
        packed.extend_from_slice(&TEST_FEES.owner_withdraw_fee_denominator.to_le_bytes());
        packed.extend_from_slice(&TEST_FEES.host_fee_numerator.to_le_bytes());
        packed.extend_from_slice(&TEST_FEES.host_fee_denominator.to_le_bytes());
        packed.push(TEST_CURVE_TYPE);
        packed.extend_from_slice(&TEST_TOKEN_B_OFFSET.to_le_bytes());
        packed.extend_from_slice(&[0u8; 24]);
        packed.extend_from_slice(&TEST_PROTOCOL_FEES_A.to_le_bytes());
        packed.extend_from_slice(&TEST_PROTOCOL_FEES_B.to_le_bytes());
        let unpacked = SwapV2::unpack(&packed).unwrap();
        assert_eq!(swap_info, unpacked);

        let packed = [0u8; SwapV2::LEN];
        let swap_info: SwapV2 = Default::default();
        let unpack_unchecked = SwapV2::unpack_unchecked(&packed).unwrap();
        assert_eq!(unpack_unchecked, swap_info);
        let err = SwapV2::unpack(&packed).unwrap_err();
        assert_eq!(err, ProgramError::UninitializedAccount);
    }

    /// Golden vector for the packed SwapV2 byte layout.
    /// Packs a FIXED SwapV2 fixture
    /// (every field distinct so an offset/endianness mutation can't hide)
    /// and writes the 308-byte (version-prefixed) buffer to
    /// `contracts/test/vectors/dex_swap_v2_state.hex`. The JS side decodes
    /// this file and asserts every field — nothing is hand-authored on
    /// either side, both are generated from / checked against the SAME
    /// Rust struct definition.
    #[test]
    fn golden_vector_swap_v2_state() {
        let curve_type = TEST_CURVE_TYPE.try_into().unwrap();
        let calculator = Arc::new(TEST_CURVE);
        let swap_curve = SwapCurve {
            curve_type,
            calculator,
        };
        let swap_info = SwapV2 {
            is_initialized: true,
            bump_seed: TEST_BUMP_SEED,
            token_program_id: TEST_TOKEN_PROGRAM_ID,
            token_a: TEST_TOKEN_A,
            token_b: TEST_TOKEN_B,
            pool_mint: TEST_POOL_MINT,
            token_a_mint: TEST_TOKEN_A_MINT,
            token_b_mint: TEST_TOKEN_B_MINT,
            fees: TEST_FEES,
            swap_curve,
            protocol_fees_a: TEST_PROTOCOL_FEES_A,
            protocol_fees_b: TEST_PROTOCOL_FEES_B,
        };
        let mut packed = [0u8; SwapVersion::LATEST_LEN];
        SwapVersion::pack(SwapVersion::SwapV2(swap_info), &mut packed).unwrap();

        let hex = format!("0x{}", packed.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/test/vectors/dex_swap_v2_state.hex"
        );
        std::fs::write(path, &hex).expect("write dex_swap_v2_state.hex");

        // Round-trip through the file we just wrote — proves the write and
        // the pack are consistent, not just that the write succeeded.
        let read_back = std::fs::read_to_string(path).unwrap();
        assert_eq!(read_back, hex);
    }

    /// RA4 (RED SET A): a hand-built v1-shaped buffer (version
    /// byte 1) must be rejected now that SwapV1 is deleted and version 2 is
    /// the only live shape. Built by hand (not via `SwapVersion::pack`) so
    /// this test is meaningful even with `SwapV1` gone.
    #[test]
    fn swap_version_rejects_v1_bytes() {
        let mut buf = vec![1u8]; // version byte 1 (the retired SwapV1)
        buf.push(1); // is_initialized = true
        buf.push(TEST_BUMP_SEED); // bump_seed
        buf.extend_from_slice(TEST_TOKEN_PROGRAM_ID.as_ref());
        buf.extend_from_slice(TEST_TOKEN_A.as_ref());
        buf.extend_from_slice(TEST_TOKEN_B.as_ref());
        buf.extend_from_slice(TEST_POOL_MINT.as_ref());
        buf.extend_from_slice(TEST_TOKEN_A_MINT.as_ref());
        buf.extend_from_slice(TEST_TOKEN_B_MINT.as_ref());
        buf.extend_from_slice(&[7u8; 32]); // legacy pool_fee_account slot
        buf.extend_from_slice(&TEST_FEES.trade_fee_numerator.to_le_bytes());
        buf.extend_from_slice(&TEST_FEES.trade_fee_denominator.to_le_bytes());
        buf.extend_from_slice(&TEST_FEES.owner_trade_fee_numerator.to_le_bytes());
        buf.extend_from_slice(&TEST_FEES.owner_trade_fee_denominator.to_le_bytes());
        buf.extend_from_slice(&TEST_FEES.owner_withdraw_fee_numerator.to_le_bytes());
        buf.extend_from_slice(&TEST_FEES.owner_withdraw_fee_denominator.to_le_bytes());
        buf.extend_from_slice(&TEST_FEES.host_fee_numerator.to_le_bytes());
        buf.extend_from_slice(&TEST_FEES.host_fee_denominator.to_le_bytes());
        buf.push(TEST_CURVE_TYPE);
        buf.extend_from_slice(&TEST_TOKEN_B_OFFSET.to_le_bytes());
        buf.extend_from_slice(&[0u8; 24]);
        assert_eq!(buf.len(), 324); // 1 (version) + legacy SwapV1::LEN (323)

        let err = SwapVersion::unpack(&buf).map(|_| ()).unwrap_err();
        assert_eq!(err, ProgramError::UninitializedAccount);
    }
}
