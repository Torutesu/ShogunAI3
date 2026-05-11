/** IANA zone from Shogun helper or `Intl` (browser / OS). */
export function resolveUserTimeZoneId(): string {
  const U = typeof window !== 'undefined' ? (window as any).ShogunUserTimezone : null;
  if (U && typeof U.getTimeZone === 'function') {
    const z = U.getTimeZone();
    if (z && String(z).trim()) return String(z).trim();
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_e) {
    return 'UTC';
  }
}

export function composerPlaceholderForLang(lang: any): string {
  const L = lang === 'en' || lang === 'jp' || lang === 'bi' ? lang : 'en';
  if (L === 'jp') return '本日はどのようなお手伝いをさせていただけますか？';
  if (L === 'bi') {
    return 'How can I help you today? ／ 本日はどのようなお手伝いをさせていただけますか？';
  }
  return 'How can I help you today?';
}

/** First word of display name for EN/JP greeting lines (matches previous behavior). */
export function homeFirstNameToken(fullName: any): string {
  const raw = fullName != null ? String(fullName).trim() : '';
  if (!raw) return '';
  return raw.split(/\s+/)[0] ?? '';
}

/** Greeting + date lines from the user's local clock (browser/OS timezone). */
export function computeHomeGreetingState(now: any): { greetEn: string; greetJp: string; dateEn: string; dateJp: string; dateBi: string } {
  const d = now instanceof Date ? now : new Date();
  const h = d.getHours();
  let greetEn: string;
  let greetJp: string;
  if (h >= 5 && h < 12) {
    greetEn = 'Good morning';
    greetJp = 'おはようございます';
  } else if (h >= 12 && h < 17) {
    greetEn = 'Good afternoon';
    greetJp = 'こんにちは';
  } else if (h >= 17 && h < 22) {
    greetEn = 'Good evening';
    greetJp = 'こんばんは';
  } else {
    greetEn = 'Good evening';
    greetJp = 'お疲れ様です';
  }
  const tz = resolveUserTimeZoneId();
  const dateEn = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
    timeZoneName: 'short',
  }).format(d);
  const dateJp = new Intl.DateTimeFormat('ja-JP', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
    timeZoneName: 'short',
  }).format(d);
  const dateBi = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
    timeZoneName: 'short',
  }).format(d);
  return { greetEn, greetJp, dateEn, dateJp, dateBi };
}

/** Compute smart snooze deadlines from "now". */
export function smartSnoozePresets(now = new Date()): { tomorrowMorning: number; nextMondayMorning: number } {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const jsDow = now.getDay();
  const daysToMonday = jsDow === 1
    ? 7
    : (8 - jsDow) % 7;
  const nextMonday = new Date(now);
  nextMonday.setDate(nextMonday.getDate() + (daysToMonday || 7));
  nextMonday.setHours(9, 0, 0, 0);
  return { tomorrowMorning: tomorrow.getTime(), nextMondayMorning: nextMonday.getTime() };
}
