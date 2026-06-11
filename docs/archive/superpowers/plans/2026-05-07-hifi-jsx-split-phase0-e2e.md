# Hi-Fi UI JSX 分割 — Phase 0（e2e 拡充）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1（Vite + ESM 化）に着手する前に、現状の Hi-Fi UI に対する Playwright e2e カバレッジを 4 本追加し、Vite 化の前後で機能を比較できる安全網を完成させる。加えて Tauri 実機ビルドのベースラインスクリーンショットを取得する。

**Architecture:** 既存 `tests/e2e/hifi-smoke.spec.js` と `_helpers/preseed-consent.js` のパターンをそのまま踏襲し、4 本の新 spec ファイルを追加する。各 spec は (1) `preacceptConsent` で consent gate を抜け、(2) `/SHOGUN%20Hi-Fi%20UI.html` をロード、(3) DOM クエリと `executeAction` 経由のモック IPC で挙動を確認する。論理コードは1行も変更しない。

**Tech Stack:** Playwright 1.49、Python `http.server`（既存 webServer のまま）、モック IPC（`hifi/lib/ipc-client.js` の `mockTransport`）。

**スペック:** [docs/superpowers/specs/2026-05-07-hifi-jsx-split-design.md](../specs/2026-05-07-hifi-jsx-split-design.md) §7.2

**現状の e2e カバレッジと本計画の対象:**

| 画面 | 既存 spec の有無 | 本計画で追加 |
|---|---|---|
| Home / Morning Brief | なし | **Task 1** |
| Memory（タイムライン） | smoke で1件 | (本計画では追加しない) |
| Memory Debug | なし | **Task 2** |
| Chat | smoke で複数 | (本計画では追加しない) |
| Agents | smoke で1件 | (本計画では追加しない) |
| Work | smoke で1件 | (本計画では追加しない) |
| Meetings | なし | **Task 3** |
| Settings 全タブ | smoke で 4 タブ程度 | **Task 4**（16 タブ全て） |

**スペックからの逸脱（madge 導入を Phase 1 へ繰り延べ）:** スペック §8 Phase 0 では `madge --circular` の CI ジョブ追加もスコープに含めていたが、現コードは `<script type="text/babel">` でロードされグローバル名前空間で結合しているため**静的 import が皆無**で、madge の解析対象がない。Phase 0 で導入しても "no cycles found" を返す自明なベースラインにしかならず、運用上の意味が無いため、madge は Phase 1（ESM 化と同時）で導入する。スペック側の §8 Phase 0 から madge 行を削除する PR を別途出す（本計画の Task 0 にて）。

---

## Task 0: スペックを実情に合わせて微修正

**Files:**
- Modify: `docs/superpowers/specs/2026-05-07-hifi-jsx-split-design.md`（§8 Phase 0、§6.4 CI ジョブ）

- [ ] **Step 1: spec から madge の Phase 0 投入を削除**

Edit `docs/superpowers/specs/2026-05-07-hifi-jsx-split-design.md`:

`### Phase 0 — 安全網の構築（1 PR、1〜2日）` セクションの

```
2. CI に `madge --circular` ジョブ追加（現状で循環ゼロを基準化）。
```

を以下に置換：

```
2. （madge ジョブは Phase 1 で導入。Phase 0 時点では静的 import がゼロのため意味のあるベースラインにならない。）
```

- [ ] **Step 2: コミット**

```bash
git add docs/superpowers/specs/2026-05-07-hifi-jsx-split-design.md
git commit -m "docs(spec): defer madge baseline from Phase 0 to Phase 1 (no static imports yet)"
```

---

## Task 1: Home + Morning Brief の smoke spec を追加

**Files:**
- Create: `tests/e2e/home-morning-brief.spec.js`

