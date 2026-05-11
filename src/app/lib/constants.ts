// Navigation + UI constants extracted from App.tsx (Phase 2 Step 11)

export const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "language": "en",
  "accentDensity": "standard",
  "dotGrid": false,
  "goldIntensity": "standard"
}/*EDITMODE-END*/;

export const NAV = [
  {id:'home',      label:'Home',         jp:'起動',   icon:'dashboard', section:'main'},
  {id:'memory',    label:'Memory',       jp:'記憶',   icon:'memory',    section:'main'},
  {id:'chat',      label:'Chat',         jp:'対話',   icon:'chat',      section:'main'},
  {id:'agents',    label:'Agents',       jp:'家臣',   icon:'agents',    section:'main'},
  {id:'work',      label:'Work',         jp:'任務',   icon:'work',      section:'workspace'},
  {id:'meetings',  label:'Meetings',     jp:'会議',   icon:'calendar',  section:'workspace'},
];

export const REMOVED_NAV_IDS = new Set(['morning_brief', 'capture', 'integrations', 'settings']);

export const CHAT_CONTEXT_TELEMETRY_LS = 'shogun.hifi.telemetry.chat_context.v1';
export const CHAT_WORKSPACE_LS = 'shogun.hifi.chat.workspace.v1';
export const DUMMY_WORK_PROJECT_IDS = new Set([
  'w-steal',
  'w-grop',
  'w-cluely',
  'w-kakei',
  'w-hojo',
  'w-chrome',
]);

export const SIDEBAR_WIDTH_LS = 'shogun.hifi.sidebar.width.v1';
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;

export const INITIAL_CHAT_HISTORY: any[] =
  typeof window !== 'undefined' &&
  (window as any).SHOGUN_DEMO_SEED &&
  Array.isArray((window as any).SHOGUN_DEMO_SEED.chats)
    ? (window as any).SHOGUN_DEMO_SEED.chats
    : [];
