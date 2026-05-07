/**
 * Demo data for Hi-Fi preview / recordings. Fictitious org: Kitazawa Tech, Project Aurora.
 * Loaded before ipc-client.js; used by mockTransport and app.jsx.
 */

const now = Date.now();
/** Unix ms for memory timeline (`new Date(created_at)`) */
const ts = (deltaMs: any) => now + deltaMs;

const memoryHits = [
  {
    id: "demo-m-01",
    title: "Kitazawa Tech · Q2 roadmap — Aurora beta",
    snippet:
      "Beta week target mid-June. DPIA draft to legal. Mio Sato synced wires in Figma. Kenta Yamada on data labels.",
    source: "chat",
    kinds: ["input"],
    created_at: ts(-45 * 60 * 1000),
  },
  {
    id: "demo-m-02",
    title: "Investor update deck — Kitazawa (sample)",
    snippet:
      "For Jordan Blake: three slides on adoption, retention, pricing. Alex Chen owns numbers; deadline Fri 18:00 JST.",
    source: "meetings",
    kinds: ["audio"],
    created_at: ts(-3 * 60 * 60 * 1000),
  },
  {
    id: "demo-m-03",
    title: "Aurora / data classification labels v0.9",
    snippet:
      "PII tags: email, phone, my_number required. Opt-out copy unchanged from v0.8. Waiting on Yamada sign-off.",
    source: "work",
    kinds: ["input"],
    created_at: ts(-5 * 60 * 60 * 1000),
  },
  {
    id: "demo-m-04",
    title: "Slack #aurora-launch — release checklist",
    snippet:
      "App Store metadata, support macros, status page copy. Three P1 items left before RC.",
    source: "chat",
    kinds: ["input"],
    created_at: ts(-20 * 60 * 60 * 1000),
  },
  {
    id: "demo-m-05",
    title: "Customer interview — fictive SaaS \"Nodebank\"",
    snippet:
      "Pain: half-day reconciling CSV exports. Aurora prototype for auto-merge resonated. Next demo Apr 22.",
    source: "note",
    kinds: ["input"],
    created_at: ts(-26 * 60 * 60 * 1000),
  },
  {
    id: "demo-m-06",
    title: "LP copy ja / en — headline options",
    snippet:
      'JA (sample): team memory in one surface. EN: "One command surface for your team\'s memory." Legal review pending.',
    source: "work",
    kinds: ["input"],
    created_at: ts(-30 * 60 * 60 * 1000),
  },
  {
    id: "demo-m-07",
    title: "1:1 Mio Sato x Kenta Yamada — hiring pipeline",
    snippet:
      "One mid Go engineer, 0.5 designer. Try Greenhouse sync for scheduling. Kickoff next week.",
    source: "meetings",
    kinds: ["audio"],
    created_at: ts(-40 * 60 * 60 * 1000),
  },
  {
    id: "demo-m-08",
    title: "Security review — third-party SDK list",
    snippet:
      "Analytics SDK off. Push in-house. Residual risk: older OpenSSL in one dep — fail CI on advisory.",
    source: "note",
    kinds: ["input"],
    created_at: ts(-52 * 60 * 60 * 1000),
  },
  {
    id: "demo-m-09",
    title: "Claude project: Aurora spec summary",
    snippet:
      "Ingest only text from user-allowed apps; no screenshots by default. Stated clearly in privacy sheet.",
    source: "chat",
    kinds: ["input"],
    created_at: ts(-60 * 60 * 60 * 1000),
  },
  {
    id: "demo-m-10",
    title: "Keyboard shortcuts draft (macOS)",
    snippet:
      "Cmd+K Chat, Cmd+, Settings. Voice shortcut conflicts with system — need alternate chord.",
    source: "note",
    kinds: ["input"],
    created_at: ts(-72 * 60 * 60 * 1000),
  },
  {
    id: "demo-m-11",
    title: "All-hands — Kitazawa Tech (sample)",
    snippet:
      "Shared Aurora beta demo video. Five CS questions captured into FAQ backlog.",
    source: "meetings",
    kinds: ["audio"],
    created_at: ts(-96 * 60 * 60 * 1000),
  },
  {
    id: "demo-m-12",
    title: "API rate limits — backoff design",
    snippet: "On 429: exponential backoff cap 32s; client adds jitter.",
    source: "work",
    kinds: ["input"],
    created_at: ts(-120 * 60 * 60 * 1000),
  },
];

const entities = [
  { id: "e-chat", label: "Chat", mentions: 312 },
  { id: "e-meet", label: "Meetings", mentions: 128 },
  { id: "e-work", label: "Work", mentions: 94 },
  { id: "e-note", label: "Notes", mentions: 213 },
  { id: "e-cal", label: "Calendar sync", mentions: 56 },
];

const stats = {
  eventsToday: "2,847",
  memoriesToday: "34",
  memoryTotal: 847,
  memoriesLast24h: 34,
  memories: "847",
  disk: "2.1 GB",
  historyDays: "94 days",
  usagePercent: 38,
  appCoverage: [
    ["Xcode", 412, 88],
    ["Arc", 298, 72],
    ["Slack", 156, 64],
    ["Notion", 124, 52],
    ["zoom.us", 98, 44],
    ["Cursor", 76, 36],
  ],
  echo: {},
  stub: false,
};

