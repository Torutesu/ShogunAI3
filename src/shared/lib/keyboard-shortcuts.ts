/**
 * Keyboard shortcuts: action id -> { key, super, ctrl, alt, shift }.
 * - super: Command on macOS; matched as metaKey OR ctrlKey (Windows/Linux friendly).
 * - ctrl: Control key, e.g. Toggle Max (ctrlKey, not metaKey alone).
 */

const ACTION_IDS = {
  NEW_CHAT: "shortcut.new_chat",
  OPEN_CHAT_SEARCH: "shortcut.open_chat_search",
  OPEN_SETTINGS: "shortcut.open_settings",
  TOGGLE_SIDEBAR: "shortcut.toggle_sidebar",
  NAVIGATE_BACK: "shortcut.navigate_back",
  NAVIGATE_FORWARD: "shortcut.navigate_forward",
  MEMORY_CAPTURE: "shortcut.memory_capture_moment",
  MEMORY_JUMP_TIMELINE: "shortcut.memory_jump_timeline",
  CHAT_TOGGLE_MAX: "shortcut.chat_toggle_max",
};

/** @type {Record<string, { key: string, super: boolean, ctrl: boolean, alt: boolean, shift: boolean }>} */
const DEFAULT_BINDINGS: Record<string, any> = {
  [ACTION_IDS.NEW_CHAT]: { key: "n", super: true, ctrl: false, alt: false, shift: false },
  [ACTION_IDS.OPEN_CHAT_SEARCH]: { key: "k", super: true, ctrl: false, alt: false, shift: false },
  [ACTION_IDS.OPEN_SETTINGS]: { key: ",", super: true, ctrl: false, alt: false, shift: false },
  [ACTION_IDS.TOGGLE_SIDEBAR]: { key: "s", super: true, ctrl: false, alt: false, shift: false },
  [ACTION_IDS.NAVIGATE_BACK]: { key: "[", super: true, ctrl: false, alt: false, shift: false },
  [ACTION_IDS.NAVIGATE_FORWARD]: { key: "]", super: true, ctrl: false, alt: false, shift: false },
  [ACTION_IDS.MEMORY_CAPTURE]: { key: "c", super: true, ctrl: false, alt: false, shift: true },
  [ACTION_IDS.MEMORY_JUMP_TIMELINE]: { key: "t", super: true, ctrl: false, alt: false, shift: true },
  [ACTION_IDS.CHAT_TOGGLE_MAX]: { key: "t", super: false, ctrl: true, alt: false, shift: false },
};

const ACTION_PRIORITY = [
  ACTION_IDS.MEMORY_CAPTURE,
  ACTION_IDS.MEMORY_JUMP_TIMELINE,
  ACTION_IDS.NEW_CHAT,
  ACTION_IDS.OPEN_CHAT_SEARCH,
  ACTION_IDS.OPEN_SETTINGS,
  ACTION_IDS.TOGGLE_SIDEBAR,
  ACTION_IDS.NAVIGATE_BACK,
  ACTION_IDS.NAVIGATE_FORWARD,
  ACTION_IDS.CHAT_TOGGLE_MAX,
];

const CHAT_ONLY_ACTIONS = new Set([
  ACTION_IDS.CHAT_TOGGLE_MAX,
]);

const SHORTCUT_UI_GROUPS = [
  {
    name: "General",
    items: [
      { label: "New chat", actionId: ACTION_IDS.NEW_CHAT },
      { label: "Search", actionId: ACTION_IDS.OPEN_CHAT_SEARCH },
      { label: "Open settings", actionId: ACTION_IDS.OPEN_SETTINGS },
      { label: "Toggle sidebar", actionId: ACTION_IDS.TOGGLE_SIDEBAR },
    ],
  },
  {
    name: "Navigation",
    items: [
      { label: "Go back", actionId: ACTION_IDS.NAVIGATE_BACK },
      { label: "Go forward", actionId: ACTION_IDS.NAVIGATE_FORWARD },
    ],
  },
  {
    name: "Chat",
    items: [
      { label: "Toggle Max", actionId: ACTION_IDS.CHAT_TOGGLE_MAX },
    ],
  },
  {
    name: "Memory",
    items: [
      { label: "Capture moment", actionId: ACTION_IDS.MEMORY_CAPTURE },
      { label: "Jump to timeline", actionId: ACTION_IDS.MEMORY_JUMP_TIMELINE },
    ],
  },
];

