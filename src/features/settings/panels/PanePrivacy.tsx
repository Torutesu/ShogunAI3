/* eslint-disable max-lines -- Phase 2 Step 10: feature split. Phase 3 will further decompose. */
import React, { useState } from 'react';
import { Icon } from '@/shared/icons';
import { Pane } from '../components/Pane';
import { Row } from '../components/Row';
import { Toggle } from '../components/Toggle';
import { useRuntimeActions } from '../lib/hooks';
import { unwrapExecutePayload } from '../lib/utils';
import {
  normalizePrivacyFromSettings,
  notifyPrivacySettingsChanged,
  filterPrivacyRows,
  timeBlockMinutesToHHMM,
  hhmmToMinutes,
  newQuietBlock,
} from '../lib/privacy';
import {
  PRIVACY_DEFAULT_APPS,
  PRIVACY_DEFAULT_SITES,
  DEFAULT_PAYMENT_DOMAINS,
  DAY_LABELS,
  FULL_DAY_NAMES,
  EMPTY_SETTINGS_SECURITY,
  IMPORT_CONFIRM_TOKEN,
} from '../lib/defaults';
import { PRODUCT } from '../lib/defaults';
import { SettingsHydrationContext } from '../types';

export function PanePrivacy() {
  const { run, toast } = useRuntimeActions();
  const { sections, refreshSections } = React.useContext(SettingsHydrationContext);
  const privacySec =
    sections.privacy && typeof sections.privacy === 'object' ? sections.privacy : {};
  const secSecurity =
    sections.security && typeof sections.security === 'object'
      ? sections.security
      : EMPTY_SETTINGS_SECURITY;

  const [tab, setTab] = useState('apps');
  const [apps, setApps] = useState(() => PRIVACY_DEFAULT_APPS.map((r) => ({ ...r })));
  const [sites, setSites] = useState(() => PRIVACY_DEFAULT_SITES.map((r) => ({ ...r })));
  const [paymentEnabled, setPaymentEnabled] = useState(true);
  const [paymentDetectCard, setPaymentDetectCard] = useState(true);
  const [paymentDomains, setPaymentDomains] = useState(() =>
    DEFAULT_PAYMENT_DOMAINS.map((d) => ({ ...d })),
  );
  const [paymentDraft, setPaymentDraft] = useState('');
  // NOTE: addPaymentDomain was moved below persistPrivacy to fix TDZ
  // (Babel-in-browser allowed forward reference; esbuild/strict ESM does not).
  const [incognitoEnabled, setIncognitoEnabled] = useState(true);
  const [incognitoBrowsers, setIncognitoBrowsers] = useState({
    safari: true, chrome: true, arc: true, firefox: true, edge: true,
  });
  const [timeBlocks, setTimeBlocks] = useState<any[]>([]);
  const pendingTimeBlocksSaveRef = React.useRef<any>(null);
  const [appSearch, setAppSearch] = useState('');
  const [siteSearch, setSiteSearch] = useState('');
  const [appFilter, setAppFilter] = useState('all');
  const [siteFilter, setSiteFilter] = useState('all');
  const [siteDraft, setSiteDraft] = useState('');

  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = useState(true);

  const [bioLock, setBioLock] = useState(!!(secSecurity as any).biometricLockEnabled);
  const [bioStatus, setBioStatus] = useState<any>(null);

  const persistPrivacy = React.useCallback(
    async (nextApps: any[], nextSites: any[], overrides?: any) => {
      const o = overrides || {};
      const r = await run(
        'settings.save',
        {
          section: 'privacy',
          excludedApps: nextApps,
          excludedSites: nextSites,
          allowChatServerMemoryAssembly: allowServerMemoryAssembly,
          paymentScreens: {
            enabled: 'paymentEnabled' in o ? o.paymentEnabled : paymentEnabled,
            detectCardPattern:
              'paymentDetectCard' in o ? o.paymentDetectCard : paymentDetectCard,
            domains: 'paymentDomains' in o ? o.paymentDomains : paymentDomains,
          },
          incognito: {
            enabled: 'incognitoEnabled' in o ? o.incognitoEnabled : incognitoEnabled,
            browsers: 'incognitoBrowsers' in o ? o.incognitoBrowsers : incognitoBrowsers,
          },
          timeBlocks: 'timeBlocks' in o ? o.timeBlocks : timeBlocks,
        },
        { silentError: true },
      );
      if (r && r.ok && refreshSections) await refreshSections();
      if (r && r.ok) notifyPrivacySettingsChanged({ allowChatServerMemoryAssembly: allowServerMemoryAssembly });
      return r;
    },
    [
      run,
      refreshSections,
      allowServerMemoryAssembly,
      paymentEnabled,
      paymentDetectCard,
      paymentDomains,
      incognitoEnabled,
      incognitoBrowsers,
      timeBlocks,
    ],
  );

  // Moved here from above persistPrivacy declaration to satisfy TDZ.
  const addPaymentDomain = React.useCallback(async () => {
    let host = (paymentDraft.trim().toLowerCase().replace(/^https?:\/\//i, '').split('/')[0] as string).trim();
    if (!host || !host.includes('.') || !/^[a-z0-9.-]+$/i.test(host)) {
      toast('有効なホスト名を入力してください', 'warn');
      return;
    }
    if (paymentDomains.some((x) => x.host === host)) {
      toast('そのドメインは既にあります', 'info');
      return;
    }
    const next = paymentDomains.concat([
      { id: `pd-${host}`, host, label: host, enabled: true },
    ]);
    setPaymentDomains(next);
    setPaymentDraft('');
    await persistPrivacy(apps, sites, { paymentDomains: next });
  }, [apps, sites, paymentDraft, paymentDomains, persistPrivacy, toast]);

  const privacyKey = JSON.stringify(privacySec);
  React.useEffect(() => {
    const { excludedApps, excludedSites, paymentScreens, incognito, timeBlocks: tb } = normalizePrivacyFromSettings(privacySec);
    setApps(excludedApps);
    setSites(excludedSites);
    setAllowServerMemoryAssembly(privacySec.allowChatServerMemoryAssembly !== false);
    setPaymentEnabled(paymentScreens.enabled);
    setPaymentDetectCard(paymentScreens.detectCardPattern);
    setPaymentDomains(paymentScreens.domains);
    setIncognitoEnabled(incognito.enabled);
    setIncognitoBrowsers(incognito.browsers);
    setTimeBlocks(tb);
  }, [privacyKey]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    setBioLock(!!(secSecurity as any).biometricLockEnabled);
  }, [(secSecurity as any).biometricLockEnabled]);

  React.useEffect(() => {
    let cancelled = false;
    const defer = window.setTimeout(() => {
      void (async () => {
        const fallback = {
          supported: false,
          enrolled: false,
          stub: true,
          biometryType: 'none',
          platform: 'timeout',
        };
        try {
          const r = await Promise.race([
            run('auth.biometric.status', {}, { silentError: true }),
            new Promise((resolve) =>
              window.setTimeout(() => resolve({ __bioStatusTimeout: true }), 15000),
            ),
          ]) as any;
          if (cancelled) return;
          if (r && r.__bioStatusTimeout) {
            setBioStatus(fallback);
            return;
          }
          if (r && r.ok) {
            const bio = unwrapExecutePayload(r);
            if (bio) setBioStatus(bio);
          }
        } catch (_) {
          if (!cancelled) setBioStatus(fallback);
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(defer);
    };
  }, [run]);

  const filteredApps = filterPrivacyRows(apps, appSearch, appFilter, (r) => `${r.name} ${r.icon || ''}`);
  const filteredSites = filterPrivacyRows(sites, siteSearch, siteFilter, (r) => `${r.host} ${r.label || ''}`);

  const [busyExport, setBusyExport] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [importConfirmOpen, setImportConfirmOpen] = useState(false);
  const [importConfirmText, setImportConfirmText] = useState('');

  const handleExport = React.useCallback(async () => {
    setBusyExport(true);
    try {
      const r = await run('memory.export', {}, { silentError: true });
      const d = r && r.data;
      if (r && r.ok && d && d.cancelled) {
        toast('Export cancelled', 'info');
      } else if (r && r.ok && d != null) {
        const filename = d.path ? String(d.path).split('/').pop() : 'memory.shogun-memory.jsonl';
        toast(`Exported ${d.exported} memories to ${filename}`, 'success');
      } else {
        toast((r && r.error && r.error.message) || 'Export failed', 'error');
      }
    } finally {
      setBusyExport(false);
    }
  }, [run, toast]);

  const handleImportConfirm = React.useCallback(async () => {
    setImportConfirmOpen(false);
    setImportConfirmText('');
    setBusyImport(true);
    try {
      const r = await run('memory.import', { confirm: IMPORT_CONFIRM_TOKEN }, { silentError: true });
      const d = r && r.data;
      if (r && r.ok && d && d.cancelled) {
        toast('Import cancelled', 'info');
      } else if (r && r.ok && d != null) {
        toast(`Imported ${d.imported} memories`, 'success');
      } else {
        toast((r && r.error && r.error.message) || 'Import failed', 'error');
      }
    } finally {
      setBusyImport(false);
    }
  }, [run, toast]);

  const learnMore = React.useCallback(async () => {
    if (PRODUCT.privacyUrl) {
      window.open(PRODUCT.privacyUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    await run('permissions.manage', { target: 'screen_capture' }, { silentError: true });
  }, [run]);

  const onPickApp = React.useCallback(async () => {
    const r = await run('privacy.pick_app', {}, { silentError: true });
    const p = unwrapExecutePayload(r);
    if (!r || !r.ok) {
      toast('アプリを選択できませんでした', 'warn');
      return;
    }
    if (!p || p.cancelled) return;
    const name = (p.name && String(p.name)) || 'App';
    const baseId = `bundle:${name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9.-]/g, '')}`;
    let id = baseId || 'bundle:app';
    let n = 0;
    while (apps.some((a) => a.id === id)) {
      n += 1;
      id = `${baseId}-${n}`;
    }
    const row = {
      id,
      name,
      icon: '📦',
      enabled: true,
      path: p.path ? String(p.path) : undefined,
    };
    const next = apps.concat([row]);
    setApps(next);
    await persistPrivacy(next, sites);
    toast(`除外リストに「${name}」を追加しました`, 'success');
  }, [apps, sites, persistPrivacy, run, toast]);

  const removeAppRow = React.useCallback(
    async (id: string) => {
      const next = apps.filter((a) => a.id !== id);
      setApps(next);
      await persistPrivacy(next, sites);
    },
    [apps, sites, persistPrivacy],
  );

  const addSiteRow = React.useCallback(async () => {
    let host = siteDraft.trim().toLowerCase();
    host = (host.replace(/^https?:\/\//i, '').split('/')[0] as string).trim();
    if (!host) {
      toast('ホスト名を入力してください', 'warn');
      return;
    }
    if (!/^[a-z0-9.-]+$/i.test(host)) {
      toast('有効なホスト名を入力してください', 'warn');
      return;
    }
    if (sites.some((s) => s.host === host)) {
      toast('そのサイトは既にあります', 'info');
      return;
    }
    const row = { id: `site:${host}`, host, label: host, enabled: true };
    const next = sites.concat([row]);
    setSites(next);
    setSiteDraft('');
    await persistPrivacy(apps, next);
  }, [apps, siteDraft, sites, persistPrivacy, toast]);

  const removeSiteRow = React.useCallback(
    async (id: string) => {
      const next = sites.filter((s) => s.id !== id);
      setSites(next);
      await persistPrivacy(apps, next);
    },
    [apps, sites, persistPrivacy],
  );

  const toggleApp = React.useCallback(
    async (id: string, enabled: boolean) => {
      const nextApps = apps.map((a) => (a.id === id ? { ...a, enabled } : a));
      setApps(nextApps);
      await persistPrivacy(nextApps, sites);
    },
    [apps, sites, persistPrivacy],
  );

  const toggleSite = React.useCallback(
    async (id: string, enabled: boolean) => {
      const nextSites = sites.map((s) => (s.id === id ? { ...s, enabled } : s));
      setSites(nextSites);
      await persistPrivacy(apps, nextSites);
    },
    [apps, sites, persistPrivacy],
  );

  return (
    <Pane
      title="Privacy Controls"
      jp="守秘"
      subtitle={
        <span>
          Control what SHOGUN can see. Excluded content won&apos;t appear in your context.{' '}
          <button
            type="button"
            className="s-link"
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              font: 'inherit',
              cursor: 'pointer',
              color: 'inherit',
            }}
            onClick={() => void learnMore()}
          >
            Learn more <Icon name="arrowUpRight" size={10} />
          </button>
        </span>
      }
    >
      <div className="s-field-hint" style={{ marginBottom: 14, padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', lineHeight: 1.55, fontSize: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Local-first · ローカルファースト</div>
        <div>Memory and ingested context stay in this app&apos;s data on this Mac. There is no SHOGUN cloud sync for the Memory index in this build. Chat / LLM and Clerk still send data to those services when you use them.</div>
        <div className="jp" style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)' }}>Memory と取り込んだコンテキストはこの Mac のアプリデータにのみ保存されます。Memory本体の SHOGUN クラウド同期はありません。Chat・LLM や Clerk 利用時は各サービスへ送信されます。</div>
        <div className="row" style={{ marginTop: 12, gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {PRODUCT.privacyUrl ? (
            <a className="s-link" href={PRODUCT.privacyUrl} target="_blank" rel="noopener noreferrer">
              Privacy summary <Icon name="arrowUpRight" size={10} />
            </a>
          ) : (
            <span className="s-field-hint" style={{ fontSize: 11 }}>
              Privacy: see <code style={{ fontSize: 10 }}>PRIVACY.md</code> with your license
            </span>
          )}
          {PRODUCT.termsJaUrl ? (
            <a className="s-link" href={PRODUCT.termsJaUrl} target="_blank" rel="noopener noreferrer">
              Terms / 利用規約 <Icon name="arrowUpRight" size={10} />
            </a>
          ) : (
            <span className="s-field-hint" style={{ fontSize: 11 }}>
              Terms: <code style={{ fontSize: 10 }}>TERMS_OF_SERVICE.md</code> / <code style={{ fontSize: 10 }}>TERMS_OF_SERVICE_EN.md</code>
            </span>
          )}
        </div>
      </div>
      <div className="s-card" style={{ marginBottom: 14 }}>
        <Row
          title={
            <span>
              <span className="en-only">Allow Memory assembly in Chat</span>
              <span className="jp">チャットでサーバ側の Memory 組み立てを許可</span>
            </span>
          }
          desc="When enabled, sending a chat message can trigger a local memory search on this Mac and attach hits as extra context (memoryAssembly). Text stays local; turn off if you want only pasted memoryContext or no automatic assembly."
          last
        >
          <Toggle
            on={allowServerMemoryAssembly}
            onClick={async () => {
              const next = !allowServerMemoryAssembly;
              setAllowServerMemoryAssembly(next);
              const r = await run(
                'settings.save',
                {
                  section: 'privacy',
                  allowChatServerMemoryAssembly: next,
                  excludedApps: apps,
                  excludedSites: sites,
                },
                {
                  silentError: true,
                  successMessage: next
                    ? 'チャットでの Memory 組み立てを許可しました'
                    : 'チャットでの Memory 組み立てをオフにしました',
                },
              );
              if (r && r.ok && refreshSections) await refreshSections();
              if (r && r.ok) notifyPrivacySettingsChanged({ allowChatServerMemoryAssembly: next });
            }}
          />
        </Row>
      </div>
      <div className="s-card" style={{ marginBottom: 14 }}>
        <Row
          title={<span><span className="en-only">Biometric app lock</span><span className="jp">生体認証でロック</span></span>}
          desc="Device-level protection (no cloud passkey): Touch ID or Face ID after launch and when returning from the background. Pair with Clerk sign-in above for account identity. Requires the Tauri desktop app on a supported Mac."
          last
        >
          <Toggle
            on={bioLock}
            onClick={async () => {
              const next = !bioLock;
              if (next) {
                const st = await run('auth.biometric.status', {}, { silentError: true });
                const d = unwrapExecutePayload(st);
                if (!d || !d.supported || !d.enrolled) {
                  toast(
                    'この環境では生体認証が使えません（デスクトップアプリと Touch ID 等の登録が必要です）。',
                    'warn',
                  );
                  return;
                }
              }
              setBioLock(next);
              const r = await run(
                'settings.save',
                {
                  section: 'security',
                  biometricLockEnabled: next,
                },
                { successMessage: next ? '生体ロックを有効にしました' : '生体ロックをオフにしました' },
              );
              if (r && r.ok && refreshSections) await refreshSections();
            }}
          />
        </Row>
        {bioStatus && (
          <div className="s-field-hint" style={{ marginTop: 10, padding: '0 16px 14px' }}>
            {bioStatus.platform === 'timeout'
              ? '生体認証の状態を取得できませんでした（タイムアウト）。アプリを再起動するか、しばらくしてから再度お試しください。'
              : bioStatus.stub
              ? 'ブラウザプレビュー: 実際の生体認証はデスクトップアプリで有効になります。'
              : !bioStatus.supported
                ? 'このプラットフォームでは LocalAuthentication が利用できません。'
                : !bioStatus.enrolled
                  ? '端末に生体情報が登録されていません。システム設定で Touch ID を設定してから有効にしてください。'
                  : `状態: 利用可能（${bioStatus.biometryType || 'biometry'}）`}
          </div>
        )}
      </div>
      <div className="s-field-hint" style={{ marginBottom: 10, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.45 }}>
        <span className="en-only">
          App / site rules are saved locally. On macOS, the capture sampler skips ingests when the frontmost app matches an excluded app, or when an AX snapshot / URL references an excluded site.
        </span>
        <span className="jp" style={{ display: 'block', marginTop: 4 }}>
          アプリ・サイトの除外はローカルに保存されます。macOS ではキャプチャ取り込みが、除外アプリが最前面のとき、または AX テキスト／URL が除外サイトに該当するときにスキップされます。
        </span>
      </div>
      <div className="s-card" style={{ marginBottom: 14 }}>
        <Row
          title="Payment screens"
          desc="Skip captures when the screen looks like a payment page (URL or card-shaped digits next to a CVV label)."
        >
          <Toggle
            on={paymentEnabled}
            onClick={async () => {
              const next = !paymentEnabled;
              setPaymentEnabled(next);
              await persistPrivacy(apps, sites, { paymentEnabled: next });
            }}
          />
        </Row>
        <Row
          title="Also detect card-number patterns"
          desc="Heuristic: 13–19 digit runs co-occurring with a CVV/CVC label. Disable if you see false positives."
          last
        >
          <Toggle
            on={paymentDetectCard}
            onClick={async () => {
              const next = !paymentDetectCard;
              setPaymentDetectCard(next);
              await persistPrivacy(apps, sites, { paymentDetectCard: next });
            }}
          />
        </Row>
        <div style={{ padding: '0 16px 14px' }}>
          <div className="s-field-hint" style={{ marginBottom: 8, fontSize: 11 }}>
            Payment domains (suffix-matched, e.g. <code>stripe.com</code> also covers <code>checkout.stripe.com</code>):
          </div>
          {paymentDomains.length === 0 ? (
            <div className="s-field-hint" style={{ padding: 8 }}>No domains.</div>
          ) : (
            <div className="s-card" style={{ marginBottom: 8 }}>
              {paymentDomains.map((d, i, arr) => (
                <div key={d.id} className={'s-row' + (i === arr.length - 1 ? ' last' : '')}>
                  <div style={{ flex: 1, fontSize: 13 }}>
                    <div style={{ fontWeight: 500 }}>{d.host}</div>
                    {d.label && d.label !== d.host ? (
                      <div className="s-field-hint" style={{ fontSize: 11 }}>{d.label}</div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ marginRight: 8 }}
                    title="Remove from list"
                    onClick={async () => {
                      const next = paymentDomains.filter((x) => x.id !== d.id);
                      setPaymentDomains(next);
                      await persistPrivacy(apps, sites, { paymentDomains: next });
                    }}
                  >
                    ×
                  </button>
                  <Toggle
                    on={d.enabled}
                    onClick={async () => {
                      const next = paymentDomains.map((x) =>
                        x.id === d.id ? { ...x, enabled: !x.enabled } : x,
                      );
                      setPaymentDomains(next);
                      await persistPrivacy(apps, sites, { paymentDomains: next });
                    }}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <input
              className="s-input"
              style={{ flex: 1 }}
              placeholder="e.g. checkout.example.com"
              value={paymentDraft}
              onChange={(e) => setPaymentDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void addPaymentDomain();
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => void addPaymentDomain()}
            >
              Add domain
            </button>
          </div>
        </div>
      </div>
      <div className="s-card" style={{ marginBottom: 14 }}>
        <Row
          title="Private browsing"
          desc="Skip captures when a supported browser's window is in incognito / private mode (detected from the window title)."
        >
          <Toggle
            on={incognitoEnabled}
            onClick={async () => {
              const next = !incognitoEnabled;
              setIncognitoEnabled(next);
              await persistPrivacy(apps, sites, { incognitoEnabled: next });
            }}
          />
        </Row>
        {[
          { key: 'safari', label: 'Safari (and Technology Preview)' },
          { key: 'chrome', label: 'Chrome / Chromium / Brave / Opera / Vivaldi' },
          { key: 'arc', label: 'Arc' },
          { key: 'firefox', label: 'Firefox (and Developer / Nightly)' },
          { key: 'edge', label: 'Microsoft Edge' },
        ].map((row, i, arr) => (
          <Row
            key={row.key}
            title={row.label}
            desc={`Match incognito titles for ${row.label}.`}
            last={i === arr.length - 1}
          >
            <Toggle
              on={!!(incognitoBrowsers as any)[row.key]}
              onClick={async () => {
                const next = { ...incognitoBrowsers, [row.key]: !(incognitoBrowsers as any)[row.key] };
                setIncognitoBrowsers(next);
                await persistPrivacy(apps, sites, { incognitoBrowsers: next });
              }}
            />
          </Row>
        ))}
      </div>
      <div className="s-card" style={{ marginBottom: 14, padding: '12px 16px 14px' }}>
        <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Quiet hours</div>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={async () => {
              const next = timeBlocks.concat([newQuietBlock()]);
              setTimeBlocks(next);
              await persistPrivacy(apps, sites, { timeBlocks: next });
            }}
          >
            + Add quiet block
          </button>
        </div>
        <div className="s-field-hint" style={{ marginBottom: 10, fontSize: 11 }}>
          Captures are skipped during these windows. Cross-midnight ranges (e.g. 22:00–07:00) are supported and applied based on the selected days.
        </div>
        {timeBlocks.length === 0 ? (
          <div className="s-field-hint" style={{ padding: 8 }}>No quiet blocks configured.</div>
        ) : (
          <div className="s-card">
            {timeBlocks.map((tb, i, arr) => (
              <div key={tb.id} className={'s-row' + (i === arr.length - 1 ? ' last' : '')} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <input
                    className="s-input"
                    style={{ flex: 1 }}
                    placeholder="Label (optional)"
                    value={tb.label}
                    onChange={(e) => {
                      const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, label: e.target.value } : x);
                      setTimeBlocks(next);
                      pendingTimeBlocksSaveRef.current = next;
                    }}
                    onBlur={async () => {
                      const next = pendingTimeBlocksSaveRef.current ?? timeBlocks;
                      pendingTimeBlocksSaveRef.current = null;
                      await persistPrivacy(apps, sites, { timeBlocks: next });
                    }}
                  />
                  <input
                    type="time"
                    className="s-input"
                    style={{ width: 110 }}
                    value={timeBlockMinutesToHHMM(tb.startMinute)}
                    onChange={async (e) => {
                      const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, startMinute: hhmmToMinutes(e.target.value) } : x);
                      setTimeBlocks(next);
                      await persistPrivacy(apps, sites, { timeBlocks: next });
                    }}
                  />
                  <span style={{ color: 'var(--text-dim)' }}>–</span>
                  <input
                    type="time"
                    className="s-input"
                    style={{ width: 110 }}
                    value={timeBlockMinutesToHHMM(tb.endMinute)}
                    onChange={async (e) => {
                      const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, endMinute: hhmmToMinutes(e.target.value) } : x);
                      setTimeBlocks(next);
                      await persistPrivacy(apps, sites, { timeBlocks: next });
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    title="Remove quiet block"
                    onClick={async () => {
                      const next = timeBlocks.filter((x) => x.id !== tb.id);
                      setTimeBlocks(next);
                      await persistPrivacy(apps, sites, { timeBlocks: next });
                    }}
                  >
                    ×
                  </button>
                  <Toggle
                    on={tb.enabled}
                    onClick={async () => {
                      const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, enabled: !x.enabled } : x);
                      setTimeBlocks(next);
                      await persistPrivacy(apps, sites, { timeBlocks: next });
                    }}
                  />
                </div>
                <div className="row" style={{ gap: 4, marginTop: 8 }}>
                  {DAY_LABELS.map((lbl, dayIdx) => {
                    const bit = 1 << dayIdx;
                    const on = (tb.days & bit) !== 0;
                    return (
                      <button
                        key={dayIdx}
                        type="button"
                        className="btn btn-sm"
                        aria-label={FULL_DAY_NAMES[dayIdx]}
                        aria-pressed={on}
                        style={{ minWidth: 28, height: 28, padding: 0, background: on ? 'var(--accent)' : 'var(--surface-2)', color: on ? 'var(--on-accent)' : 'inherit' }}
                        onClick={async () => {
                          const nextDays = on ? tb.days & ~bit : tb.days | bit;
                          const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, days: nextDays & 0x7F } : x);
                          setTimeBlocks(next);
                          await persistPrivacy(apps, sites, { timeBlocks: next });
                        }}
                      >
                        {lbl}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="row" style={{ gap: 4, background: 'var(--surface)', border: '1px solid var(--border)', padding: 3, borderRadius: 'var(--radius-md)', width: 'fit-content', marginBottom: 14 }}>
        <button
          type="button"
          className="btn btn-sm"
          style={{ background: tab === 'apps' ? 'var(--surface-2)' : 'transparent', borderColor: 'transparent' }}
          onClick={() => setTab('apps')}
        >
          Exclude Apps <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>{apps.length}</span>
        </button>
        <button
          type="button"
          className="btn btn-sm"
          style={{ background: tab === 'websites' ? 'var(--surface-2)' : 'transparent', borderColor: tab === 'websites' ? 'transparent' : undefined }}
          onClick={() => setTab('websites')}
        >
          Exclude Websites <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>{sites.length}</span>
        </button>
      </div>
      <div className="row" style={{ gap: 10, marginBottom: 10 }}>
        <input
          className="s-input"
          placeholder={tab === 'apps' ? 'Search applications…' : 'Search sites…'}
          style={{ flex: 1 }}
          value={tab === 'apps' ? appSearch : siteSearch}
          onChange={(e) => (tab === 'apps' ? setAppSearch(e.target.value) : setSiteSearch(e.target.value))}
        />
        <select
          className="s-select"
          value={tab === 'apps' ? appFilter : siteFilter}
          onChange={(e) => (tab === 'apps' ? setAppFilter(e.target.value) : setSiteFilter(e.target.value))}
        >
          <option value="all">All</option>
          <option value="on">Excluded (on)</option>
          <option value="off">Included (off)</option>
        </select>
      </div>
      {tab === 'apps' ? (
        <div className="s-card">
          {filteredApps.length === 0 ? (
            <div className="s-field-hint" style={{ padding: 16 }}>No applications match this search.</div>
          ) : (
            filteredApps.map((a, i, arr) => (
              <div key={a.id} className={'s-row' + (i === arr.length - 1 ? ' last' : '')}>
                <div style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, marginRight: 12 }}>{a.icon}</div>
                <div style={{ flex: 1, fontSize: 13 }}>
                  {a.name}
                  {a.path ? (
                    <div className="s-field-hint" style={{ fontSize: 10, marginTop: 2 }}>{a.path}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  style={{ marginRight: 8 }}
                  title="Remove from list"
                  onClick={() => void removeAppRow(a.id)}
                >
                  ×
                </button>
                <Toggle
                  on={a.enabled}
                  onClick={() => void toggleApp(a.id, !a.enabled)}
                />
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          <div className="s-card">
            {filteredSites.length === 0 ? (
              <div className="s-field-hint" style={{ padding: 16 }}>No sites match this search.</div>
            ) : (
              filteredSites.map((s, i, arr) => (
                <div key={s.id} className={'s-row' + (i === arr.length - 1 ? ' last' : '')}>
                  <div style={{ flex: 1, fontSize: 13 }}>
                    <div style={{ fontWeight: 500 }}>{s.host}</div>
                    {s.label && s.label !== s.host ? (
                      <div className="s-field-hint" style={{ fontSize: 11 }}>{s.label}</div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ marginRight: 8 }}
                    title="Remove from list"
                    onClick={() => void removeSiteRow(s.id)}
                  >
                    ×
                  </button>
                  <Toggle on={s.enabled} onClick={() => void toggleSite(s.id, !s.enabled)} />
                </div>
              ))
            )}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <input
              className="s-input"
              style={{ flex: 1 }}
              placeholder="e.g. bank.example.com"
              value={siteDraft}
              onChange={(e) => setSiteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void addSiteRow();
                }
              }}
            />
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => void addSiteRow()}>
              Add site
            </button>
          </div>
        </>
      )}
      {tab === 'apps' ? (
        <div className="s-field-hint" style={{ marginTop: 14, textAlign: 'center' }}>
          Can&apos;t find your app?{' '}
          <button
            type="button"
            className="s-link"
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              font: 'inherit',
              cursor: 'pointer',
              color: 'inherit',
            }}
            onClick={() => void onPickApp()}
          >
            Select .app manually…
          </button>
          <span className="jp" style={{ display: 'block', fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
            macOS アプリではフォルダから .app を選べます（ブラウザではキャンセル扱い）。
          </span>
        </div>
      ) : null}

      {/* Memory data export / import */}
      <div className="s-card" style={{ marginTop: 14 }}>
        <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Memory data</div>
        </div>
        <div className="s-field-hint" style={{ marginBottom: 10, fontSize: 12 }}>
          Export your memories to a file you control, or import a previously-exported file.
          <span className="jp" style={{ display: 'block', fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
            Memory データをファイルにエクスポート、または以前のエクスポートをインポートできます。
          </span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleExport}
            disabled={busyExport}
          >
            {busyExport ? 'Exporting…' : 'Export memory…'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => { setImportConfirmOpen(true); setImportConfirmText(''); }}
            disabled={busyImport}
          >
            {busyImport ? 'Importing…' : 'Import memory…'}
          </button>
        </div>
      </div>

      {/* Import REPLACE confirmation overlay */}
      {importConfirmOpen ? (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 1200,
            background: 'rgba(10,9,8,0.65)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setImportConfirmOpen(false); setImportConfirmText(''); } }}
        >
          <div
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)', padding: 24, maxWidth: 400, width: '90%',
              boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>Import memory — confirm</div>
            <div className="s-field-hint" style={{ fontSize: 12, marginBottom: 14, lineHeight: 1.55 }}>
              This will <strong>delete all existing memories</strong> and replace them with the contents of the selected file.
              This action cannot be undone.
            </div>
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              Type <code>{IMPORT_CONFIRM_TOKEN}</code> to confirm:
            </div>
            <input
              className="s-input"
              style={{ width: '100%', marginBottom: 14, boxSizing: 'border-box' }}
              placeholder={IMPORT_CONFIRM_TOKEN}
              value={importConfirmText}
              onChange={(e) => setImportConfirmText(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label={`Type ${IMPORT_CONFIRM_TOKEN} to confirm`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && importConfirmText === IMPORT_CONFIRM_TOKEN) {
                  void handleImportConfirm();
                }
                if (e.key === 'Escape') {
                  setImportConfirmOpen(false);
                  setImportConfirmText('');
                }
              }}
            />
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => { setImportConfirmOpen(false); setImportConfirmText(''); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger-ghost"
                disabled={importConfirmText !== IMPORT_CONFIRM_TOKEN}
                onClick={() => void handleImportConfirm()}
              >
                Replace memories
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Pane>
  );
}
