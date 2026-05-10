import {
  PRIVACY_DEFAULT_APPS,
  PRIVACY_DEFAULT_SITES,
  DEFAULT_PAYMENT_DOMAINS,
} from './defaults';

/** Fired after a successful `settings.save` on `section: privacy` so Chat / Memory / Work reload flags without remounting. */
export function notifyPrivacySettingsChanged(detail: Record<string, any>) {
  try {
    window.dispatchEvent(
      new CustomEvent('shogun-privacy-settings-changed', {
        detail: detail && typeof detail === 'object' ? detail : {},
      }),
    );
  } catch (_) {}
}

export function filterPrivacyRows(rows: any[], q: string, filt: string, textOf: (r: any) => string) {
  const qq = (q || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (filt === 'on' && !r.enabled) return false;
    if (filt === 'off' && r.enabled) return false;
    if (!qq) return true;
    return String(textOf(r)).toLowerCase().includes(qq);
  });
}

export function normalizePrivacyFromSettings(sec: any) {
  let apps = sec && Array.isArray(sec.excludedApps) ? sec.excludedApps : null;
  let sites = sec && Array.isArray(sec.excludedSites) ? sec.excludedSites : null;
  if (!apps && sec && typeof sec.app === 'string' && sec.app) {
    apps = [{ id: 'legacy-app', name: sec.app, icon: '📱', enabled: !!sec.enabled }];
  }
  if (!apps) apps = PRIVACY_DEFAULT_APPS.map((r) => ({ ...r }));
  if (!sites) sites = PRIVACY_DEFAULT_SITES.map((r) => ({ ...r }));
  const ps = sec && sec.paymentScreens && typeof sec.paymentScreens === 'object'
    ? sec.paymentScreens
    : null;
  const paymentScreens = {
    enabled: ps && typeof ps.enabled === 'boolean' ? ps.enabled : true,
    detectCardPattern:
      ps && typeof ps.detectCardPattern === 'boolean' ? ps.detectCardPattern : true,
    domains: Array.isArray(ps && ps.domains)
      ? ps.domains
          .filter((r: any) => r && typeof r.host === 'string')
          .map((r: any, i: number) => ({
            id: String(r.id || `pd-${i}`),
            host: String(r.host).toLowerCase(),
            label: r.label != null ? String(r.label) : String(r.host),
            enabled: r.enabled !== false,
          }))
      : DEFAULT_PAYMENT_DOMAINS.map((d) => ({ ...d })),
  };
  const inc = sec && sec.incognito && typeof sec.incognito === 'object' ? sec.incognito : null;
  const incBrowsers = inc && inc.browsers && typeof inc.browsers === 'object' ? inc.browsers : {};
  const readBool = (v: any, fb: boolean) => (typeof v === 'boolean' ? v : fb);
  const incognito = {
    enabled: inc && typeof inc.enabled === 'boolean' ? inc.enabled : true,
    browsers: {
      safari: readBool(incBrowsers.safari, true),
      chrome: readBool(incBrowsers.chrome, true),
      arc: readBool(incBrowsers.arc, true),
      firefox: readBool(incBrowsers.firefox, true),
      edge: readBool(incBrowsers.edge, true),
    },
  };
  const rawBlocks = Array.isArray(sec && sec.timeBlocks) ? sec.timeBlocks : [];
  const timeBlocks = rawBlocks
    .filter((r: any) => r && typeof r === 'object')
    .map((r: any, i: number) => {
      const sm = Math.max(0, Math.min(1439, Number(r.startMinute) || 0));
      const em = Math.max(0, Math.min(1439, Number(r.endMinute) || 0));
      const days = (Number(r.days) || 0) & 0x7F;
      return {
        id: String(r.id || `tb-${i}`),
        label: r.label != null ? String(r.label) : '',
        startMinute: sm,
        endMinute: em,
        days,
        enabled: r.enabled !== false,
      };
    });
  return {
    excludedApps: apps.map((r: any) => ({
      id: String(r.id || r.name || 'app'),
      name: String(r.name || 'App'),
      icon: r.icon != null ? String(r.icon) : '⬚',
      enabled: !!r.enabled,
      path: r.path ? String(r.path) : undefined,
    })),
    excludedSites: sites.map((r: any) => ({
      id: String(r.id || r.host || 'site'),
      host: String(r.host || '').toLowerCase().replace(/^https?:\/\//i, '').split('/')[0],
      label: r.label != null ? String(r.label) : String(r.host || ''),
      enabled: !!r.enabled,
    })),
    paymentScreens,
    incognito,
    timeBlocks,
  };
}

export function timeBlockMinutesToHHMM(m: number) {
  const mm = Math.max(0, Math.min(1439, Number(m) || 0));
  const h = Math.floor(mm / 60);
  const min = mm % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function hhmmToMinutes(s: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return 0;
  const h = Math.max(0, Math.min(23, parseInt(m[1] as string, 10)));
  const min = Math.max(0, Math.min(59, parseInt(m[2] as string, 10)));
  return h * 60 + min;
}

export function newQuietBlock() {
  return {
    id: `tb-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    label: '',
    startMinute: 22 * 60,
    endMinute: 7 * 60,
    days: 0x7F,
    enabled: true,
  };
}
