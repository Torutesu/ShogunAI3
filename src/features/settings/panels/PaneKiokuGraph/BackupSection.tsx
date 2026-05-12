import { Row } from '../../components/Row';
import { formatBytes } from '../../lib/utils';

interface BackupSectionProps {
  backupLabel: string;
  setBackupLabel: (v: string) => void;
  backupBusy: boolean;
  backupResult: any;
  backupError: string | null;
  runBackup: () => Promise<void>;
}

export function BackupSection({
  backupLabel,
  setBackupLabel,
  backupBusy,
  backupResult,
  backupError,
  runBackup,
}: BackupSectionProps) {
  return (
    <div className="s-card" style={{ padding: 20, marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Backup</h3>
      <p style={{ color: '#aaa', fontSize: 12, marginTop: 0 }}>
        Run <code>VACUUM INTO</code> on the live <code>memory.db</code> to produce a consistent
        compacted copy. Recommended before flipping <code>kioku_graph.stage5_apply</code> on, or
        anytime you want a snapshot. The Tauri app can stay running.
      </p>
      <Row title="Label" desc='Inserted into the default filename ("memory.db.<label>-YYYY-MM-DD-HHMMSS"). Leave blank for "backup".'>
        <input
          className="s-input"
          value={backupLabel}
          onChange={(e) => setBackupLabel(e.target.value)}
          placeholder="pre-stage5"
          style={{ width: 200 }}
        />
      </Row>
      <Row title="Create backup now" desc="Writes to the same directory as memory.db. Refuses to overwrite existing files." last>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => void runBackup()}
          disabled={backupBusy}
        >
          {backupBusy ? 'Backing up…' : 'Create backup'}
        </button>
      </Row>
      {backupError && (
        <div style={{ color: '#e57373', marginTop: 8, fontSize: 12 }}>{backupError}</div>
      )}
      {backupResult && !backupError && (
        <div style={{ marginTop: 12, fontSize: 12, color: '#aaa', lineHeight: 1.6 }}>
          <div>✓ Backup complete</div>
          <div>dest: <code>{backupResult.dest_path}</code></div>
          <div>size: {formatBytes(backupResult.bytes)}</div>
          <div>at: {new Date(backupResult.completed_at_ms).toLocaleString()}</div>
        </div>
      )}
    </div>
  );
}
