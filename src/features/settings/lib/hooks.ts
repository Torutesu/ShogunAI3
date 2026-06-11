import React from 'react';
import { SettingsHydrationContext } from '../types';

export interface UseSettingsSectionOptions<T> {
  section: string;
  fromSections: (sections: Record<string, any>) => T | null;
  toPayload: (state: T) => Record<string, unknown>;
  onSaved?: (result: { ok: boolean; state: T }) => void | Promise<void>;
}

/** Hydrate local state from SettingsHydrationContext and persist via settings.save. */
export function useSettingsSection<T extends Record<string, unknown>>(
  options: UseSettingsSectionOptions<T>,
  initial: T,
): [T, React.Dispatch<React.SetStateAction<T>>, (patch?: Partial<T>) => Promise<void>] {
  const { run } = useRuntimeActions();
  const { sections, refreshSections } = React.useContext(SettingsHydrationContext);
  const [state, setState] = React.useState<T>(initial);

  const section = options.section;
  const fromSections = options.fromSections;
  const toPayload = options.toPayload;
  const onSaved = options.onSaved;

  React.useEffect(() => {
    const slice = fromSections(sections);
    if (slice) setState((prev) => ({ ...prev, ...slice }));
  }, [sections, fromSections]);

  const save = React.useCallback(
    async (patch?: Partial<T>) => {
      const next = patch ? { ...state, ...patch } : state;
      if (patch) setState(next);
      const r = await run(
        'settings.save',
        { section, ...toPayload(next) },
        { silentError: true },
      );
      if (r?.ok && refreshSections) await refreshSections();
      if (onSaved) await onSaved({ ok: !!r?.ok, state: next });
    },
    [run, refreshSections, state, section, toPayload, onSaved],
  );

  return [state, setState, save];
}

export function useRuntimeActions() {
  const run = React.useCallback(async (key: string, payload?: any, options?: any) => {
    if (!( window as any).SHOGUN_RUNTIME || !(window as any).SHOGUN_RUNTIME.executeAction) return { ok: false };
    return (window as any).SHOGUN_RUNTIME.executeAction(key, payload, options || {});
  }, []);
  const confirmWrite = React.useCallback((key: string, payload: any, title: string, description: string) => {
    if (!(window as any).SHOGUN_RUNTIME || !(window as any).SHOGUN_RUNTIME.requestWriteAction) return;
    (window as any).SHOGUN_RUNTIME.requestWriteAction(key, payload, title, description);
  }, []);
  const toast = React.useCallback((message: string, kind?: string) => {
    if ((window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.pushToast) {
      (window as any).SHOGUN_RUNTIME.pushToast(message, kind || 'info');
    }
  }, []);
  return { run, confirmWrite, toast };
}