const KNOWN_ACTION_IDS = Object.keys(DEFAULT_BINDINGS);

function bool(v: any) {
  return v === true;
}

function validateBinding(b: any) {
  if (!b || typeof b !== "object") return false;
  if (typeof b.key !== "string" || b.key.length === 0) return false;
  return true;
}

/** @param {Record<string, unknown> | null | undefined} saved */
function mergeShortcutBindings(saved?: any) {
  /** @type {Record<string, { key: string, super: boolean, ctrl: boolean, alt: boolean, shift: boolean }>} */
  const out: Record<string, any> = {};
  for (const id of KNOWN_ACTION_IDS) {
    out[id] = { ...DEFAULT_BINDINGS[id] };
  }
  if (!saved || typeof saved !== "object") return out;
  for (const id of KNOWN_ACTION_IDS) {
    const raw = saved[id];
    if (!validateBinding(raw)) continue;
    const base = DEFAULT_BINDINGS[id];
    out[id] = {
      key: String(raw.key),
      super: bool(raw.super),
      ctrl: bool(raw.ctrl),
      alt: bool(raw.alt),
      shift: bool(raw.shift),
    };
    if (!validateBinding(out[id])) {
      out[id] = { ...base };
    }
  }
  return out;
}

function normalizeEventKey(e: any) {
  const k = e.key;
  if (!k || k === "Dead") return "";
  if (k.length === 1) return k.toLowerCase();
  if (k === "Comma") return ",";
  if (k === "Period") return ".";
  return String(k).toLowerCase();
}

function normalizeBindingKey(key: any) {
  const s = String(key);
  if (s.length === 1) return s.toLowerCase();
  return s.toLowerCase();
}

/**
 * @param {KeyboardEvent} e
 * @param {{ key: string, super: boolean, ctrl: boolean, alt: boolean, shift: boolean }} b
 */
function eventMatchesBinding(e: any, b: any) {
  if (!b || !validateBinding(b)) return false;
  if (!!b.shift !== e.shiftKey) return false;
  if (!!b.alt !== e.altKey) return false;

  const wantSuper = !!b.super;
  const wantCtrlOnly = !!b.ctrl && !wantSuper;

  if (wantSuper) {
    if (!(e.metaKey || e.ctrlKey)) return false;
  } else if (wantCtrlOnly) {
    if (!e.ctrlKey) return false;
    if (e.metaKey) return false;
  } else {
    if (e.metaKey || e.ctrlKey) return false;
  }

  const evK = normalizeEventKey(e);
  const wantK = normalizeBindingKey(b.key);
  if (wantK === "backspace") return evK === "backspace";
  if (wantK === "enter") return evK === "enter";
  if (wantK === "escape") return evK === "escape";
  return evK === wantK || e.key === b.key;
}

/**
 * @param {KeyboardEvent} e
 * @param {Record<string, { key: string, super: boolean, ctrl: boolean, alt: boolean, shift: boolean }>} merged
 * @param {string} activeScreen
 */
function findMatchingAction(e: any, merged: any, activeScreen: any) {
  for (const actionId of ACTION_PRIORITY) {
    if (CHAT_ONLY_ACTIONS.has(actionId) && activeScreen !== "chat") continue;
    const b = merged[actionId];
    if (eventMatchesBinding(e, b)) return actionId;
  }
  return null;
}

function bindingToDisplayParts(b: any) {
  if (!b || !validateBinding(b)) return ["—"];
  const parts: string[] = [];
  if (b.super) parts.push("⌘");
  if (b.ctrl) parts.push("⌃");
  if (b.alt) parts.push("⌥");
  if (b.shift) parts.push("⇧");
  const k = normalizeBindingKey(b.key);
  if (k === ",") parts.push(",");
  else if (k === ".") parts.push(".");
  else if (k === "[") parts.push("[");
  else if (k === "]") parts.push("]");
  else if (k === "backspace") parts.push("⌫");
  else if (k === "enter") parts.push("↩");
  else if (k.length === 1) parts.push(k.toUpperCase());
  else parts.push(b.key);
  return parts;
}

export const ShogunKeyboardShortcuts = {
  ACTION_IDS,
  DEFAULT_BINDINGS,
  ACTION_PRIORITY,
  CHAT_ONLY_ACTIONS,
  SHORTCUT_UI_GROUPS,
  mergeShortcutBindings,
  eventMatchesBinding,
  findMatchingAction,
  bindingToDisplayParts,
};

