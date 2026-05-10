import React, { useState } from 'react';
import * as ReactDOM from 'react-dom';
import { Icon } from '@/shared/icons';
import { Pane } from '../components/Pane';
import { Row } from '../components/Row';
import { useRuntimeActions } from '../lib/hooks';

export function PaneData() {
  const { run, confirmWrite, toast } = useRuntimeActions();
  const [deadLetter, setDeadLetter] = useState({ total: 0, bySource: {} as Record<string, number>, busy: false });
  const [dlDetail, setDlDetail] = useState<any>(null);
  const refreshDeadLetter = React.useCallback(async () => {
    const res = await run('dead_letter.list', { limit: 1 }, { silentError: true });
    if (res && res.ok && res.data && res.data.counts) {
      const c = res.data.counts;
      setDeadLetter((prev) => ({
        ...prev,
        total: Number(c.total) || 0,
        bySource: c.bySource && typeof c.bySource === 'object' ? c.bySource : {},
      }));
    }
  }, [run]);
  React.useEffect(() => { void refreshDeadLetter(); }, [refreshDeadLetter]);
  const onRetryDeadLetter = React.useCallback(async () => {
    setDeadLetter((prev) => ({ ...prev, busy: true }));
    const res = await run('dead_letter.retry', { limit: 500 }, { silentError: true });
    if (res && res.ok && res.data) {
      const ok = Number(res.data.succeeded) || 0;
      const bad = Number(res.data.failed) || 0;
      toast(
        bad > 0
          ? `Retried: ${ok} succeeded, ${bad} still failing`
          : `Retried ${ok} item(s) successfully`,
        bad > 0 ? 'warn' : 'success',
      );
    } else {
      toast((res && res.error && res.error.message) || 'Retry failed', 'error');
    }
    await refreshDeadLetter();
    setDeadLetter((prev) => ({ ...prev, busy: false }));
  }, [run, toast, refreshDeadLetter]);
  const openDeadLetterDetail = React.useCallback(async (sourceFilter: string) => {
    setDlDetail({ open: true, items: [], sourceFilter: sourceFilter || '', loading: true, busyId: null });
    const res = await run(
      'dead_letter.list',
      sourceFilter ? { limit: 200, source: sourceFilter } : { limit: 200 },
      { silentError: true },
    );
    const items = res && res.ok && Array.isArray(res.data && res.data.items) ? res.data.items : [];
    setDlDetail((prev: any) => (prev ? { ...prev, items, loading: false } : prev));
  }, [run]);
  const reloadDeadLetterDetail = React.useCallback(async () => {
    setDlDetail((prev: any) => (prev ? { ...prev, loading: true } : prev));
    const filter = (dlDetail && dlDetail.sourceFilter) || '';
    const res = await run(
      'dead_letter.list',
      filter ? { limit: 200, source: filter } : { limit: 200 },
      { silentError: true },
    );
    const items = res && res.ok && Array.isArray(res.data && res.data.items) ? res.data.items : [];
    setDlDetail((prev: any) => (prev ? { ...prev, items, loading: false } : prev));
    await refreshDeadLetter();
  }, [dlDetail, run, refreshDeadLetter]);
  const retryDeadLetterRow = React.useCallback(async (id: number) => {
    setDlDetail((prev: any) => (prev ? { ...prev, busyId: id } : prev));
    const res = await run('dead_letter.retry_one', { id }, { silentError: true });
    if (res && res.ok && res.data && res.data.succeeded) {
      toast('Item retried successfully', 'success');
    } else {
      const msg = (res && res.data && res.data.error)
        || (res && res.error && res.error.message)
        || 'Retry failed';
      toast(msg, 'warn');
    }
    await reloadDeadLetterDetail();
    setDlDetail((prev: any) => (prev ? { ...prev, busyId: null } : prev));
  }, [run, toast, reloadDeadLetterDetail]);
  const deleteDeadLetterRow = React.useCallback(async (id: number) => {
    setDlDetail((prev: any) => (prev ? { ...prev, busyId: id } : prev));
    const res = await run('dead_letter.delete', { id }, { silentError: true });
    if (res && res.ok) {
      toast('Item removed', 'success');
    } else {
      toast((res && res.error && res.error.message) || 'Delete failed', 'error');
    }
    await reloadDeadLetterDetail();
    setDlDetail((prev: any) => (prev ? { ...prev, busyId: null } : prev));
  }, [run, toast, reloadDeadLetterDetail]);
  const onClearDeadLetter = React.useCallback(async () => {
    if (!(typeof window.confirm === 'function' && window.confirm('Clear the failed-ingest queue? Items cannot be recovered.'))) return;
    setDeadLetter((prev) => ({ ...prev, busy: true }));
    const res = await run('dead_letter.clear', {}, { silentError: true });
    if (res && res.ok) {
      const n = (res.data && res.data.removed) || 0;
      toast(`Cleared ${n} item(s)`, 'success');
    } else {
      toast((res && res.error && res.error.message) || 'Clear failed', 'error');
    }
    await refreshDeadLetter();
    setDeadLetter((prev) => ({ ...prev, busy: false }));
  }, [run, toast, refreshDeadLetter]);
  const onExport = React.useCallback(async () => {
    const res = await run('settings.export', {}, { silentError: true });
    if (res && res.ok) {
      if (res.data && res.data.cancelled) return;
      const p = (res.data && res.data.path) || '';
      toast(p ? `Exported to ${p}` : 'Settings exported', 'success');
    } else {
      const msg = (res && res.error && res.error.message) || 'Export failed';
      toast(msg, 'error');
    }
  }, [run, toast]);
  const onImport = React.useCallback(async () => {
    const ok = typeof window.confirm === 'function'
      ? window.confirm('Import settings from file? Existing sections in the backup will be replaced.')
      : true;
    if (!ok) return;
    const res = await run('settings.import', {}, { silentError: true });
    if (res && res.ok) {
      if (res.data && res.data.cancelled) return;
      const n = (res.data && res.data.sections) || 0;
      toast(`Imported ${n} section(s). Reload the app to see all changes.`, 'success');
    } else {
      const msg = (res && res.error && res.error.message) || 'Import failed';
      toast(msg, 'error');
    }
  }, [run, toast]);
  return (
    <Pane
      title="Data Controls"
      jp="資料"
      subtitle={
        <span style={{ display: 'block', lineHeight: 1.45 }}>
          All actions below apply to local data on this Mac.
          <span className="jp" style={{ display: 'block', fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
            以下はこの Mac に保存されたローカルデータに対する操作です。
          </span>
        </span>
      }
    >
      <div className="s-field-label">Backup & Restore</div>
      <div className="s-card">
        <Row
          title="Export settings"
          desc="Save all app settings (integrations toggles, workspaces, preferences) as a JSON file. Credentials and memory data are NOT included."
        >
          <button className="btn btn-sm btn-secondary" onClick={onExport}>Export…</button>
        </Row>
        <Row
          title="Import settings"
          desc="Restore settings from a previously exported JSON file. Existing sections in the backup will replace current values."
          last
        >
          <button className="btn btn-sm btn-secondary" onClick={onImport}>Import…</button>
        </Row>
      </div>

      <div className="s-field-label" style={{ marginTop: 22 }}>Failed Ingests</div>
      <div className="s-card">
        <Row
          title={
            <span>
              {deadLetter.total > 0
                ? `${deadLetter.total} item${deadLetter.total === 1 ? '' : 's'} pending retry`
                : 'No failed ingests'}
              {deadLetter.total > 0 && (
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-dim)', marginTop: 4, fontWeight: 400 }}>
                  By source:{' '}
                  {Object.entries(deadLetter.bySource || {})
                    .map(([s, n]) => `${s} ${n}`)
                    .join(' · ')}
                </span>
              )}
            </span>
          }
          desc="Items that failed to ingest during a connector sync. Retry replays each through the normal ingest path; succeeded rows are removed from the queue."
          last
        >
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => openDeadLetterDetail('')}
            disabled={deadLetter.busy || deadLetter.total === 0}
            style={(deadLetter.busy || deadLetter.total === 0) ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
          >
            Details…
          </button>
          <button
            className="btn btn-sm btn-secondary"
            onClick={onRetryDeadLetter}
            disabled={deadLetter.busy || deadLetter.total === 0}
            style={(deadLetter.busy || deadLetter.total === 0) ? { opacity: 0.5, cursor: 'not-allowed', marginLeft: 6 } : { marginLeft: 6 }}
          >
            {deadLetter.busy ? 'Retrying…' : 'Retry all'}
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={onClearDeadLetter}
            disabled={deadLetter.busy || deadLetter.total === 0}
            style={(deadLetter.busy || deadLetter.total === 0) ? { opacity: 0.5, cursor: 'not-allowed', marginLeft: 6 } : { marginLeft: 6 }}
          >
            Clear
          </button>
        </Row>
      </div>

      {dlDetail && dlDetail.open && ReactDOM.createPortal(
        (() => {
          const sources = ['', ...Object.keys(deadLetter.bySource || {})];
          const fmtTime = (ms: any) => {
            try { return new Date(Number(ms) || 0).toLocaleString(); } catch (_) { return ''; }
          };
          const close = () => setDlDetail(null);
          return (
            <div
              style={{
                position: 'fixed', inset: 0, zIndex: 1097,
                background: 'color-mix(in srgb, var(--bg) 78%, transparent)',
                backdropFilter: 'blur(4px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 20,
              }}
              onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
            >
              <div
                role="dialog"
                aria-modal="true"
                style={{
                  width: 'min(820px, 100%)',
                  maxHeight: 'min(82vh, 760px)',
                  background: 'var(--surface)',
                  border: '1px solid var(--border-hi)',
                  borderRadius: 16,
                  boxShadow: '0 30px 60px -16px rgba(0,0,0,0.6)',
                  display: 'flex', flexDirection: 'column',
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div style={{ padding: '18px 22px 12px', borderBottom: '1px solid var(--border)' }}>
                  <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 8 }}>
                    <span className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.12em' }}>FAILED INGESTS</span>
                    <span style={{ flex: 1 }} />
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={close}
                      style={{ width: 24, height: 24, borderRadius: 6, border: 0, background: 'transparent', color: 'var(--text-mute)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {sources.map((s) => {
                      const active = (dlDetail.sourceFilter || '') === s;
                      const label = s || `All${deadLetter.total ? ` (${deadLetter.total})` : ''}`;
                      const n = s ? (deadLetter.bySource && deadLetter.bySource[s]) || 0 : 0;
                      return (
                        <button
                          key={s || '__all'}
                          type="button"
                          onClick={() => openDeadLetterDetail(s)}
                          style={{
                            padding: '4px 10px', borderRadius: 999,
                            border: '1px solid ' + (active ? 'var(--gold-dim)' : 'var(--border)'),
                            background: active ? 'color-mix(in srgb, var(--gold) 10%, var(--surface))' : 'var(--surface)',
                            color: active ? 'var(--gold)' : 'var(--text-mute)',
                            fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          {s ? `${s} · ${n}` : label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '10px 18px 18px' }}>
                  {dlDetail.loading ? (
                    <div style={{ padding: 24, color: 'var(--text-dim)', fontSize: 13, textAlign: 'center' }}>Loading…</div>
                  ) : dlDetail.items.length === 0 ? (
                    <div style={{ padding: 24, color: 'var(--text-dim)', fontSize: 13, textAlign: 'center' }}>
                      No failed items{dlDetail.sourceFilter ? ` for ${dlDetail.sourceFilter}` : ''}.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {dlDetail.items.map((it: any) => {
                        const id = Number(it.id);
                        const busy = dlDetail.busyId === id;
                        const title = (it.payload && it.payload.title) || '(untitled)';
                        return (
                          <div
                            key={id}
                            className="card"
                            style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}
                          >
                            <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                              <span className="t-mono" style={{ fontSize: 10, color: 'var(--gold)', letterSpacing: '0.1em' }}>{String(it.source || '').toUpperCase()}</span>
                              <span style={{ fontSize: 13, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={title}>{title}</span>
                              <span className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>{it.attempts || 1}× · {fmtTime(it.lastFailedAt)}</span>
                            </div>
                            {it.entityId && (
                              <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(it.entityId)}>
                                id: {String(it.entityId)}
                              </div>
                            )}
                            <div style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                              {String(it.errorMessage || '').slice(0, 600)}
                            </div>
                            <div className="row" style={{ gap: 6, justifyContent: 'flex-end', marginTop: 2 }}>
                              <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                disabled={busy}
                                onClick={() => retryDeadLetterRow(id)}
                                style={busy ? { opacity: 0.55, cursor: 'default' } : undefined}
                              >
                                {busy ? 'Working…' : 'Retry'}
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                disabled={busy}
                                onClick={() => deleteDeadLetterRow(id)}
                                style={busy ? { opacity: 0.55, cursor: 'default' } : undefined}
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })(),
        document.body,
      )}
      <div className="s-field-label" style={{ marginTop: 22 }}>Manage Context Collected</div>
      <div className="s-card">
        <Row title="Delete Last Hour of Context" desc="Remove all context collected in the last hour">
          <button className="btn btn-sm btn-secondary" onClick={() => confirmWrite('data.delete_range', { range: 'last_hour' }, 'Delete last hour', 'This permanently deletes local memory for the selected range.')}>Delete</button>
        </Row>
        <Row title="Delete Last Day of Context" desc="Remove all context collected in the last 24 hours">
          <button className="btn btn-sm btn-secondary" onClick={() => confirmWrite('data.delete_range', { range: 'last_day' }, 'Delete last day', 'This permanently deletes local memory for the selected range.')}>Delete</button>
        </Row>
        <Row title="Delete Context for Custom Time Period" desc="Choose a custom time period to remove context (e.g., last 2 hours, last 3 days)">
          <button className="btn btn-sm btn-secondary" onClick={() => confirmWrite('data.delete_range', { range: 'custom' }, 'Delete custom range', 'This permanently deletes local memory for a custom range.')}>Select</button>
        </Row>
        <Row title="Delete All Context" desc="Permanently remove all context collected. This action cannot be undone." last>
          <button className="btn btn-sm btn-danger-ghost" onClick={() => confirmWrite('data.delete_all', {}, 'Delete all context', 'This deletes all locally stored events and embeddings.')}>Delete</button>
        </Row>
      </div>
      <div className="s-field-label" style={{ marginTop: 22 }}>Manage your Account</div>
      <div className="s-card">
        <Row title="Delete Your Account" desc="Permanently delete your account and all associated data" last>
          <button className="btn btn-sm btn-danger-ghost" onClick={() => confirmWrite('account.delete', {}, 'Delete account', 'This action removes the account identity and local mappings.')}>Delete</button>
        </Row>
      </div>
    </Pane>
  );
}
