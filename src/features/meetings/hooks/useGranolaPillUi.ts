import { useCallback, useMemo, useState, type MouseEvent } from 'react';
import { toastM } from '../lib/runtime';
import { t } from '@/shared/lib/i18n';

export function useGranolaPillUi(): {
  granolaPillMenu: { kind: string; anchor: { left: number; top: number; width: number } } | null;
  granolaAttendees: string[];
  granolaAttendeesQuery: string;
  setGranolaAttendeesQuery: (v: string) => void;
  granolaFolder: string;
  granolaFolderQuery: string;
  setGranolaFolderQuery: (v: string) => void;
  granolaFolderList: string[];
  granolaDateFull: { en: string; jp: string; t: string };
  closeGranolaPillMenu: () => void;
  addFolderTag: (ev: MouseEvent) => void;
  addCalendarEvent: () => void;
  showGranolaDateInfo: (ev: MouseEvent) => void;
  showGranolaAuthorInfo: (ev: MouseEvent) => void;
  toggleAttendee: (name: string) => void;
  pickFolder: (name: string) => void;
  addNewFolder: () => void;
} {
  const [granolaPillMenu, setGranolaPillMenu] = useState<{
    kind: string;
    anchor: { left: number; top: number; width: number };
  } | null>(null);
  const [granolaAttendees, setGranolaAttendees] = useState<string[]>(['Toru Tano']);
  const [granolaAttendeesQuery, setGranolaAttendeesQuery] = useState('');
  const [granolaFolder, setGranolaFolder] = useState('My notes');
  const [granolaFolderQuery, setGranolaFolderQuery] = useState('');
  const [granolaFolderList, setGranolaFolderList] = useState<string[]>(['My notes', 'Toru team']);

  const openGranolaPillMenu = useCallback((kind: string, evt: MouseEvent) => {
    try {
      const el = evt.currentTarget as HTMLElement | null;
      if (!el) {
        setGranolaPillMenu({ kind, anchor: { left: 80, top: 80, width: 260 } });
        return;
      }
      const r = el.getBoundingClientRect();
      setGranolaPillMenu({
        kind,
        anchor: { left: r.left, top: r.bottom + 6, width: Math.max(260, Math.round(r.width)) },
      });
    } catch {
      setGranolaPillMenu({ kind, anchor: { left: 80, top: 80, width: 260 } });
    }
  }, []);

  const closeGranolaPillMenu = useCallback(() => setGranolaPillMenu(null), []);

  const addFolderTag = useCallback((ev: MouseEvent) => {
    openGranolaPillMenu('folder', ev);
  }, [openGranolaPillMenu]);

  const addCalendarEvent = useCallback(() => {
    toastM(t('Linking calendar events can be enabled in Settings (mock)', 'カレンダーイベントのリンクは設定から有効化できます（モック）'), 'info');
  }, []);

  const showGranolaDateInfo = useCallback((ev: MouseEvent) => {
    openGranolaPillMenu('date', ev);
  }, [openGranolaPillMenu]);

  const showGranolaAuthorInfo = useCallback((ev: MouseEvent) => {
    openGranolaPillMenu('attendees', ev);
  }, [openGranolaPillMenu]);

  const granolaDateFull = useMemo(() => {
    try {
      const d = new Date();
      const en = d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' });
      const jp = d.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
      const t = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      return { en, jp, t };
    } catch {
      return { en: 'Today', jp: '本日', t: '--:--' };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh when menu opens
  }, [granolaPillMenu]);

  const toggleAttendee = useCallback((name: string) => {
    setGranolaAttendees((list) => (
      list.indexOf(name) >= 0 ? list.filter((n) => n !== name) : list.concat([name])
    ));
  }, []);

  const pickFolder = useCallback((name: string) => {
    setGranolaFolder(name);
    toastM(`Folder: ${name}`, 'success');
    setGranolaPillMenu(null);
  }, []);

  const addNewFolder = useCallback(() => {
    const base = (granolaFolderQuery || '').trim();
    if (!base) {
      toastM(t('Enter a name for the new folder', '新しいフォルダ名を入力してください'), 'info');
      return;
    }
    setGranolaFolderList((list) => (list.indexOf(base) >= 0 ? list : list.concat([base])));
    setGranolaFolder(base);
    toastM(t(`Folder created: ${base}`, `フォルダを作成しました: ${base}`), 'success');
    setGranolaFolderQuery('');
    setGranolaPillMenu(null);
  }, [granolaFolderQuery]);

  return {
    granolaPillMenu,
    granolaAttendees,
    granolaAttendeesQuery,
    setGranolaAttendeesQuery,
    granolaFolder,
    granolaFolderQuery,
    setGranolaFolderQuery,
    granolaFolderList,
    granolaDateFull,
    closeGranolaPillMenu,
    addFolderTag,
    addCalendarEvent,
    showGranolaDateInfo,
    showGranolaAuthorInfo,
    toggleAttendee,
    pickFolder,
    addNewFolder,
  };
}