**選択子の根拠（実コード確認済）:**
- `hifi/screens-a.jsx:368` の `function ScreenHome()` がルート。
- `hifi/screens-a.jsx:887-898` で `<h1 className="en-only">{headLine.greetEn}, {greetFirstName || 'there'}.</h1>` が常に描画される（greeting 行）。
- `hifi/screens-a.jsx:1275` で `{morningBrief && (...)}` の条件描画。モック IPC の `shogun_brief_get` は `hifi/lib/ipc-client.js:280` で `global.ShogunMorningBrief` 経由。空ブリーフが返ることがあるため、Brief カードは「あれば検証、無ければスキップ」とする（フレークを避けるため厳しく出さない）。
- ホームへの遷移はサイドバーから：`.sidebar .nav-item` filter `Home`（`hifi-smoke.spec.js` の Memory/Work/Agents タブ遷移と同パターン）。

- [ ] **Step 1: spec ファイルを新規作成**

```javascript
// tests/e2e/home-morning-brief.spec.js
const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

async function openHiFi(page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
    try {
      await page.waitForSelector(".app", { timeout: 20000 });
      await page.waitForFunction(() => !!window.SHOGUN_RUNTIME, null, { timeout: 20000 });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
      await page.waitForTimeout(500);
    }
  }
}

test.describe("Home + Morning Brief", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("Home greeting renders without page errors", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);

    // Home is the default landing screen. The English greeting h1 always renders.
    await expect(page.locator(".app h1.en-only").first()).toContainText(
      /,\s*(\w|there)\./,
      { timeout: 10000 },
    );

    expect(
      consoleErrors,
      `No uncaught page errors (got: ${consoleErrors.join("; ")})`,
    ).toEqual([]);
  });

  test("Sidebar Home nav-item is highlighted on initial load", async ({ page }) => {
    await openHiFi(page);
    const homeItem = page.locator(".sidebar .nav-item").filter({ hasText: "Home" }).first();
    await expect(homeItem).toBeVisible();
    // The active nav-item carries an "active" or aria-selected marker in app.jsx;
    // accept either class containing "active" or aria-current.
    await expect(homeItem).toHaveClass(/active|is-active|nav-item--active/);
  });

  test("brief.get IPC resolves (mock transport)", async ({ page }) => {
    await openHiFi(page);
    const out = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "brief.get",
        {},
        { silentError: true },
      );
    });
    // Mock returns either { ok:true, data:{ brief: {...} | null } } or
    // { ok:true, data: null }. Accept both — Phase 0 only checks the
    // call path is wired, not content.
    expect(out.ok).toBe(true);
  });

  test("Navigating to Memory and back to Home keeps app stable", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await page.locator(".sidebar .nav-item").filter({ hasText: "Memory" }).first().click();
    await expect(page.getByText(/Memory \/ Timeline/i)).toBeVisible();
    await page.locator(".sidebar .nav-item").filter({ hasText: "Home" }).first().click();
    await expect(page.locator(".app h1.en-only").first()).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});
```

- [ ] **Step 2: spec を実行して green になることを確認**

Run: `npx playwright test tests/e2e/home-morning-brief.spec.js --reporter=list`
Expected: 4 tests passed.

セレクタが噛み合わない場合の調整指針：
- `nav-item--active` クラス名がプロジェクト固有の場合は、`hifi/app.jsx` で `nav-item` をレンダリングしている箇所を `grep -n 'nav-item' hifi/app.jsx` で確認し、active 表現に合わせて regex を変更する。
- `Memory / Timeline` 文字列が違っていれば、`grep -n 'Timeline' hifi/screens-a.jsx` で実テキストを確認して合わせる（既存 smoke が同じ文字列を使っているので変わっていない想定）。

- [ ] **Step 3: コミット**

```bash
git add tests/e2e/home-morning-brief.spec.js
git commit -m "test(e2e): add Home + Morning Brief smoke coverage (Phase 0)"
```

---

## Task 2: Memory Debug の smoke spec を追加

**Files:**
- Create: `tests/e2e/memory-debug.spec.js`

**選択子の根拠:**
- `hifi/screens-memory-debug.jsx:612` で `<h1>Memory Debugger (dev)</h1>`。
- サイドバーには本来 Memory Debug の固定 nav-item は無い（`hifi/app.jsx` の `NAV` 配列に未掲載）。実装上は `setActive('memorydebug')` などで遷移している可能性が高いので、URL ハッシュやキーボードショートカット、または開発者ボタン経由で遷移する必要がある。**最初は `window` 経由で setActive を直接呼ぶ**方針で書き、起動できなければ `screens-memory-debug.jsx` 上部を見て遷移手段を特定する。

