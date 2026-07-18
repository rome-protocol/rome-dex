/**
 * helpers.ts — shared test utilities for the rome-dex e2e suite.
 */
import { type Page } from "@playwright/test";

export const ROUTES = [
  { path: "/", name: "Swap" },
  { path: "/pools", name: "Pools" },
  { path: "/pools/30", name: "Pool detail (0.30%)" },
  { path: "/clmm", name: "CLMM" },
  { path: "/positions", name: "Positions" },
  { path: "/farms", name: "Farms" },
  { path: "/analytics", name: "Analytics" },
] as const;

export const PAGE_TITLE = "rome-dex — one pool, two wallets";

// App origin under test (host:port) — kept in sync with playwright baseURL so
// the console-error filter can tell OUR errors from external CDN noise.
const APP_ORIGIN = (process.env.E2E_BASE_URL ?? "http://localhost:3200").replace(/^https?:\/\//, "");

/**
 * Attach a console/exception guard to a page and return an accessor for the
 * collected *application* errors.
 *
 * Strict on uncaught JS exceptions (pageerror) — those are always real bugs.
 * Filters out environmental resource-load noise that is not an app defect:
 *   • the dev-server favicon 404 (no icon asset is shipped)
 *   • external CDN failures (Google Fonts) — anything not served by our origin
 * App-origin failures (e.g. a 500 from /api/*) are NOT filtered, so a broken
 * route or API still fails the test.
 */
export function collectErrors(page: Page): () => string[] {
  const errors: string[] = [];
  const isEnvNoise = (text: string, url: string): boolean => {
    if (url.includes("favicon")) return true;
    // Font decode / preload warnings occasionally surface as errors.
    if (/fonts\.(googleapis|gstatic)/.test(text)) return true;
    // Only a REAL external network origin (http/https not our server) is noise
    // — e.g. a CDN font. Do NOT filter `webpack-internal://` or empty-url
    // errors: those are OUR bundled code (React warnings like "Maximum update
    // depth", app throws), which a "no console errors" guard MUST catch.
    // (This filter previously masked all bundled React errors — a real gap.)
    if (/^https?:\/\//.test(url) && !url.includes(APP_ORIGIN)) return true;
    return false;
  };

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const url = msg.location()?.url ?? "";
    if (isEnvNoise(msg.text(), url)) return;
    errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

  return () => errors;
}
