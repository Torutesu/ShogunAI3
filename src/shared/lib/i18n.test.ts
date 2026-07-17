import { describe, it, expect, afterEach } from 'vitest';
import { currentLang, t } from './i18n';

function setLang(v: string | null) {
  if (v === null) document.body.removeAttribute('data-lang');
  else document.body.setAttribute('data-lang', v);
}

describe('i18n', () => {
  afterEach(() => setLang(null));

  describe('currentLang', () => {
    it('defaults to en when unset — matches TWEAK_DEFAULTS.language', () => {
      setLang(null);
      expect(currentLang()).toBe('en');
    });

    it('reads jp and bi from body[data-lang]', () => {
      setLang('jp');
      expect(currentLang()).toBe('jp');
      setLang('bi');
      expect(currentLang()).toBe('bi');
    });

    it('falls back to en for an unknown value', () => {
      setLang('klingon');
      expect(currentLang()).toBe('en');
    });
  });

  describe('t', () => {
    it('returns English by default — the leak this closes', () => {
      setLang(null);
      expect(t('Recording started', '録音を開始しました')).toBe('Recording started');
      setLang('en');
      expect(t('Recording started', '録音を開始しました')).toBe('Recording started');
    });

    it('returns Japanese in jp mode', () => {
      setLang('jp');
      expect(t('Recording started', '録音を開始しました')).toBe('録音を開始しました');
    });

    it('returns English in bilingual mode (one-line strings keep the primary)', () => {
      setLang('bi');
      expect(t('Recording started', '録音を開始しました')).toBe('Recording started');
    });
  });
});
