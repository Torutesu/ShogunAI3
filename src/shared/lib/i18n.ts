// Runtime language lookup for strings that can't use the `.en-only` / `.jp`
// span trick — toasts, aria-labels, `title` tooltips, and anything passed as a
// plain string rather than rendered as JSX.
//
// The language lives on `<body data-lang>` (set in MainApp from tweaks.language)
// and can be 'en' | 'jp' | 'bi'. The app default is 'en', so any JP-only literal
// is shown to English users — which is exactly the leak this exists to close.

export type ShogunLang = 'en' | 'jp' | 'bi';

/** Current UI language. Defaults to 'en' (matches TWEAK_DEFAULTS.language). */
export function currentLang(): ShogunLang {
  try {
    const v = document.body?.getAttribute('data-lang');
    if (v === 'jp' || v === 'bi') return v;
  } catch {
    /* no DOM (SSR/tests) — fall through */
  }
  return 'en';
}

/**
 * Pick a string for the active language.
 *
 * 'bi' (bilingual) mode resolves to English: it renders *both* for JSX spans,
 * but a toast showing "English / 日本語" would be twice as long and truncate,
 * so the primary language wins for one-line strings.
 */
export function t(en: string, jp: string): string {
  return currentLang() === 'jp' ? jp : en;
}