- [ ] **Step 1: 遷移手段を確認**

Run:
```bash
grep -n "memorydebug\|memory-debug\|Memory Debug" hifi/app.jsx | head -10
```
Expected: `setActive('memorydebug')` ないし類似の遷移トリガを発見する。発見できない場合は実装側で開発者用エントリ（`window.__shogunGotoMemoryDebug = () => setActive('memorydebug')` など）を追加する案を Step 2 でメモする。

- [ ] **Step 2: spec を新規作成**

```javascript
// tests/e2e/memory-debug.spec.js
const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 20000 });
  await page.waitForFunction(() => !!window.SHOGUN_RUNTIME, null, { timeout: 20000 });
}

/**
 * Memory Debug screen is a dev-only view not exposed in NAV.
 * The runtime exposes a programmatic switch via window.__SHOGUN_GOTO__('memorydebug')
 * if available; fall back to clicking a hidden nav-item if it surfaces in dev builds.
 * Update this helper if the goto mechanism changes.
 */
async function openMemoryDebug(page) {
  // Try programmatic navigation first.
  const switched = await page.evaluate(() => {
    if (typeof window.__SHOGUN_GOTO__ === "function") {
      window.__SHOGUN_GOTO__("memorydebug");
      return true;
    }
    return false;
  });
  if (!switched) {
    // Fallback: find nav-item if dev mode surfaces it
    const candidate = page.locator(".sidebar .nav-item").filter({
      hasText: /Memory Debug|Debugger/i,
    });
    if ((await candidate.count()) > 0) {
      await candidate.first().click();
      return;
    }
    throw new Error(
      "Memory Debug screen is not reachable. Add window.__SHOGUN_GOTO__ in app.jsx or expose a dev nav-item.",
    );
  }
}

test.describe("Memory Debug", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("Memory Debug screen mounts with header", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await openMemoryDebug(page);

    await expect(page.getByRole("heading", { name: /Memory Debugger/i })).toBeVisible({
      timeout: 10000,
    });

    expect(consoleErrors).toEqual([]);
  });

  test("Memory Debug exposes telemetry / SLI sections (best-effort)", async ({ page }) => {
    await openHiFi(page);
    await openMemoryDebug(page);

    // The screen renders multiple sections. We only assert that at least
    // one developer-facing label is present, to avoid coupling to layout.
    const body = page.locator(".app");
    await expect(body).toContainText(/SLI|telemetry|stats/i);
  });
});
```

- [ ] **Step 3: 必要なら `app.jsx` に dev hook を追加**

Step 1 で `__SHOGUN_GOTO__` 相当の遷移手段が無いと判明した場合のみ、`hifi/app.jsx` の `setActive` 定義直後に以下を追加：

```javascript
if (typeof window !== 'undefined') {
  window.__SHOGUN_GOTO__ = (key) => setActive(String(key));
}
```

ただし**この差分は本当に必要な時のみ**入れる（Phase 1 でも残せる小変更だが、論理変更ゼロ原則の例外なので明示的にレビューする）。

- [ ] **Step 4: spec を実行**

Run: `npx playwright test tests/e2e/memory-debug.spec.js --reporter=list`
Expected: 2 tests passed.

- [ ] **Step 5: コミット**

```bash
git add tests/e2e/memory-debug.spec.js hifi/app.jsx
git commit -m "test(e2e): add Memory Debug screen smoke coverage (Phase 0)"
```

`hifi/app.jsx` を変更しなかった場合は spec ファイルのみ add する。

---

## Task 3: Meetings の smoke spec を追加

**Files:**
- Create: `tests/e2e/meetings-list.spec.js`

