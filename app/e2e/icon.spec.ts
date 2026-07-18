/**
 * icon.spec.ts — the browser tab shows the Rome mark, not the generic globe.
 *
 * app/icon.svg is auto-served by the App Router at /icon.svg and linked from
 * every page's <head>. Guards the brand variant too: the tab bar is light, so
 * the mark must be the purple one (#5E0A60) — the white variant is invisible
 * there and browsers fall back to the globe.
 */
import { test, expect } from "@playwright/test";

const ROME_PURPLE = "#5E0A60";

test.describe("favicon", () => {
  test("/icon.svg serves the purple Rome logomark", async ({ request }) => {
    const res = await request.get("/icon.svg");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/svg+xml");
    const body = await res.text();
    expect(body).toContain(`fill="${ROME_PURPLE}"`);
    expect(body).not.toContain('fill="#FFFFFF"');
    expect(body).not.toContain('fill="white"');
  });

  test("pages link the SVG icon in <head>", async ({ page }) => {
    await page.goto("/");
    const link = page.locator('link[rel="icon"][type="image/svg+xml"]');
    await expect(link).toHaveAttribute("href", /icon\.svg/);
  });
});