const chats = [
  {
    id: "demo-c-aurora",
    title: "Kitazawa · Q2 roadmap",
    time: "09:41",
    when: "TODAY",
    jp: "今日",
    favorite: true,
  },
  {
    id: "demo-c-privacy",
    title: "Aurora / privacy DPIA",
    time: "08:06",
    when: "TODAY",
    jp: "今日",
    favorite: true,
  },
  {
    id: "demo-c-lp",
    title: "LP copy · ja / en",
    time: "Yesterday",
    when: "YESTERDAY",
    jp: "昨日",
    favorite: false,
  },
  {
    id: "demo-c-investor",
    title: "Investor sync · Jordan",
    time: "Tue",
    when: "APR15",
    jp: "火",
    favorite: false,
  },
  {
    id: "demo-c-hiring",
    title: "Hiring · eng + design",
    time: "Mon",
    when: "APR 14",
    jp: "月",
    favorite: false,
  },
];

const chatThreads = {
  "demo-c-aurora": [
    {
      role: "user",
      content:
        "Kitazawa no Aurora: assuming Q2 beta, what are the top 3 risks? Stakeholders: Mio, Kenta, Alex.",
    },
    {
      role: "assistant",
      content:
        "[Demo reply — real app uses your model.] Practical risks:\n\n1) **Privacy / DPIA** — explaining capture, retention, and subprocessors; legal review often gates the date.\n2) **Scope creep** — every \"small\" add-on pushes the mid-June window; lock Must/Should/Later this week.\n3) **Onboarding** — if permission UX is unclear, day-1 churn spikes. Run copy tests from Mio's Figma as-is.\n\nI can also draft a one-paragraph investor summary.",
    },
    {
      role: "user",
      content: "One calm paragraph for investors. Placeholder metrics OK.",
    },
    {
      role: "assistant",
      content:
        "Kitazawa Tech builds **Aurora**, indexing team work locally-first and surfacing it through a single command surface. In Q2 beta we target enterprise teams with policy packs and audit logs, and we will measure time-to-first-task and completion rates (figures at beta close).",
    },
  ],
  "demo-c-privacy": [
    {
      role: "user",
      content: "DPIA \"data flow\" in plain bullets — use fictive Kitazawa as example.",
    },
    {
      role: "assistant",
      content:
        "· **In**: text context from user-approved apps (no screenshots in default mode)\n· **Process**: index & summarize on the Mac; Memory index not uploaded to Kitazawa cloud in this build\n· **Store**: local app data (e.g. under ~/Library)\n· **Out**: only when the user exports or sends a chat\n· **Third parties**: LLM only via BYOK keys the user sets\n\nAssign owners and retention in production.",
    },
  ],
  "demo-c-lp": [
    {
      role: "user",
      content: "Hero line in English — shorter, avoid jargon.",
    },
    {
      role: "assistant",
      content:
        'Option A: **"Your team\'s context, ready when you are."** (12 words)\nOption B: **"Less searching. More doing."** — punchier.',
    },
  ],
  "demo-c-investor": [
    {
      role: "user",
      content: "Follow-up email draft for Jordan; recap three themes from last call.",
    },
    {
      role: "assistant",
      content:
        "Subject: Aurora beta timeline / risks / asks\n\nJordan,\n\nFollowing up on (1) local-first trust posture, (2) onboarding friction, (3) enterprise audit — we prioritized DPIA and onboarding for the Q2 beta. Slide deck v3 by next Wednesday with a usage curve placeholder.\n\nBest,\n[Name]",
    },
  ],
  "demo-c-hiring": [
    {
      role: "user",
      content: "Five must-have skills for mid-level Go hire.",
    },
    {
      role: "assistant",
      content:
        "1. 3+ yrs Go services\n2. PostgreSQL + migrations in production\n3. Tracing or structured logging at scale\n4. macOS integration (Accessibility or AppleScript) welcome\n5. Comfortable with security-minded code review",
    },
  ],
};

const chatMemoryContext = {
  "demo-c-aurora": [
    "Kitazawa Tech · Project Aurora — Q2 beta scope (internal)",
    "Mio Sato: Figma wires v4",
    "Alex Chen: usage metrics draft (sheet)",
    "Risk: DPIA sign-off target Apr 25",
  ].join("\n"),
  "demo-c-privacy": [
    "DPIA draft v0.3 — sections 3–5 need legal",
    "PII tags: email, phone, my_number (required)",
  ].join("\n"),
};

export const SHOGUN_DEMO_SEED = {
  memoryHits: memoryHits,
  entities: entities,
  stats: stats,
  chats: chats,
  chatThreads: chatThreads,
  chatMemoryContext: chatMemoryContext,
};

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).SHOGUN_DEMO_SEED = SHOGUN_DEMO_SEED;
}