**選択子の根拠（実コード確認済）:**
- `hifi/screens-meetings.jsx:1024-1025` で `<h1>Meetings <span className="jp">会議</span></h1>`。
- `hifi/screens-meetings.jsx:1037-1038` の "Connect a calendar to see upcoming meetings here." 空状態文言。
- `hifi/screens-meetings.jsx:966-968` のルート要素 `.screen-meetings-root` `.screen-meetings-scroll`。
- サイドバー：`.sidebar .nav-item` filter `Meetings`（既存 NAV に登録済 — `hifi/app.jsx:14` で確認可能）。

- [ ] **Step 1: spec ファイルを新規作成**

```javascript
// tests/e2e/meetings-list.spec.js
const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 20000 });
  await page.waitForFunction(() => !!window.SHOGUN_RUNTIME, null, { timeout: 20000 });
}

async function gotoMeetings(page) {
  await page.locator(".sidebar .nav-item").filter({ hasText: "Meetings" }).first().click();
  await expect(page.locator(".screen-meetings-root")).toBeVisible({ timeout: 10000 });
}

test.describe("Meetings screen", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("Meetings tab mounts with header and empty-state hint", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoMeetings(page);

    await expect(page.locator(".screen-meetings-inner h1").first()).toContainText("Meetings");
    await expect(page.locator(".screen-meetings-inner h1 .jp").first()).toContainText("会議");

    // Empty state copy when no calendar is connected.
    await expect(page.locator(".screen-meetings-inner")).toContainText(
      /Connect a calendar to see upcoming meetings/i,
    );

    expect(consoleErrors).toEqual([]);
  });

  test("Meetings tab shows the chat dock", async ({ page }) => {
    await openHiFi(page);
    await gotoMeetings(page);
    await expect(page.locator(".screen-meetings-chatdock")).toBeVisible();
    await expect(page.locator(".screen-meetings-chatdock-inner")).toBeVisible();
  });

  test("Slash menu opens when prompt starts with '/'", async ({ page }) => {
    await openHiFi(page);
    await gotoMeetings(page);

    const dock = page.locator(".screen-meetings-chatdock");
    const input = dock.getByRole("textbox").first();
    await input.fill("/");
    // The slash catalog (RECIPE_LOCAL_BODIES + recipes) renders option labels.
    // We assert one well-known recipe label appears.
    await expect(dock).toContainText(/Write weekly recap/i, { timeout: 5000 });
  });

  test("Switching away from Meetings does not throw", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoMeetings(page);
    await page.locator(".sidebar .nav-item").filter({ hasText: "Home" }).first().click();
    await expect(page.locator(".app h1.en-only").first()).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});
```

- [ ] **Step 2: spec を実行**

Run: `npx playwright test tests/e2e/meetings-list.spec.js --reporter=list`
Expected: 4 tests passed.

`Slash menu opens when prompt starts with '/'` のセレクタが噛み合わない場合：
- `hifi/screens-meetings.jsx` で input 要素のレンダリング箇所を `grep -n "input\|textarea" hifi/screens-meetings.jsx | head` で特定
- `getByRole("textbox")` の代わりに class セレクタ（例えば `.screen-meetings-chatdock textarea` など）に変更

- [ ] **Step 3: コミット**

```bash
git add tests/e2e/meetings-list.spec.js
git commit -m "test(e2e): add Meetings screen smoke coverage (Phase 0)"
```

---

## Task 4: Settings 全タブの sweep spec を追加

**Files:**
- Create: `tests/e2e/settings-all-tabs.spec.js`

**選択子の根拠（実コード確認済）:**
- `hifi/settings-modal.jsx:5-20` で 16 タブの定義。各 `label` を `s-sidebar` 内のリンクテキストとしてクリックする。
- 既存 smoke の `openSettingsModal` ヘルパーと `.s-sidebar` / `.s-pane-head` の組み合わせを再利用。

- [ ] **Step 1: spec ファイルを新規作成**

