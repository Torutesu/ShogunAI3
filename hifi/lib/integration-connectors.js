/* global window */
/**
 * Integration connector registry + browser mock persistence (aligns with Tauri when available).
 * Brand assets: `hifi/assets/integrations/official/` — vendor marks where permitted.
 * Sources: Google gstatic product icons; GitHub githubassets mark; Wikimedia Commons (Slack, Notion,
 * Figma, Anthropic, Apple, Zapier); Simple Icons shapes for Outlook/Linear/Arc/Raycast/Obsidian when
 * stable Commons URLs were unavailable (follow each vendor’s trademark guidelines in production).
 */
(function initIntegrationConnectors(global) {
  const LS_CONNECTED = "shogun.hifi.mock.integrations.connected.v1";
  const LS_GCAL = "shogun.hifi.mock.integrations.google_calendar.v1";
  const LS_GMAIL = "shogun.hifi.mock.integrations.gmail.v1";

  /** @type {Record<string, string>} slug -> path under `hifi/assets/integrations/` */
  const ICON_BY_SLUG = {
    gmail: "official/gmail.png",
    google_calendar: "official/google_calendar.png",
    google_drive: "official/google_drive.png",
    outlook: "official/outlook.svg",
    slack: "official/slack.svg",
    notion: "official/notion.svg",
    linear: "official/linear.svg",
    github: "official/github.png",
    figma: "official/figma.svg",
    claude: "official/anthropic.svg",
    arc_browser: "official/arc.svg",
    raycast: "official/raycast.svg",
    obsidian: "official/obsidian.svg",
    zapier_mcp: "official/zapier.svg",
    apple_calendar: "official/apple.svg",
    apple_reminders: "official/apple.svg",
  };

  const REGISTERED = new Set(Object.keys(ICON_BY_SLUG));

  /** Cloud OAuth rows: align browser mock with action-map (warn in v1); local / Apple beta stay connectable. */
  const OAUTH_V1_NOT_WIRED = new Set([
    "slack",
    "notion",
    "linear",
    "outlook",
    "google_drive",
    "github",
    "claude",
    "figma",
    "zapier_mcp",
  ]);

  function normalizeProvider(raw) {
    return String(raw || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
  }

  function readConnectedMap() {
    try {
      if (!global.localStorage) return {};
      const raw = global.localStorage.getItem(LS_CONNECTED);
      if (!raw) return {};
      const o = JSON.parse(raw);
      return o && typeof o === "object" ? o : {};
    } catch (_) {
      return {};
    }
  }

  function writeConnectedMap(map) {
    try {
      if (!global.localStorage) return;
      global.localStorage.setItem(LS_CONNECTED, JSON.stringify(map));
    } catch (_) {
      /* ignore */
    }
  }

  function setConnected(slug, on) {
    const s = normalizeProvider(slug);
    if (!REGISTERED.has(s)) return false;
    const m = readConnectedMap();
    m[s] = !!on;
    writeConnectedMap(m);
    dispatchCredEvent();
    return true;
  }

  function getConnected(slug) {
    const m = readConnectedMap();
    return !!m[normalizeProvider(slug)];
  }

  function dispatchCredEvent() {
    try {
      global.dispatchEvent(new Event("shogun-credentials-updated"));
    } catch (_) {
      /* ignore */
    }
  }

  function readGcalMock() {
    try {
      if (!global.localStorage) return { configured: false, tokenRefreshReady: false };
      const raw = global.localStorage.getItem(LS_GCAL);
      if (!raw) return { configured: false, tokenRefreshReady: false };
      const o = JSON.parse(raw);
      if (!o || typeof o !== "object") return { configured: false, tokenRefreshReady: false };
      return {
        configured: !!o.configured,
        tokenRefreshReady: !!o.tokenRefreshReady,
      };
    } catch (_) {
      return { configured: false, tokenRefreshReady: false };
    }
  }

  function readGmailMock() {
    try {
      if (!global.localStorage) return { configured: false, tokenRefreshReady: false };
      const raw = global.localStorage.getItem(LS_GMAIL);
      if (!raw) return { configured: false, tokenRefreshReady: false };
      const o = JSON.parse(raw);
      if (!o || typeof o !== "object") return { configured: false, tokenRefreshReady: false };
      return {
        configured: !!o.configured,
        tokenRefreshReady: !!o.tokenRefreshReady,
      };
    } catch (_) {
      return { configured: false, tokenRefreshReady: false };
    }
  }

  function writeGmailMock(patch) {
    try {
      if (!global.localStorage) return;
      const prev = (() => {
        try {
          const raw = global.localStorage.getItem(LS_GMAIL);
          if (!raw) return {};
          const o = JSON.parse(raw);
          return o && typeof o === "object" ? o : {};
        } catch (_) {
          return {};
        }
      })();
      const next = { ...prev, ...patch };
      global.localStorage.setItem(LS_GMAIL, JSON.stringify(next));
      dispatchCredEvent();
    } catch (_) {
      /* ignore */
    }
  }

  function writeGcalMock(patch) {
    try {
      if (!global.localStorage) return;
      const prev = (() => {
        try {
          const raw = global.localStorage.getItem(LS_GCAL);
          if (!raw) return {};
          const o = JSON.parse(raw);
          return o && typeof o === "object" ? o : {};
        } catch (_) {
          return {};
        }
      })();
      const next = { ...prev, ...patch };
      global.localStorage.setItem(LS_GCAL, JSON.stringify(next));
      dispatchCredEvent();
    } catch (_) {
      /* ignore */
    }
  }

  const DEFAULT_GRID_TOOLS = [
    { slug: "gmail", name: "Gmail", cat: "Mail", jp: "メール", ops: ["read", "draft", "send"], connected: false },
    { slug: "google_calendar", name: "Google Calendar", cat: "Calendar", jp: "予定", ops: ["read", "create"], connected: false },
    { slug: "slack", name: "Slack", cat: "Chat", jp: "会話", ops: ["read", "post"], connected: false },
    { slug: "notion", name: "Notion", cat: "Docs", jp: "文書", ops: ["read", "write"], connected: false },
    { slug: "linear", name: "Linear", cat: "Tasks", jp: "課題", ops: ["read", "create"], connected: false },
    { slug: "github", name: "GitHub", cat: "Code", jp: "コード", ops: ["read", "comment"], connected: false },
    { slug: "arc_browser", name: "Arc Browser", cat: "Web", jp: "閲覧", ops: ["capture"], connected: false },
    { slug: "claude", name: "Claude", cat: "LLM", jp: "対話", ops: ["chat"], connected: false },
    { slug: "figma", name: "Figma", cat: "Design", jp: "意匠", ops: ["read"], connected: false },
    { slug: "raycast", name: "Raycast", cat: "Launcher", jp: "起動", ops: ["trigger"], connected: false },
    { slug: "obsidian", name: "Obsidian", cat: "Notes", jp: "手記", ops: ["read", "write"], connected: false },
    { slug: "zapier_mcp", name: "Zapier MCP", cat: "Bridge", jp: "橋梁", ops: ["any"], connected: false },
  ];

  function hydrateTools(tools) {
    const m = readConnectedMap();
    return tools.map((t) => ({ ...t, connected: !!m[t.slug] }));
  }

  function getIconFile(slug) {
    return ICON_BY_SLUG[normalizeProvider(slug)] || null;
  }

  const notImpl = (message, echo) => ({
    notImplemented: true,
    message,
    stub: false,
    echo: echo || {},
  });

  /**
   * Shared mock handlers for `ipc-client.js` and `app.jsx` mockIpcInvoke.
   * @returns {object|null} data payload, or null if not an integration command
   */
  function mockIntegrationPayload(command, echo) {
    const e = echo || {};
    switch (command) {
      case "app_integration_connect": {
        const slug = normalizeProvider(e.provider);
        if (slug === "gmail") {
          const g = readGmailMock();
          if (g.configured) {
            setConnected(slug, true);
            return {
              connected: true,
              provider: slug,
              stub: false,
              echo: e,
            };
          }
          return {
            connected: false,
            needsCredentials: true,
            provider: slug,
            message:
              "Import Gmail OAuth tokens via integrations.import_credentials (provider: gmail). Browser mock: paste tokens in Integrations dev tools.",
            stub: false,
            echo: e,
          };
        }
        if (slug === "new_tool" || !REGISTERED.has(slug)) {
          return notImpl(
            slug === "new_tool"
              ? "Custom connectors are not available in the browser mock. Pick a listed integration."
              : "Unknown integration provider.",
            e,
          );
        }
        if (OAUTH_V1_NOT_WIRED.has(slug)) {
          return notImpl(
            "In-app OAuth is not available in v1. Import credentials via an external agent where supported.",
            e,
          );
        }
        setConnected(slug, true);
        return {
          connected: true,
          provider: slug,
          stub: false,
          echo: e,
        };
      }
      case "app_integration_toggle": {
        const slug = normalizeProvider(e.provider);
        if (REGISTERED.has(slug)) {
          setConnected(slug, e.connected === true);
        }
        return {
          saved: true,
          connected: e.connected === true,
          provider: slug,
          stub: false,
          echo: e,
        };
      }
      case "app_integration_import_credentials": {
        const slug = normalizeProvider(e.provider);
        if (slug === "google_calendar") {
          const hasAccess = String(e.accessToken || "").trim().length > 0;
          const hasRefresh = String(e.refreshToken || "").trim().length > 0;
          const hasClient = String(e.oauthClientId || "").trim().length > 0;
          writeGcalMock({
            configured: hasAccess,
            tokenRefreshReady: hasRefresh && hasClient,
            importedAt: Date.now(),
          });
        }
        if (slug === "gmail") {
          const hasAccess = String(e.accessToken || "").trim().length > 0;
          const hasRefresh = String(e.refreshToken || "").trim().length > 0;
          const hasClient = String(e.oauthClientId || "").trim().length > 0;
          writeGmailMock({
            configured: hasAccess,
            tokenRefreshReady: hasRefresh && hasClient,
            importedAt: Date.now(),
          });
        }
        return {
          saved: true,
          provider: slug,
          stub: false,
          echo: e,
        };
      }
      case "app_integration_credentials_status": {
        const slug = normalizeProvider(e.provider || "google_calendar");
        if (slug === "google_calendar") {
          const g = readGcalMock();
          return {
            configured: g.configured,
            tokenRefreshReady: g.tokenRefreshReady,
            provider: slug,
            stub: false,
            echo: e,
          };
        }
        if (slug === "gmail") {
          const g = readGmailMock();
          return {
            configured: g.configured,
            tokenRefreshReady: g.tokenRefreshReady,
            provider: slug,
            stub: false,
            echo: e,
          };
        }
        return {
          configured: false,
          tokenRefreshReady: false,
          provider: slug,
          stub: false,
          echo: e,
        };
      }
      case "shogun_gmail_sync": {
        const g = readGmailMock();
        const ingested = g.configured ? 2 : 0;
        return {
          ingested,
          stub: false,
          echo: e,
        };
      }
      case "shogun_google_calendar_sync": {
        const g = readGcalMock();
        const ingested = g.configured ? 3 : 0;
        const now = Date.now();
        /** Demo + dev: events with Meet/Zoom links so Hi-Fi can auto-open Granola (browser mock). */
        const events = [
          {
            id: "mock-google-meet-in-progress",
            summary: "Design review (Google Meet)",
            startDateTimeMs: now - 2 * 60 * 1000,
            endDateTimeMs: now + 58 * 60 * 1000,
            hangoutLink: "https://meet.google.com/lookup/hifi-demo-granola",
          },
          {
            id: "mock-zoom-upcoming",
            summary: "Partner sync (Zoom)",
            startDateTimeMs: now + 26 * 60 * 60 * 1000,
            endDateTimeMs: now + 26 * 60 * 60 * 1000 + 45 * 60 * 1000,
            location: "https://zoom.us/j/0001112222",
          },
        ];
        return {
          ingested,
          calendarId: e.calendarId || "primary",
          events,
          stub: false,
          echo: e,
        };
      }
      default:
        return null;
    }
  }

  global.ShogunIntegrationConnectors = {
    ICON_BY_SLUG,
    REGISTERED,
    normalizeProvider,
    getIconFile,
    readConnectedMap,
    setConnected,
    getConnected,
    hydrateTools,
    DEFAULT_GRID_TOOLS,
    mockIntegrationPayload,
    readGcalMock,
    readGmailMock,
  };
})(typeof window !== "undefined" ? window : globalThis);
