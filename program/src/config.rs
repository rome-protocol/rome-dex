//! Protocol authority state: `ProtocolConfig`, the single PDA `[b"config"]`
//! that holds admin/treasury/pool-creation-mode for the whole program.
//! Manual `Pack`, `arrayref` style — mirrors `SwapV2` (`state.rs:206-277`).
//! Unlike `SwapVersion`/`SwapV2`, there is no outer discriminator wrapping
//! this struct: `version` IS byte 0 of the account (the design plan).

use {
    arrayref::{array_mut_ref, array_ref, array_refs, mut_array_refs},
    solana_program::{
        program_error::ProgramError,
        program_pack::{IsInitialized, Pack, Sealed},
        pubkey::Pubkey,
    },
};

/// Seed for the single config PDA `[b"config"]`.
pub const CONFIG_SEED: &[u8] = b"config";

/// `pool_creation_mode`: only the admin may create pools.
pub const MODE_ADMIN_ONLY: u8 = 0;
/// `pool_creation_mode`: anyone may create pools.
pub const MODE_PERMISSIONLESS: u8 = 1;

/// The live version tag. Any other byte (including 0, the zeroed-shell
/// default) means "not initialized".
pub const CONFIG_VERSION: u8 = 1;

/// Protocol-wide authority + policy config. One PDA, never per-pool.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ProtocolConfig {
    /// 1 = initialized (this version); 0 = uninitialized shell; any other
    /// byte can never be produced by this program and is refused identically
    /// to 0 (greenfield — mirrors `state.rs:79-86`'s reasoning).
    pub version: u8,
    /// Current admin. Signs `SetTreasury` / `TransferAdmin` / `SetPoolCreation`,
    /// and (mode 0) is the required payer for `CreatePool`.
    pub admin: Pubkey,
    /// Pending admin from an in-flight two-step `TransferAdmin`.
    /// `Pubkey::default()` = no transfer pending.
    pub pending_admin: Pubkey,
    /// Destination owner for `CollectProtocolFees` — read live, not cached.
    pub treasury: Pubkey,
    /// 0 = admin-only pool creation, 1 = permissionless. Any other stored
    /// byte behaves as admin-only by construction: there is no
    /// permissive fallback arm to forget.
    pub pool_creation_mode: u8,
}

impl ProtocolConfig {
    /// Byte layout is account-absolute (no outer discriminator).
    pub const LEN: usize = 98;

    /// Derives `[b"config"]` under `program_id`.
    pub fn find_address(program_id: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[CONFIG_SEED], program_id)
    }

    /// Fail-closed mode check: only byte `MODE_PERMISSIONLESS`
    /// disables the admin-only gate. Any other stored value — including an
    /// unknown mode ≥ 2 that could never be written by `SetPoolCreation`'s
    /// own validation, e.g. a hand-forged account in a test — behaves as
    /// admin-only. No third arm exists to forget.
    pub fn is_permissionless(&self) -> bool {
        self.pool_creation_mode == MODE_PERMISSIONLESS
    }
}

impl Sealed for ProtocolConfig {}

impl IsInitialized for ProtocolConfig {
    fn is_initialized(&self) -> bool {
        self.version == CONFIG_VERSION
    }
}

impl Pack for ProtocolConfig {
    const LEN: usize = ProtocolConfig::LEN;

    fn pack_into_slice(&self, output: &mut [u8]) {
        let output = array_mut_ref![output, 0, ProtocolConfig::LEN];
        let (version, admin, pending_admin, treasury, pool_creation_mode) =
            mut_array_refs![output, 1, 32, 32, 32, 1];
        version[0] = self.version;
        admin.copy_from_slice(self.admin.as_ref());
        pending_admin.copy_from_slice(self.pending_admin.as_ref());
        treasury.copy_from_slice(self.treasury.as_ref());
        pool_creation_mode[0] = self.pool_creation_mode;
    }

