// AxPermissionBanner — surfaces the desktop `shogun-capture-ax-not-trusted`
// Tauri event as a top-of-app banner with a CTA that opens macOS
// System Settings → Privacy & Security → Accessibility.
//
// Backend emitter: src-tauri/src/capture_sampler.rs::maybe_warn_ax_not_trusted
// Event payload: { message: string }
//
// Dismissal is persisted in localStorage under DISMISSED_AT_LS as an ISO
// timestamp. The banner stays hidden for DISMISS_TTL_MS after dismissal
// (re-shows after 24h).
import { useEffect, useMemo, useState } from 'react';

export const DISMISSED_AT_LS = 'shogun.ax-permission-banner.dismissed-at';
export const DISMISS_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const DEFAULT_MESSAGE = 'Accessibility permission needed for screen capture';
const JP_MESSAGE = 'アクセシビリティ権限が必要です — キャプチャ機能の精度向上のため';

type Win = typeof window & {
  __TAURI_INTERNALS__?: unknown;
};

function readDismissedAt(): number | null {
  try {
    const raw = localStorage.getItem(DISMISSED_AT_LS);
    if (!raw) return null;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  } catch (_) {
    return null;
  }
}

function isDismissalActive(now: number = Date.now()): boolean {
  const at = readDismissedAt();
  if (at == null) return false;
  return now - at < DISMISS_TTL_MS;
}

async function openAccessibilitySettings(): Promise<void> {
  try {
    const w = (typeof window !== 'undefined' ? (window as Win) : undefined);
    if (!w || !w.__TAURI_INTERNALS__) return;
    // @ts-ignore — @tauri-apps/api is only resolvable in the desktop build
    const mod: any = await import('@tauri-apps/api/core').catch(() => null);
    if (!mod || typeof mod.invoke !== 'function') return;
    // Existing Rust command accepts a `target` field (see src-tauri/src/commands.rs).
    // `accessibility` opens the Accessibility privacy pane; anything else falls back to Screen Recording.
    await mod.invoke('app_permissions_manage', { payload: { target: 'accessibility', source: 'ax_permission_banner' } });
  } catch (_) {
    /* ignore — best-effort; user can still open System Settings manually */
  }
}

export interface AxPermissionBannerProps {
  /** Test hook — when true, the banner is rendered regardless of event/dismissal state. */
  forceVisible?: boolean;
  /** Test hook — override the grant-permission action (defaults to invoking the Tauri command). */
  onGrant?: () => void | Promise<void>;
  /** Test hook — observe dismissal (called after localStorage write). */
  onDismiss?: () => void;
}

export function AxPermissionBanner({ forceVisible, onGrant, onDismiss }: AxPermissionBannerProps) {
  const initialDismissed = useMemo(() => isDismissalActive(), []);
  const [visible, setVisible] = useState<boolean>(false);
  const [message, setMessage] = useState<string>(DEFAULT_MESSAGE);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const w = (typeof window !== 'undefined' ? (window as Win) : undefined);
    if (w && w.__TAURI_INTERNALS__) {
      // @ts-ignore — desktop-only module
      import('@tauri-apps/api/event').then((mod: any) => {
        if (cancelled) return;
        mod
          .listen('shogun-capture-ax-not-trusted', (event: any) => {
            // Respect an active dismissal — if the user dismissed within the
            // last 24h we suppress the banner even if the backend re-emits.
            if (isDismissalActive()) return;
            const msg = String((event && event.payload && event.payload.message) || DEFAULT_MESSAGE);
            setMessage(msg);
            setVisible(true);
          })
          .then((un: () => void) => {
            if (cancelled) {
              try { un(); } catch (_) { /* ignore */ }
              return;
            }
            unlisten = un;
          })
          .catch(() => { /* ignore */ });
      }).catch(() => { /* ignore — non-Tauri build */ });
    }
    return () => {
      cancelled = true;
      if (unlisten) {
        try { unlisten(); } catch (_) { /* ignore */ }
      }
    };
  }, []);

  const shouldRender = forceVisible || (visible && !initialDismissed);
  if (!shouldRender) return null;

  const handleGrant = () => {
    if (onGrant) {
      void onGrant();
      return;
    }
    void openAccessibilitySettings();
  };

  const handleDismiss = () => {
    try {
      localStorage.setItem(DISMISSED_AT_LS, new Date().toISOString());
    } catch (_) {
      /* ignore — best-effort persistence */
    }
    setVisible(false);
    if (onDismiss) onDismiss();
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="ax-permission-banner"
      data-testid="ax-permission-banner"
      style={{
        gridColumn: '1 / -1',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        background: 'var(--warning-bg, rgba(200,169,110,0.10))',
        borderBottom: '1px solid var(--border)',
        color: 'var(--text)',
        fontSize: 13,
        zIndex: 3,
      }}
    >
      <span
        aria-hidden="true"
        className="ax-permission-banner__icon"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          borderRadius: '50%',
          border: '1.5px solid var(--danger)',
          color: 'var(--danger)',
          fontSize: 12,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        !
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span style={{ color: 'var(--text)' }}>{message || DEFAULT_MESSAGE}</span>
        <span
          className="jp"
          style={{ color: 'var(--text-dim)', fontSize: 12, fontFamily: 'var(--font-jp)', fontWeight: 300 }}
        >
          {JP_MESSAGE}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexShrink: 0 }}>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={handleGrant}
          data-testid="ax-permission-banner__grant"
        >
          Grant Permission
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={handleDismiss}
          data-testid="ax-permission-banner__dismiss"
          aria-label="Dismiss accessibility permission banner"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export default AxPermissionBanner;
