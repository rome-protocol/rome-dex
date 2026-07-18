// Chain-config logic. Chain METADATA (RPCs incl. the public Solana RPC, explorer,
// program id, oracle feeds) comes from the public @rome-protocol/registry; the
// local config supplies only the dex/clmm POOL data, merged on top here. Imported
// by the /api/chains route (server) and the client store. Types live in types.ts.
import { registryChainFields } from "./registry.mjs";

function req(obj, key, ctx) {
  const v = obj?.[key];
  if (v === undefined || v === null || v === "") throw new Error(`chains.yaml: ${ctx} missing '${key}'`);
  return v;
}

export function normalizeChains(raw) {
  const list = Array.isArray(raw?.chains) ? raw.chains : [];
  if (list.length === 0) throw new Error("chains.yaml: no chains defined");
  return list.map((c, i) => {
    const ctx = `chains[${i}]`;
    const chainId = String(req(c, "chainId", ctx));
    const dex = req(c, "dex", ctx);
    const entry = {
      ...registryChainFields(chainId), // chainId + chain metadata from the public registry
      dex: {
        dexProgram: req(dex, "dexProgram", `${ctx}.dex`),
        router: req(dex, "router", `${ctx}.dex`),
        tiers: Array.isArray(dex.tiers) ? dex.tiers : [],
        farm: dex.farm, // optional
      },
    };
    // Optional concentrated-liquidity product (rome-dex #42-#55). Omitted → hidden.
    if (c.clmm) {
      entry.clmm = {
        program: req(c.clmm, "program", `${ctx}.clmm`),
        router: req(c.clmm, "router", `${ctx}.clmm`),
        pools: Array.isArray(c.clmm.pools) ? c.clmm.pools : [],
      };
    }
    return entry;
  });
}

// Pure selectors live in select.mjs (client-safe — no registry import). Re-exported
// here so server code (server.mjs) and tests can keep importing them from core.mjs;
// the client (store.tsx) imports them directly from select.mjs to avoid bundling
// the server-only registry package into the browser.
export { getChainConfig, pickInitialChainId } from "./select.mjs";