    fn unpack_from_slice(input: &[u8]) -> Result<Self, ProgramError> {
        let input = array_ref![input, 0, ProtocolConfig::LEN];
        let (version, admin, pending_admin, treasury, pool_creation_mode) =
            array_refs![input, 1, 32, 32, 32, 1];
        Ok(Self {
            version: version[0],
            admin: Pubkey::new_from_array(*admin),
            pending_admin: Pubkey::new_from_array(*pending_admin),
            treasury: Pubkey::new_from_array(*treasury),
            pool_creation_mode: pool_creation_mode[0],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_ADMIN: Pubkey = Pubkey::new_from_array([9u8; 32]);
    const TEST_PENDING: Pubkey = Pubkey::new_from_array([8u8; 32]);
    const TEST_TREASURY: Pubkey = Pubkey::new_from_array([7u8; 32]);

    /// Pins the offset table exactly — v2 clients read these offsets
    /// directly.
    #[test]
    fn protocol_config_offsets_pinned() {
        assert_eq!(ProtocolConfig::LEN, 98);

        let config = ProtocolConfig {
            version: CONFIG_VERSION,
            admin: TEST_ADMIN,
            pending_admin: TEST_PENDING,
            treasury: TEST_TREASURY,
            pool_creation_mode: MODE_ADMIN_ONLY,
        };
        let mut packed = [0u8; ProtocolConfig::LEN];
        config.pack_into_slice(&mut packed);

        assert_eq!(packed[0], CONFIG_VERSION);
        assert_eq!(&packed[1..33], TEST_ADMIN.as_ref());
        assert_eq!(&packed[33..65], TEST_PENDING.as_ref());
        assert_eq!(&packed[65..97], TEST_TREASURY.as_ref());
        assert_eq!(packed[97], MODE_ADMIN_ONLY);

        let unpacked = ProtocolConfig::unpack_from_slice(&packed).unwrap();
        assert_eq!(unpacked, config);
    }

    /// Golden vector for the packed ProtocolConfig byte layout.
    /// Packs a FIXED ProtocolConfig
    /// fixture and writes the 98-byte buffer to
    /// `contracts/test/vectors/dex_protocol_config.hex`. Generated from this
    /// struct, not hand-authored.
    #[test]
    fn golden_vector_protocol_config() {
        let config = ProtocolConfig {
            version: CONFIG_VERSION,
            admin: TEST_ADMIN,
            pending_admin: TEST_PENDING,
            treasury: TEST_TREASURY,
            pool_creation_mode: MODE_ADMIN_ONLY,
        };
        let mut packed = [0u8; ProtocolConfig::LEN];
        config.pack_into_slice(&mut packed);

        let hex = format!("0x{}", packed.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/test/vectors/dex_protocol_config.hex"
        );
        std::fs::write(path, &hex).expect("write dex_protocol_config.hex");

        let read_back = std::fs::read_to_string(path).unwrap();
        assert_eq!(read_back, hex);
    }

    #[test]
    fn protocol_config_is_initialized_gate() {
        let mut config = ProtocolConfig {
            version: 0,
            admin: TEST_ADMIN,
            pending_admin: Pubkey::default(),
            treasury: TEST_TREASURY,
            pool_creation_mode: MODE_ADMIN_ONLY,
        };
        assert!(!config.is_initialized());
        config.version = CONFIG_VERSION;
        assert!(config.is_initialized());
        config.version = 2; // any other byte — greenfield, never produced
        assert!(!config.is_initialized());
    }

    #[test]
    fn protocol_config_is_permissionless_fail_closed() {
        let mut config = ProtocolConfig {
            version: CONFIG_VERSION,
            admin: TEST_ADMIN,
            pending_admin: Pubkey::default(),
            treasury: TEST_TREASURY,
            pool_creation_mode: MODE_ADMIN_ONLY,
        };
        assert!(!config.is_permissionless());
        config.pool_creation_mode = MODE_PERMISSIONLESS;
        assert!(config.is_permissionless());
        // Unknown mode falls to the restrictive branch — no third arm.
        config.pool_creation_mode = 7;
        assert!(!config.is_permissionless());
    }
}
