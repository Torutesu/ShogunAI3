const { test, expect } = require("@playwright/test");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

/**
 * The HTML does not load demo-seed.js, so SHOGUN_DEMO_SEED is undefined and
 * the mock memory index starts empty. Inject it as an init script so the IPC
 * client's readMemoryIndex() falls back to these hits.
 *
 * Priority mapping (mockPriorityForId, charCode of last char mod 4):
 *   LOW  (% 4 === 0): demo-m-04 ('4'→52%4=0), demo-m-08 ('8'→56%4=0), demo-m-10 ('0'→48%4=0)
 *   HIGH (% 4 === 1): demo-m-01, demo-m-05, demo-m-09, demo-m-11
 *   MED  (% 4 === 2 or 3): demo-m-02, demo-m-03, demo-m-06, demo-m-07, demo-m-12
 * Gives 3 LOW items → the cluster row renders.
 */
const DEMO_SEED_SCRIPT = () => {
  const now = Date.now();
  const ts = (deltaMs) => now + deltaMs;
  window.SHOGUN_DEMO_SEED = {
    memoryHits: [
      { id: "demo-m-01", title: "Q2 roadmap — Aurora beta", snippet: "Beta week target mid-June.", source: "chat", kinds: ["input"], created_at: ts(-45 * 60 * 1000) },
      { id: "demo-m-02", title: "Investor update deck", snippet: "Three slides on adoption.", source: "meetings", kinds: ["audio"], created_at: ts(-3 * 60 * 60 * 1000) },
      { id: "demo-m-03", title: "Aurora data classification labels", snippet: "PII tags required.", source: "work", kinds: ["input"], created_at: ts(-5 * 60 * 60 * 1000) },
      { id: "demo-m-04", title: "Slack #aurora-launch checklist", snippet: "Three P1 items left.", source: "chat", kinds: ["input"], created_at: ts(-20 * 60 * 60 * 1000) },
      { id: "demo-m-05", title: "Customer interview — Nodebank", snippet: "Pain: CSV reconciliation.", source: "note", kinds: ["input"], created_at: ts(-26 * 60 * 60 * 1000) },
      { id: "demo-m-06", title: "LP copy ja / en", snippet: "Headline options.", source: "work", kinds: ["input"], created_at: ts(-30 * 60 * 60 * 1000) },
      { id: "demo-m-07", title: "1:1 Mio Sato x Kenta Yamada", snippet: "Hiring pipeline.", source: "meetings", kinds: ["audio"], created_at: ts(-40 * 60 * 60 * 1000) },
      { id: "demo-m-08", title: "Security review — SDK list", snippet: "Analytics SDK off.", source: "note", kinds: ["input"], created_at: ts(-52 * 60 * 60 * 1000) },
      { id: "demo-m-09", title: "Claude project: Aurora spec", snippet: "Ingest only allowed apps.", source: "chat", kinds: ["input"], created_at: ts(-60 * 60 * 60 * 1000) },
      { id: "demo-m-10", title: "Keyboard shortcuts draft", snippet: "Cmd+K Chat, Cmd+, Settings.", source: "note", kinds: ["input"], created_at: ts(-72 * 60 * 60 * 1000) },
      { id: "demo-m-11", title: "All-hands — Kitazawa Tech", snippet: "Aurora beta demo video.", source: "meetings", kinds: ["audio"], created_at: ts(-96 * 60 * 60 * 1000) },
      { id: "demo-m-12", title: "API rate limits — backoff design", snippet: "On 429: exponential backoff.", source: "work", kinds: ["input"], created_at: ts(-120 * 60 * 60 * 1000) },
    ],
    entities: [],
    stats: {},
    chats: [],
    chatThreads: {},
    chatMemoryContext: {},
  };
};

async function openHiFi(page) {
  // Inject the demo seed before any scripts run so readMemoryIndex() has data.
  await page.addInitScript(DEMO_SEED_SCRIPT);
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}

async function goToMemoryRiver(page) {
  // Open the Memory screen via the runtime hook used elsewhere.
  await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('memory'));
  await expect(page.locator('.memory-screen')).toBeVisible();
  // Make sure we're on the River sub-view (default).
  await page.locator('button', { hasText: 'River' }).first().click().catch(() => {});
}

async function advanceToLastEvent(page) {
  // Wait for the Next memory button to appear (events must be loaded first).
  const next = page.locator('[aria-label="Next memory"]');
  await next.waitFor({ state: 'visible', timeout: 30000 });
  // Click until disabled.
  for (let i = 0; i < 200; i++) {
    if (await next.isDisabled()) break;
    await next.click();
  }
}

test.describe('Memory River — Low-priority cluster', () => {
  test('cluster header appears at end of scrubber stream', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await advanceToLastEvent(page);
    // Cluster panel uses a chevron + "Other · N items" / "その他 · N件".
    await expect(page.locator('.memory-summary-card[role="button"]').first()).toBeVisible();
    await expect(page.locator('.memory-summary-card[role="button"]').first())
      .toContainText(/Other · \d+ items|その他 · \d+件/);
  });

  test('cluster header click toggles aria-expanded', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await advanceToLastEvent(page);
    const cluster = page.locator('.memory-summary-card[role="button"]').first();
    await expect(cluster).toHaveAttribute('aria-expanded', 'false');
    await cluster.click();
    await expect(cluster).toHaveAttribute('aria-expanded', 'true');
    await cluster.click();
    await expect(cluster).toHaveAttribute('aria-expanded', 'false');
  });

  test('expanded cluster lets next-arrow step into LOW items with breadcrumb', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await advanceToLastEvent(page);
    const cluster = page.locator('.memory-summary-card[role="button"]').first();
    await cluster.click(); // expand
    // After expansion, advancing once should land on a LOW item with breadcrumb.
    await page.locator('[aria-label="Next memory"]').click();
    await expect(page.locator('text=/Inside Other cluster|その他クラスタ内/').first()).toBeVisible();
  });

  test('Collapse button snaps back to cluster header', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await advanceToLastEvent(page);
    await page.locator('.memory-summary-card[role="button"]').first().click(); // expand
    await page.locator('[aria-label="Next memory"]').click(); // step into LOW
    await page.getByRole('button', { name: /Collapse|畳む/ }).click();
    await expect(page.locator('.memory-summary-card[role="button"]').first())
      .toContainText(/Other ·|その他 ·/);
    await expect(page.locator('.memory-summary-card[role="button"]').first())
      .toHaveAttribute('aria-expanded', 'false');
  });

  test('expand state survives Memory → Home → Memory round trip', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await advanceToLastEvent(page);
    await page.locator('.memory-summary-card[role="button"]').first().click(); // expand
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('home'));
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('memory'));
    // After round trip with expand=true, riverEvents includes LOW items after the
    // cluster, so advanceToLastEvent would overshoot the cluster. Instead, advance
    // until the cluster card appears (it is at a fixed position in the stream).
    const next = page.locator('[aria-label="Next memory"]');
    await next.waitFor({ state: 'visible', timeout: 30000 });
    const cluster = page.locator('.memory-summary-card[role="button"]').first();
    for (let i = 0; i < 200; i++) {
      const visible = await cluster.isVisible().catch(() => false);
      if (visible) break;
      if (await next.isDisabled()) break;
      await next.click();
    }
    // Cluster should still be in expanded state after the round trip.
    await expect(cluster).toBeVisible();
    await expect(cluster).toHaveAttribute('aria-expanded', 'true');
  });
});