```javascript
// tests/e2e/settings-all-tabs.spec.js
const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

// Source of truth: hifi/settings-modal.jsx:5-20 (TABS array).
// If you add/remove a tab there, update this list and the test will fail
// loud, which is exactly what we want for Phase 0 coverage.
const SETTINGS_TABS = [
  "General",
  "System",
  "Appearance",
  "Privacy Controls",
  "Data Controls",
  "Hummingbird",
  "Meetings",
  "Chat",
  "Model & API",
  "KIOKU Graph",
  "KIOKU Patterns",
  "KIOKU Lessons",
  "Integrations",
  "Keyboard Shortcuts",
  "Team",
  "Support",
];

async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 20000 });
  await page.waitForFunction(() => !!window.SHOGUN_RUNTIME, null, { timeout: 20000 });
}

async function openSettingsModal(page) {
  await page.locator(".user-pill").click();
  await page.locator(".user-float").getByText("Settings", { exact: true }).click();
  await expect(page.locator(".s-modal")).toBeVisible();
}

test.describe("Settings: every tab opens without errors", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  for (const label of SETTINGS_TABS) {
    test(`opens "${label}" tab and shows pane head`, async ({ page }) => {
      const consoleErrors = [];
      page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

      await openHiFi(page);
      await openSettingsModal(page);

      await page.locator(".s-sidebar").getByText(label, { exact: true }).click();
      // The pane head text contains the tab label (allowing for additional copy
      // such as " — beta" etc. — match by inclusion, not equality).
      await expect(page.locator(".s-pane-head")).toContainText(label, { timeout: 10000 });

      // Closing the modal must always work.
      await page.locator(".s-close").click();
      await expect(page.locator(".s-modal")).toHaveCount(0);

      expect(
        consoleErrors,
        `No uncaught page errors on "${label}" (got: ${consoleErrors.join("; ")})`,
      ).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: spec を実行**

Run: `npx playwright test tests/e2e/settings-all-tabs.spec.js --reporter=list`
Expected: 16 tests passed.

タブ名が変わって落ちる場合：
- `hifi/settings-modal.jsx:5-20` を再確認
- `SETTINGS_TABS` 配列を実 label に揃える
- pane head のテキストが `label` を含まないタブが見つかったらそれは**実装の不整合**。spec は落としたままにし、別 PR で修正する（このゲートが効いた最初のケースになる）

- [ ] **Step 3: コミット**

```bash
git add tests/e2e/settings-all-tabs.spec.js
git commit -m "test(e2e): sweep all 16 Settings tabs (Phase 0)"
```

---

## Task 5: 全 e2e スイートを通して Phase 0 完了の確認

**Files:**
- なし（実行のみ）

- [ ] **Step 1: 全スイート実行**

Run: `npx playwright test --reporter=list`
Expected: 既存 spec + 新規 4 spec が全て green。所要時間目安 3〜5 分。

- [ ] **Step 2: 失敗があれば修正してから次へ**

新 spec が落ちる場合：
- セレクタの不整合 → `grep -n` で実コード上のクラス／テキストを再確認、spec を直す
- 既存 spec が落ちる場合 → 新 spec が共有状態を汚しているか、`preacceptConsent` の前提を破っているか確認。問題のある spec の `test.beforeEach` を見直す

- [ ] **Step 3: 修正コミット**（必要時）

```bash
git add tests/e2e/
git commit -m "test(e2e): adjust selectors to keep Phase 0 suite green"
```

---

## Task 6: Tauri 実機ビルドのベースラインスクリーンショットを取得

**Files:**
- Create: `docs/screenshots/baseline-pre-vite/{home,memory,memory-debug,chat,agents,work,meetings,settings-general,settings-appearance,settings-model-api}.png`

**目的:** Phase 1 マージ後に Tauri 実機の見た目が変わっていないことを目視で確認するための参照点。Vite 切替で**何かが変われば必ずここで気付ける**。

- [ ] **Step 1: 未署名で Tauri ビルドを作成**

Run:
```bash
npm ci
npm run build:web-dist
npm run build:desktop
```
Expected: `src-tauri/target/release/bundle/macos/SHOGUN AI.app` が生成される。

エラーが出る場合：
- `src-tauri/tauri.signing.local.json` が無くてもビルドは通るはず（`build:desktop:signed` ではなく `build:desktop` を使う）
- Rust 依存の取得に時間がかかる場合は `cargo build` を別途事前に走らせて様子を見る

- [ ] **Step 2: アプリを起動し、各画面のスクリーンショットを撮る**

```bash
open "src-tauri/target/release/bundle/macos/SHOGUN AI.app"
```

各画面で macOS の `Cmd+Shift+4` → `Space` → ウィンドウクリックでウィンドウ単位のスクショを取得（影付き）。Cmd+Shift+5 のオプションで影なしも可。

撮影対象（最低限）：
- Home（起動直後）
- Memory（タイムライン）
- Chat
- Agents
- Work
- Meetings
- Settings: General
- Settings: Appearance
- Settings: Model & API
- Memory Debug（Task 2 で `__SHOGUN_GOTO__` を入れた場合は DevTools の Console で `window.__SHOGUN_GOTO__('memorydebug')` を実行）

- [ ] **Step 3: スクリーンショットを `docs/screenshots/baseline-pre-vite/` に配置**

```bash
mkdir -p docs/screenshots/baseline-pre-vite
mv ~/Desktop/{Screenshot*,スクリーンショット*}.png docs/screenshots/baseline-pre-vite/
```

ファイル名を以下に手動でリネーム：
- `home.png`
- `memory.png`
- `chat.png`
- `agents.png`
- `work.png`
- `meetings.png`
- `settings-general.png`
- `settings-appearance.png`
- `settings-model-api.png`
- `memory-debug.png`（Task 2 で取れていれば）

- [ ] **Step 4: コミット**

```bash
git add docs/screenshots/baseline-pre-vite/
git commit -m "docs: capture Tauri pre-Vite baseline screenshots (Phase 0)"
```

PNG が大きい場合は事前に `pngquant` などで圧縮することを検討（リポジトリサイズに影響する）。1 枚 500KB 以下が目安。

---

## Task 7: PR を作成して Phase 0 を締める

**Files:**
- なし（PR 作成のみ）

- [ ] **Step 1: ブランチを push**

Run:
```bash
git push -u origin docs/hifi-jsx-split-design
```

(本来は別ブランチ名がベター。Phase 0 用に `feat/hifi-phase0-e2e` 等に rebase してから push してもよい。設計書コミットと e2e 追加コミットが同居していて良ければそのまま。)

- [ ] **Step 2: PR を作成**

Run:
```bash
gh pr create --title "Hi-Fi JSX 分割 Phase 0: e2e 拡充 + Vite 化前ベースライン" --body "$(cat <<'EOF'
## Summary
- スペック追加: docs/superpowers/specs/2026-05-07-hifi-jsx-split-design.md
- e2e spec 4 本追加: home-morning-brief / memory-debug / meetings-list / settings-all-tabs
- Tauri 実機の Vite 化前ベースラインスクショを docs/screenshots/baseline-pre-vite/ に保存

