const { test, expect } = require("@playwright/test");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

// Inject the demo seed before any scripts run so the memory index has data.
const DEMO_SEED_SCRIPT = () => {
  const now = Date.now();
  const ts = (deltaMs) => now + deltaMs;
  window.SHOGUN_DEMO_SEED = {
    memoryHits: [
      { id: "demo-m-01", title: "Q2 roadmap", snippet: "Beta target.",
        source: "meetings", kinds: ["audio"], created_at: ts(-45 * 60 * 1000) },
      { id: "demo-m-02", title: "Investor update deck",
        snippet: "Three slides.", source: "meetings", kinds: ["audio"],
        created_at: ts(-3 * 60 * 60 * 1000) },
    ],
    entities: [], stats: {}, chats: [], chatThreads: {}, chatMemoryContext: {},
  };
};

async function openHiFi(page) {
  await page.addInitScript(DEMO_SEED_SCRIPT);
  await page.goto(HIFI_ENTRY + '?test=1', { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}

async function goToMemoryRiver(page) {
  await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('memory'));
  await expect(page.locator('.memory-screen')).toBeVisible();
  await page.locator('button', { hasText: 'River' }).first().click().catch(() => {});
}

async function seedSummariesForDemo(page) {
  // Demo seed has demo-m-01..12. Mark 04/08/10 as LOW so the cluster appears.
  await page.evaluate(() => {
    if (!window.__SHOGUN_TEST__?.seedSummaries) {
      throw new Error('window.__SHOGUN_TEST__.seedSummaries not available — Memory screen not mounted, or ?test=1 missing');
    }
    const isLow = (id) => ['demo-m-04', 'demo-m-08', 'demo-m-10'].includes(id);
    const map = {};
    for (let i = 1; i <= 12; i++) {
      const id = `demo-m-${String(i).padStart(2, '0')}`;
      map[id] = {
        targetKind: 'item',
        targetId: id,
        title: `Stub: ${id}`,
        keyPoints: ['mock'],
        sourceType: 'mail',
        priority: isLow(id) ? 'low' : 'medium',
        reason: 'mock',
        model: 'mock',
        schemaVersion: 1,
        generatedAt: 0,
      };
    }
    window.__SHOGUN_TEST__.seedSummaries(map);
  });
}

test.describe('Memory summary inline edit', () => {
  test('title click → edit → Enter saves; reload preserves', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await seedSummariesForDemo(page);

    const titleEl = page.getByRole('button', { name: 'Edit title' }).first();
    await titleEl.click();
    const input = page.getByLabel('Edit title');
    await input.fill('User edited title');
    await input.press('Enter');

    // After save, the display element shows the new value plus the
    // "edited · revert" affordance.
    await expect(page.getByRole('button', { name: 'Edit title' }).first())
      .toContainText('User edited title');
    await expect(page.locator('text=edited · revert').first()).toBeVisible();

    // Navigate away and back; the merged value should still be returned by
    // the mock (in-memory map persists for the page lifetime).
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('home'));
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('memory'));
    // After navigating back, the mock's stored edits are returned by
    // memory.summary.get — wait for the summary card to appear naturally
    // (no re-seed needed; re-seeding would overwrite the edited title).
    await page.locator('.memory-summary-card').first().waitFor({ state: 'visible', timeout: 30000 });
    await expect(page.getByRole('button', { name: 'Edit title' }).first())
      .toContainText('User edited title');
  });

  test('Escape during edit discards changes', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await seedSummariesForDemo(page);

    const before = await page.getByRole('button', { name: 'Edit title' }).first().textContent();
    await page.getByRole('button', { name: 'Edit title' }).first().click();
    const input = page.getByLabel('Edit title');
    await input.fill('Should not be saved');
    await input.press('Escape');

    // Display reverts to the original; no "edited" affordance appears.
    await expect(page.getByRole('button', { name: 'Edit title' }).first())
      .toHaveText(String(before).trim());
    await expect(page.locator('text=edited · revert').first()).toHaveCount(0);
  });

  test('Revert restores AI baseline', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await seedSummariesForDemo(page);

    // Edit
    await page.getByRole('button', { name: 'Edit title' }).first().click();
    await page.getByLabel('Edit title').fill('Edited then reverted');
    await page.getByLabel('Edit title').press('Enter');
    await expect(page.locator('text=edited · revert').first()).toBeVisible();

    // Revert
    await page.locator('text=edited · revert').first().click();

    // Affordance is gone; title no longer contains the user value.
    await expect(page.locator('text=edited · revert').first()).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit title' }).first())
      .not.toContainText('Edited then reverted');
  });

  test('keyPoints click → edit; + Add point appends new editable item', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await seedSummariesForDemo(page);

    const firstKp = page.getByRole('button', { name: /^Edit key point 1$/ }).first();
    await firstKp.click();
    const input = page.getByLabel(/^Edit key point 1$/);
    await input.fill('User-edited point');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: /^Edit key point 1$/ }).first())
      .toContainText('User-edited point');

    // Add a new point.
    await page.getByRole('button', { name: '+ Add point' }).click();
    const newInput = page.getByLabel(/^Edit key point \d+$/).last();
    await newInput.fill('Brand new point');
    await newInput.press('Enter');
    await expect(page.locator('li', { hasText: 'Brand new point' })).toBeVisible();
  });

  test('reason click → edit → save', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await seedSummariesForDemo(page);

    const reason = page.getByRole('button', { name: 'Edit reason' }).first();
    await reason.click();
    const input = page.getByLabel('Edit reason');
    await input.fill('Manual reason override');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: 'Edit reason' }).first())
      .toContainText('Manual reason override');
  });
});
