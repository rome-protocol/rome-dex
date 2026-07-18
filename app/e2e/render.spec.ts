/**
 * render.spec.ts — per-route render smoke.
 *
 * For every one of the 5 App Router routes:
 *   • HTTP 200
 *   • the shared shell (TopNav + footer) renders
 *   • zero application console errors / uncaught exceptions
 *   • no mock/placeholder data leaks into the DOM
 *
 * "sample" chips on analytics/pools ARE legitimate (illustrative-data honesty
 * tags) and are explicitly allowed.
 */
import { test, expect } from "@playwright/test";
import { ROUTES, PAGE_TITLE, collectErrors } from "./helpers";

test.describe("Per-route render smoke", () => {
  for (const route of ROUTES) {
    test(`${route.name} (${route.path}) → 200, renders, no console errors`, async ({ page }) => {
      const getErrors = collectErrors(page);

      const response = await page.goto(route.path);
      expect(response?.status(), `HTTP status for ${route.path}`).toBe(200);

      // Shared shell present on every route.
      await expect(page.getByRole("tablist")).toBeVisible();
      await expect(page.locator("footer.foot")).toBeVisible();
      await expect(page).toHaveTitle(PAGE_TITLE);

      // Let client hydrate + first data fetch settle so any runtime error surfaces.
      await page.waitForLoadState("networkidle");

      expect(
        getErrors(),
        `Console/JS errors on ${route.path}: ${getErrors().join(" | ")}`,
      ).toHaveLength(0);
    });

    test(`${route.name} (${route.path}) → no mock/placeholder leakage`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      const body = (await page.content()).toLowerCase();
      // Wrapped-symbol leaks / lorem / literal template tokens that would only
      // appear if real data were replaced by mock fixtures. Note: "sample" is an
      // allowed honesty tag, and input `placeholder` attrs are legit UI.
      for (const bad of ["wusdc", "wsol", "$tvl", "lorem ipsum"]) {
        expect(body, `Found mock artefact "${bad}" on ${route.path}`).not.toContain(bad);
      }
    });

    // Chain, not wallet: the UI names LANES (EVM / Solana), never specific
    // wallet brands — the product bridges chains and accepts any wallet, so a
    // brand in the static UI wrongly implies wallet-specificity. (The Solana
    // wallet PICKER lists the user's OWN detected providers by name, which is
    // dynamic + only after a connect click — not part of this static guard.)
    test(`${route.name} (${route.path}) → no wallet-brand keywords (chain, not wallet)`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      const body = (await page.content()).toLowerCase();
      for (const brand of ["metamask", "phantom", "solflare"]) {
        expect(body, `Wallet brand "${brand}" leaked into ${route.path} — use EVM/Solana`).not.toContain(brand);
      }
    });

    // Experience, not engineering: users see outcomes (one transaction, your
    // minimum enforced, live figures), never the implementation telemetry
    // (CU budgets, atomicity vocabulary, CPI/PDA plumbing, curve equations,
    // internal component names). Guard runs on VISIBLE text — data-testids
    // and code stay free to use internal vocabulary.
    test(`${route.name} (${route.path}) → no dev-telemetry jargon (experience, not engineering)`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      const visible = (await page.evaluate(() => document.body.innerText)).toLowerCase();
      const words: Array<[RegExp, string]> = [
        [/\bcu\b/, "compute-unit telemetry"],
        [/compute unit/, "compute-unit telemetry"],
        [/atomic/, "atomicity vocabulary — say 'one transaction / all together or not at all'"],
        [/all-or-nothing/, "atomicity vocabulary"],
        [/x·y=k/, "curve equation"],
        [/constant-product/, "curve vocabulary"],
        [/\bcpi\b/, "Solana plumbing"],
        [/\bpda\b/, "Solana plumbing"],
        [/\bdelegate\b/, "SPL plumbing — say 'approval'"],
        [/\bparity\b/, "internal thesis vocabulary"],
        [/\brouter\b/, "internal component name"],
        [/\bkeeper\b/, "internal component name — say 'fills automatically'"],
        [/oracle usd/, "pricing plumbing"],
        [/since indexed/, "indexer plumbing"],
        [/indexed swaps?/, "indexer plumbing"],
        [/min-received/, "quote plumbing — say 'your minimum'"],
        [/\bdecimals\b/, "token metadata plumbing"],
      ];
      for (const [re, why] of words) {
        expect(visible, `Dev jargon ${re} (${why}) visible on ${route.path}`).not.toMatch(re);
      }
    });
  }
});

// ── Design coherence: no native-white form controls (live report 2026-07-11) ──
// Several inputs/selects referenced CSS classes that were never defined (.in,
// .chainsel) and rendered as raw browser controls — white boxes strapped onto a
// dark surface. The design system now defines one control language; this guard
// computes every visible input/select's background and fails on anything light,
// so an unstyled control can never ship again.
test.describe("Per-route form-control coherence", () => {
  for (const route of ROUTES) {
    test(`${route.name} (${route.path}) → every input/select is dark (no native controls)`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      const offenders = await page.evaluate(() => {
        const bad: string[] = [];
        for (const el of Array.from(document.querySelectorAll("input, select"))) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue; // hidden
          const bg = getComputedStyle(el).backgroundColor;
          const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
          if (!m) continue;
          const [r0, g0, b0] = [Number(m[1]), Number(m[2]), Number(m[3])];
          const alpha = m[4] === undefined ? 1 : Number(m[4]);
          if (alpha === 0) continue; // transparent — the container draws the box
          if (r0 + g0 + b0 > 420) {
            bad.push(`${el.tagName.toLowerCase()}[data-testid=${el.getAttribute("data-testid") ?? "?"}] bg=${bg} class=${el.className}`);
          }
        }
        return bad;
      });
      expect(offenders, `light/native controls on ${route.path}:\n${offenders.join("\n")}`).toHaveLength(0);
    });
  }
});

// The CLMM provide panel (the reported screenshot) renders its inputs only
// with a wallet connected — cover that state too.
test("wallet-connected /clmm → price/deposit/track inputs are dark", async ({ page }) => {
  await page.addInitScript(() => {
    const provider = {
      isPhantom: true,
      publicKey: null,
      connect: async (opts?: { onlyIfTrusted?: boolean }) => ({ publicKey: { toString: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" } }),
      disconnect: async () => {},
      signTransaction: async (tx: unknown) => tx,
    };
    (window as unknown as Record<string, unknown>).phantom = { solana: provider };
    (window as unknown as Record<string, unknown>).solana = provider;
  });
  await page.goto("/clmm");
  await page.getByTestId("wallet-pill-solana").click();
  await page.getByTestId("clmm-track-toggle").click(); // reveal the track inputs too
  const offenders = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll("input, select"))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!m) continue;
      if ((m[4] === undefined ? 1 : Number(m[4])) === 0) continue;
      if (Number(m[1]) + Number(m[2]) + Number(m[3]) > 420) bad.push(`${el.getAttribute("data-testid")}`);
    }
    return bad;
  });
  expect(offenders, `light controls: ${offenders.join(", ")}`).toHaveLength(0);
});
