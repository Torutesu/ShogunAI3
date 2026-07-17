import { useCallback, useEffect, useState, type MutableRefObject } from 'react';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { toastM } from '../lib/runtime';
import { t } from '@/shared/lib/i18n';

type ShareOwner = { displayName: string; email: string };

type GranolaDraft = {
  body?: string;
  transcript?: string;
  summary?: string;
  minutes?: string;
};

export function useMeetingsShareControls(params: {
  granola: { storageKey?: string; title?: string; authorLabel?: string } | null;
  granolaDraft: GranolaDraft;
  granolaRef: MutableRefObject<{ authorLabel?: string } | null>;
}) {
  const { granola, granolaDraft, granolaRef } = params;

  const [mtgTopShareOpen, setMtgTopShareOpen] = useState(false);
  const [mtgLinkAccess, setMtgLinkAccess] = useState('anyone');
  const [mtgShareSearch, setMtgShareSearch] = useState('');
  const [mtgShareOwner, setMtgShareOwner] = useState<ShareOwner>({ displayName: '', email: '' });
  const [mtgLinkBusy, setMtgLinkBusy] = useState(false);
  const [mtgLinkAccessMenuOpen, setMtgLinkAccessMenuOpen] = useState(false);

  const granolaStorageKey = granola && granola.storageKey;

  useEffect(function resetShareOnNoteChange() {
    setMtgTopShareOpen(false);
    setMtgShareSearch('');
    setMtgLinkAccessMenuOpen(false);
    setMtgLinkAccess('anyone');
  }, [granolaStorageKey]);

  useEffect(function loadShareOwner() {
    if (!mtgTopShareOpen) return;
    void runRuntimeAction('auth.status', {}, { silentError: true }).then(function (r) {
      const snap = r && r.ok && r.data && r.data.snapshot;
      const g = granolaRef.current;
      if (snap && (snap.displayName || snap.primaryEmail)) {
        setMtgShareOwner({
          displayName: snap.displayName || 'You',
          email: snap.primaryEmail || '',
        });
      } else {
        setMtgShareOwner({
          displayName: g && g.authorLabel ? g.authorLabel : 'You',
          email: '',
        });
      }
    });
  }, [mtgTopShareOpen, granolaRef]);

  const buildMtgShareMarkdown = useCallback(function () {
    if (!granola) return '';
    const title = granola.title || 'Meeting';
    return [
      '# ' + title,
      '',
      '## Notes',
      granolaDraft.body || '',
      '',
      '## Transcript',
      granolaDraft.transcript || '',
      '',
      '## Summary',
      granolaDraft.summary || '',
      '',
      '## Minutes',
      granolaDraft.minutes || '',
    ].join('\n');
  }, [granola, granolaDraft]);

  const copyMtgShareLink = useCallback(async function () {
    if (!granola || !granola.storageKey) return;
    setMtgLinkBusy(true);
    try {
      const mode = mtgLinkAccess === 'anyone' ? 'public' : 'private';
      const res = await runRuntimeAction(
        'app.create_share_link',
        {
          resourceType: 'meeting_note',
          storageKey: granola.storageKey,
          title: granola.title,
          mode,
          markdown: buildMtgShareMarkdown().slice(0, 120000),
        },
        { silentError: true },
      );
      let url = res && res.ok && res.data && res.data.url;
      if (!url && typeof window !== 'undefined' && window.location) {
        url = window.location.origin + '/meetings?note=' + encodeURIComponent(granola.storageKey);
      }
      if (url && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      }
      const sub =
        mtgLinkAccess === 'anyone'
          ? 'Anyone with the link can view'
          : 'Restricted link — recipients need access';
      toastM('Link copied\n' + sub, 'success');
    } catch (_e) {
      toastM(t('Copy failed', 'コピーに失敗しました'), 'warn');
    } finally {
      setMtgLinkBusy(false);
    }
  }, [granola, mtgLinkAccess, buildMtgShareMarkdown]);

  return {
    mtgTopShareOpen,
    setMtgTopShareOpen,
    mtgLinkAccess,
    setMtgLinkAccess,
    mtgShareSearch,
    setMtgShareSearch,
    mtgShareOwner,
    mtgLinkBusy,
    mtgLinkAccessMenuOpen,
    setMtgLinkAccessMenuOpen,
    copyMtgShareLink,
  };
}
