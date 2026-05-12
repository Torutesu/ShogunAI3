import { Toggle } from '../../components/Toggle';

interface AppRow {
  id: string;
  name: string;
  icon?: string;
  path?: string;
  enabled: boolean;
}

interface AppsTabProps {
  filteredApps: AppRow[];
  onPickApp: () => Promise<void>;
  removeAppRow: (id: string) => Promise<void>;
  toggleApp: (id: string, enabled: boolean) => Promise<void>;
}

export function AppsTab({ filteredApps, onPickApp, removeAppRow, toggleApp }: AppsTabProps) {
  return (
    <>
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
    </>
  );
}
