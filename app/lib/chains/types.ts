export interface PoolTier {
  pairId: string; tier: string; bps: number; swapState: string;
  program?: string; authority?: string; mintA?: string; mintB?: string;
  vaultA?: string; vaultB?: string; poolMint?: string; feeAccount?: string;
  decimalsA?: number; decimalsB?: number;
  feeTradeNum?: number; feeTradeDen?: number; feeOwnerNum?: number; feeOwnerDen?: number;
}
export interface DexConfig { dexProgram: string; router: string; tiers: PoolTier[]; farm?: Record<string, unknown>; }
export interface ClmmPool {
  pool: string; mint0: string; mint1: string; vault0: string; vault1: string;
  feePips: number; tickSpacing: number; symbol0: string; symbol1: string;
  decimals0: number; decimals1: number; tickArrays: Record<string, string>;
}
export interface ClmmConfig { program: string; router: string; pools: ClmmPool[]; }
export interface ChainConfig {
  chainId: string; name: string; evmRpc: string; solanaRpc: string;
  solanaCluster: string; explorerBase: string; romeEvmProgramId: string;
  oracle: { feeds: Record<string, string> }; dex: DexConfig; clmm?: ClmmConfig;
}
