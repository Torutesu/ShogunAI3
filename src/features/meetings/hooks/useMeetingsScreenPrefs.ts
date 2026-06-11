import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';

/** Mirrors meetings + privacy prefs used on the meetings screen. */
export function useMeetingsScreenPrefs(): {
  allowServerMemoryAssembly: boolean;
  autoStartOnCalendar: boolean;
  autoStartOnCalendarRef: MutableRefObject<boolean>;
} {
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = useState(true);
  const [autoStartOnCalendar, setAutoStartOnCalendar] = useState(false);
  const autoStartOnCalendarRef = useRef(false);
  autoStartOnCalendarRef.current = autoStartOnCalendar;

  useEffect(() => {
    let cancelled = false;
    function applyMeetingSettings(r: { ok?: boolean; data?: { settings?: { sections?: Record<string, unknown> } } }) {
      if (cancelled || !r?.ok || !r.data?.settings?.sections) return;
      const priv = r.data.settings.sections.privacy;
      if (priv && typeof priv === 'object') {
        const row = priv as Record<string, unknown>;
        setAllowServerMemoryAssembly(row.allowChatServerMemoryAssembly !== false);
      }
      const mtg = r.data.settings.sections.meetings;
      if (mtg && typeof mtg === 'object') {
        const row = mtg as Record<string, unknown>;
        if (typeof row.autoStartOnCalendar === 'boolean') {
          setAutoStartOnCalendar(row.autoStartOnCalendar);
        } else if (typeof row.autoRecord === 'boolean') {
          setAutoStartOnCalendar(row.autoRecord);
        } else {
          setAutoStartOnCalendar(false);
        }
      }
    }
    runRuntimeAction('settings.load', {}, { silentError: true }).then(applyMeetingSettings);
    function onSettingsRefresh() {
      runRuntimeAction('settings.load', {}, { silentError: true }).then(applyMeetingSettings);
    }
    window.addEventListener('shogun-settings-refresh', onSettingsRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener('shogun-settings-refresh', onSettingsRefresh);
    };
  }, []);

  useEffect(() => {
    function onPrivacy() {
      runRuntimeAction('settings.load', {}, { silentError: true }).then((r) => {
        const priv = r?.ok && r.data?.settings?.sections?.privacy;
        if (priv && typeof priv === 'object') {
          const row = priv as Record<string, unknown>;
          setAllowServerMemoryAssembly(row.allowChatServerMemoryAssembly !== false);
        }
      });
    }
    window.addEventListener('shogun-privacy-settings-changed', onPrivacy);
    return () => window.removeEventListener('shogun-privacy-settings-changed', onPrivacy);
  }, []);

  return { allowServerMemoryAssembly, autoStartOnCalendar, autoStartOnCalendarRef };
}
