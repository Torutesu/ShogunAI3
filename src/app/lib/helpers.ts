// Pure helper functions extracted from App.tsx (Phase 2 Step 11)
import { DUMMY_WORK_PROJECT_IDS } from './constants';

export function profileStateFromSections(sections: any): {
  name: string;
  email: string;
  avatarGlyph: string;
  avatarImageDataUrl: string;
} {
  const g = sections && sections.general;
  const name = g && g.name != null ? String(g.name).trim() : '';
  const email = g && g.email != null ? String(g.email).trim() : '';
  const avatarGlyph = g && g.avatarGlyph != null ? String(g.avatarGlyph).trim() : '';
  const rawImg = g && g.avatarImageDataUrl != null ? String(g.avatarImageDataUrl).trim() : '';
  const avatarImageDataUrl = rawImg && /^data:image\//i.test(rawImg) ? rawImg : '';
  return { name, email, avatarGlyph, avatarImageDataUrl };
}

export function isProfilePhotoDataUrl(s: any): boolean {
  const t = s != null ? String(s).trim() : '';
  return t.length > 0 && /^data:image\//i.test(t);
}

/** One grapheme for sidebar / menu avatar: optional override, else first letter of display name. */
export function shellAvatarChar(avatarGlyph: any, displayName: any): string {
  const g = avatarGlyph != null ? String(avatarGlyph).trim() : '';
  if (g) {
    const ch = Array.from(g)[0];
    return ch || '?';
  }
  const n = String(displayName || '').trim();
  if (n) {
    const c = Array.from(n)[0] as string;
    if (/^[a-z]$/i.test(c)) return c.toUpperCase();
    return c;
  }
  return '?';
}

export function purgeDummyWorkProjects(list: any[]): any[] {
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && typeof p === 'object' && !DUMMY_WORK_PROJECT_IDS.has(p.id));
}

export function purgeDummyChats(list: any[]): any[] {
  if (!Array.isArray(list)) return [];
  return list.filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && !c.id.startsWith('demo-'));
}

/** Apply `sections.appearance` from settings JSON to `<html>` (color mode, font size). */
export function applySavedAppearance(sections: any): void {
  if (!sections || typeof sections !== 'object') return;
  const a = sections.appearance;
  if (!a || typeof a !== 'object') return;
  const pref = a.colorMode != null ? String(a.colorMode) : '';
  if (pref === 'light' || pref === 'dark' || pref === 'auto') {
    document.documentElement.setAttribute('data-appearance', pref);
    const effective = pref === 'auto'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : pref;
    document.documentElement.setAttribute('data-color-mode', effective);
  }
  if (a.fontSize != null) {
    const fs = String(a.fontSize).toLowerCase();
    if (fs === 'normal' || fs === 'compact' || fs === 'comfortable') {
      document.documentElement.setAttribute('data-font-size', fs);
    }
  } else {
    document.documentElement.removeAttribute('data-font-size');
  }
}