Phase 1（Vite 化）に向けた安全網の整備。論理コードに変更なし（dev hook 1 行のみ可能性あり）。

## Test plan
- [ ] `npx playwright test --reporter=list` が全 spec green
- [ ] `npm run build:desktop` で .app が生成されること
- [ ] 起動した .app の見た目が baseline-pre-vite のスクショと一致すること

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: PR URL をユーザに共有**

Step 2 の出力に PR URL が含まれる。レビュー依頼を投げる。

---

## Phase 0 完了の定義（DoD）

- 4 本の新 spec ファイル（home-morning-brief, memory-debug, meetings-list, settings-all-tabs）が `tests/e2e/` に存在し、全て green。
- 既存 e2e スイートも green を維持。
- `docs/screenshots/baseline-pre-vite/` に最低 7 枚（Home / Memory / Chat / Agents / Work / Meetings / Settings-General）のスクショがある。
- 設計書 `2026-05-07-hifi-jsx-split-design.md` が main にマージ済み、または同 PR に同梱。
- 論理コード変更は **dev hook 1 行（`window.__SHOGUN_GOTO__`）以下**に抑える。それ以上の修正が必要な場合は別 PR に分割し、本計画の対象外とする。

完了したら次は Phase 1（Vite + ESM 化）の計画作成へ進む。
