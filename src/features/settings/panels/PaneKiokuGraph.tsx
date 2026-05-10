/* eslint-disable max-lines -- Phase 2 Step 10: feature split. Phase 3 will further decompose. */
import React, { useState } from 'react';
import { Pane } from '../components/Pane';
import { Row } from '../components/Row';
import { Toggle } from '../components/Toggle';
import { useRuntimeActions } from '../lib/hooks';
import { formatBytes } from '../lib/utils';
import { SettingsHydrationContext } from '../types';

export function PaneKiokuGraph() {
  const { run } = useRuntimeActions();
  const { sections, refreshSections } = React.useContext(SettingsHydrationContext);

  const [readPath, setReadPath] = useState('legacy');
  const [workerEnabled, setWorkerEnabled] = useState(false);
  const [captureFlag, setCaptureFlag] = useState(false);
  const [pollSecs, setPollSecs] = useState('30');
  const [maxJobs, setMaxJobs] = useState('5');

  const [monthlyCap, setMonthlyCap] = useState('10');
  const [capAction, setCapAction] = useState('pause_extraction');
  const [fallbackModel, setFallbackModel] = useState('claude-haiku-4-5');

  const [extractionModel, setExtractionModel] = useState('claude-haiku-4-5');

  const [sliBadSuccessLt, setSliBadSuccessLt] = useState('95');
  const [sliBadP95Gt, setSliBadP95Gt] = useState('3000');
  const [sliBadBacklogGt, setSliBadBacklogGt] = useState('40');
  const [sliWarnSuccessLt, setSliWarnSuccessLt] = useState('99');
  const [sliWarnP95Gt, setSliWarnP95Gt] = useState('1500');
  const [sliWarnBacklogGt, setSliWarnBacklogGt] = useState('15');

  const [rulesText, setRulesText] = useState('[]');
  const [rulesError, setRulesError] = useState('');

  const [proposals, setProposals] = useState<any[]>([]);
  const [proposalsBusy, setProposalsBusy] = useState(false);
  const [proposalsErr, setProposalsErr] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [showAllProposals, setShowAllProposals] = useState(false);

  const refreshProposals = React.useCallback(async () => {
    setProposalsBusy(true);
    setProposalsErr(null);
    const r = await run(
      'kioku.edge_type_proposals',
      { only_unreviewed: !showAllProposals, limit: 50 },
      { silentError: true },
    );
    setProposalsBusy(false);
    if (r.ok && r.data && Array.isArray(r.data.proposals)) {
      setProposals(r.data.proposals);
    } else {
      setProposalsErr((r && (r.message || r.error)) || 'Failed to load proposals.');
    }
  }, [run, showAllProposals]);

  React.useEffect(() => { void refreshProposals(); }, [refreshProposals]);

  const reviewProposal = async (edge_type: string, status: number) => {
    setReviewBusy(edge_type);
    const note = (reviewNotes[edge_type] || '').trim();
    const payload: any = { edge_type, status };
    if (note) payload.note = note;
    const r = await run('kioku.edge_type_review', payload, { silentError: true });
    setReviewBusy(null);
    if (r.ok) {
      setReviewNotes((prev) => {
        const next = { ...prev };
        delete next[edge_type];
        return next;
      });
      await refreshProposals();
    }
  };

  const [backupLabel, setBackupLabel] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupResult, setBackupResult] = useState<any>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  const runBackup = async () => {
    setBackupBusy(true);
    setBackupResult(null);
    setBackupError(null);
    const payload: any = {};
    const trimmed = backupLabel.trim();
    if (trimmed) payload.label = trimmed;
    const r = await run('kioku.backup_db', payload, { silentError: true });
    setBackupBusy(false);
    if (r.ok && r.data) {
      setBackupResult(r.data);
    } else {
      setBackupError((r && (r.message || r.error)) || 'Backup failed; check logs.');
    }
  };

  React.useEffect(() => {
    const g = sections.kioku_graph || {};
    if (typeof g.read_path === 'string') setReadPath(g.read_path);
    if (typeof g.worker_enabled === 'boolean') setWorkerEnabled(g.worker_enabled);
    if (typeof g.capture_to_mem_captures === 'boolean') setCaptureFlag(g.capture_to_mem_captures);
    if (g.poll_interval_secs != null) setPollSecs(String(g.poll_interval_secs));
    if (g.max_jobs_per_tick != null) setMaxJobs(String(g.max_jobs_per_tick));

    const c = sections.kioku_cost || {};
    if (c.monthly_cap_usd != null) setMonthlyCap(String(c.monthly_cap_usd));
    if (typeof c.cap_action === 'string') setCapAction(c.cap_action);
    if (typeof c.fallback_model === 'string') setFallbackModel(c.fallback_model);

    const l = sections.llm || {};
    if (typeof l.extractionModel === 'string') setExtractionModel(l.extractionModel);

    const o = sections.observability || {};
    const t = o.sliThresholds || {};
    if (t.bad && typeof t.bad === 'object') {
      if (t.bad.successLt != null) setSliBadSuccessLt(String(t.bad.successLt));
      if (t.bad.p95Gt != null) setSliBadP95Gt(String(t.bad.p95Gt));
      if (t.bad.backlogGt != null) setSliBadBacklogGt(String(t.bad.backlogGt));
    }
    if (t.warn && typeof t.warn === 'object') {
      if (t.warn.successLt != null) setSliWarnSuccessLt(String(t.warn.successLt));
      if (t.warn.p95Gt != null) setSliWarnP95Gt(String(t.warn.p95Gt));
      if (t.warn.backlogGt != null) setSliWarnBacklogGt(String(t.warn.backlogGt));
    }

    const arr = Array.isArray(sections.kioku_rules) ? sections.kioku_rules : [];
    try {
      setRulesText(JSON.stringify(arr, null, 2));
    } catch (_) {
      setRulesText('[]');
    }
  }, [sections]);

  const persistGraph = (patch: any) => run(
    'settings.save',
    {
      section: 'kioku_graph',
      read_path: readPath,
      worker_enabled: workerEnabled,
      capture_to_mem_captures: captureFlag,
      poll_interval_secs: Number(pollSecs) || 30,
      max_jobs_per_tick: Number(maxJobs) || 5,
      ...patch,
    },
    { silentError: true },
  ).then(() => refreshSections && refreshSections());

  const persistCost = (patch: any) => run(
    'settings.save',
    {
      section: 'kioku_cost',
      monthly_cap_usd: Number(monthlyCap) || 10,
      cap_action: capAction,
      fallback_model: fallbackModel,
      ...patch,
    },
    { silentError: true },
  ).then(() => refreshSections && refreshSections());

  const persistLLMModel = (val: string) => run(
    'settings.save',
    { section: 'llm', extractionModel: val },
    { silentError: true },
  ).then(() => refreshSections && refreshSections());

  const persistObservability = (patch: any) => run(
    'settings.save',
    {
      section: 'observability',
      sliThresholds: {
        bad: {
          successLt: Number(sliBadSuccessLt) || 95,
          p95Gt: Number(sliBadP95Gt) || 3000,
          backlogGt: Number(sliBadBacklogGt) || 40,
        },
        warn: {
          successLt: Number(sliWarnSuccessLt) || 99,
          p95Gt: Number(sliWarnP95Gt) || 1500,
          backlogGt: Number(sliWarnBacklogGt) || 15,
        },
      },
      ...patch,
    },
    { silentError: true },
  ).then(() => refreshSections && refreshSections());

  const saveRules = async () => {
    setRulesError('');
    let parsed: any;
    try {
      parsed = JSON.parse(rulesText);
    } catch (e: any) {
      setRulesError(`Invalid JSON: ${e.message}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      setRulesError('kioku_rules must be a JSON array.');
      return;
    }
    await run(
      'settings.save',
      { section: 'kioku_rules', value: parsed },
      { silentError: true },
    );
    if (refreshSections) await refreshSections();
  };

  return (
    <Pane
      title="KIOKU Graph"
      jp="記憶グラフ"
      subtitle="Phase 2 graph layer flags, BYOK extraction worker, monthly cost cap, and user-defined rules. All toggles default OFF — Phase 1 behavior is preserved until you opt in."
    >
      <div className="s-card" style={{ padding: 20, marginBottom: 16 }}>
        <Row title="Retrieval read path" desc="Switch context_assembly between legacy FTS+semantic and the KIOKU graph traversal (recursive CTE + decay).">
          <select
            className="s-select"
            value={readPath}
            onChange={(e) => { const v = e.target.value; setReadPath(v); persistGraph({ read_path: v }); }}
          >
            <option value="legacy">legacy</option>
            <option value="graph">graph</option>
          </select>
        </Row>
        <Row title="Capture → mem_captures" desc="When ON, capture_sampler / macos_ax route raw captures into mem_captures + extraction_jobs instead of mem_items.">
          <Toggle on={captureFlag} onClick={() => { const next = !captureFlag; setCaptureFlag(next); persistGraph({ capture_to_mem_captures: next }); }} />
        </Row>
        <Row title="Worker enabled" desc="Background thread polls extraction_jobs and calls the BYOK extraction model. Disabled = jobs queue but never run.">
          <Toggle on={workerEnabled} onClick={() => { const next = !workerEnabled; setWorkerEnabled(next); persistGraph({ worker_enabled: next }); }} />
        </Row>
        <Row title="Worker poll interval (sec)" desc="Clamped 5–600 server-side. Lower values check the queue more often at the cost of CPU wake-ups.">
          <input
            className="s-input"
            type="number"
            min="5"
            max="600"
            value={pollSecs}
            onChange={(e) => setPollSecs(e.target.value)}
            onBlur={() => persistGraph({ poll_interval_secs: Number(pollSecs) || 30 })}
            style={{ width: 90 }}
          />
        </Row>
        <Row title="Max jobs per tick" desc="Bounds tick latency. Clamped 1–50 server-side." last>
          <input
            className="s-input"
            type="number"
            min="1"
            max="50"
            value={maxJobs}
            onChange={(e) => setMaxJobs(e.target.value)}
            onBlur={() => persistGraph({ max_jobs_per_tick: Number(maxJobs) || 5 })}
            style={{ width: 90 }}
          />
        </Row>
      </div>

      <div className="s-card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>BYOK extraction cost</h3>
        <Row title="Extraction model" desc="Anthropic ID used by AnthropicExtractionClient. Sonnet / Opus increase quality + cost (3x / 15x).">
          <select
            className="s-select"
            value={extractionModel}
            onChange={(e) => { const v = e.target.value; setExtractionModel(v); persistLLMModel(v); }}
          >
            <option value="claude-haiku-4-5">claude-haiku-4-5 (default, ~$9/mo median)</option>
            <option value="claude-sonnet-4-6">claude-sonnet-4-6 (3x cost)</option>
            <option value="claude-opus-4-7">claude-opus-4-7 (15x cost)</option>
          </select>
        </Row>
        <Row title="Monthly cap (USD)" desc="When this month's cost_ledger total reaches the cap, cap_action below decides what happens.">
          <input
            className="s-input"
            type="number"
            step="1"
            min="0"
            value={monthlyCap}
            onChange={(e) => setMonthlyCap(e.target.value)}
            onBlur={() => persistCost({ monthly_cap_usd: Number(monthlyCap) || 10 })}
            style={{ width: 90 }}
          />
        </Row>
        <Row title="Cap action" desc="pause_extraction = capture continues, jobs sit until next month. pause_capture = capture also stops. fallback_to_lighter = swap to fallback model.">
          <select
            className="s-select"
            value={capAction}
            onChange={(e) => { const v = e.target.value; setCapAction(v); persistCost({ cap_action: v }); }}
          >
            <option value="pause_extraction">pause_extraction (recommended)</option>
            <option value="pause_capture">pause_capture (hard cap)</option>
            <option value="fallback_to_lighter">fallback_to_lighter</option>
          </select>
        </Row>
        <Row title="Fallback model" desc="Used when cap_action = fallback_to_lighter and the cap is reached." last>
          <select
            className="s-select"
            value={fallbackModel}
            onChange={(e) => { const v = e.target.value; setFallbackModel(v); persistCost({ fallback_model: v }); }}
          >
            <option value="claude-haiku-4-5">claude-haiku-4-5</option>
            <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
          </select>
        </Row>
      </div>

      <div className="s-card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>SLI severity thresholds</h3>
        <div className="s-field-hint" style={{ marginBottom: 12 }}>
          Home の SLI バッジ色（good / warn / bad）と Memory Debug の SLI 警戒色に使います。
        </div>
        <Row title="Bad: success < (%)" desc="この値を下回る成功率は bad 扱い。">
          <input className="s-input" type="number" min="1" max="100" value={sliBadSuccessLt} onChange={(e) => setSliBadSuccessLt(e.target.value)} onBlur={() => persistObservability({})} style={{ width: 90 }} />
        </Row>
        <Row title="Bad: p95 > (ms)" desc="この値を上回る p95 は bad 扱い。">
          <input className="s-input" type="number" min="1" value={sliBadP95Gt} onChange={(e) => setSliBadP95Gt(e.target.value)} onBlur={() => persistObservability({})} style={{ width: 110 }} />
        </Row>
        <Row title="Bad: backlog >" desc="この値を上回る backlog は bad 扱い。">
          <input className="s-input" type="number" min="0" value={sliBadBacklogGt} onChange={(e) => setSliBadBacklogGt(e.target.value)} onBlur={() => persistObservability({})} style={{ width: 90 }} />
        </Row>
        <Row title="Warn: success < (%)" desc="bad 条件を満たさない場合に warn 判定で使用。">
          <input className="s-input" type="number" min="1" max="100" value={sliWarnSuccessLt} onChange={(e) => setSliWarnSuccessLt(e.target.value)} onBlur={() => persistObservability({})} style={{ width: 90 }} />
        </Row>
        <Row title="Warn: p95 > (ms)" desc="bad 条件を満たさない場合に warn 判定で使用。">
          <input className="s-input" type="number" min="1" value={sliWarnP95Gt} onChange={(e) => setSliWarnP95Gt(e.target.value)} onBlur={() => persistObservability({})} style={{ width: 110 }} />
        </Row>
        <Row title="Warn: backlog >" desc="bad 条件を満たさない場合に warn 判定で使用。" last>
          <input className="s-input" type="number" min="0" value={sliWarnBacklogGt} onChange={(e) => setSliWarnBacklogGt(e.target.value)} onBlur={() => persistObservability({})} style={{ width: 90 }} />
        </Row>
      </div>

      <div className="s-card" style={{ padding: 20 }}>
        <h3 style={{ marginTop: 0 }}>User-defined rules (kioku_rules)</h3>
        <p style={{ color: '#aaa', fontSize: 12, marginTop: 0 }}>
          A JSON array of rule objects. Each object has <code>id</code>, optional <code>yaml</code> (frontmatter
          with <code>title:</code>), and <code>body</code>. Rules are injected at the top of every chat / brief /
          draft / pack system prompt. Saved to <code>settings.json</code>; the cache reloads on save.
        </p>
        <textarea
          className="s-input"
          value={rulesText}
          onChange={(e) => setRulesText(e.target.value)}
          rows={12}
          spellCheck={false}
          style={{ fontFamily: 'monospace', fontSize: 12, width: '100%' }}
        />
        {rulesError && <div style={{ color: '#e57373', marginTop: 8, fontSize: 12 }}>{rulesError}</div>}
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button className="btn btn-sm btn-primary" onClick={() => void saveRules()}>
            Save rules
          </button>
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => setRulesText(JSON.stringify(Array.isArray(sections.kioku_rules) ? sections.kioku_rules : [], null, 2))}
          >
            Discard changes
          </button>
        </div>
      </div>

      <div className="s-card" style={{ padding: 20, marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>edge_type review queue</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <label style={{ fontSize: 12, color: '#aaa' }}>
              <input
                type="checkbox"
                checked={showAllProposals}
                onChange={(e) => setShowAllProposals(e.target.checked)}
                style={{ marginRight: 4 }}
              />
              Show reviewed
            </label>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => void refreshProposals()}
              disabled={proposalsBusy}
            >
              {proposalsBusy ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
        <p style={{ color: '#aaa', fontSize: 12, marginTop: 0 }}>
          Each edge the extraction worker writes records its <code>edge_type</code> here. Mark
          new types as <strong>Accept</strong> to feed them into Stage 4's CHECK constraint
          candidate set, or <strong>Reject</strong> to flag them for soft-retire. Canonical
          types (<code>mentions</code> / <code>follows_up</code> / ...) are pre-accepted.
        </p>
        {proposalsErr && <div style={{ color: '#e57373', marginBottom: 8, fontSize: 12 }}>{proposalsErr}</div>}
        {proposals.length === 0 ? (
          <div style={{ color: '#888', fontStyle: 'italic', padding: '8px 0' }}>
            {showAllProposals
              ? 'No proposals yet. Once the extraction worker runs, it logs every edge_type here.'
              : 'No unreviewed proposals. Toggle "Show reviewed" to see canonical and previously-judged types.'}
          </div>
        ) : (
          <table className="mdbg-table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>edge_type</th>
                <th style={{ textAlign: 'right' }}>seen</th>
                <th style={{ textAlign: 'left' }}>status</th>
                <th style={{ textAlign: 'left' }}>note (optional)</th>
                <th style={{ textAlign: 'right' }}>actions</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => {
                const status =
                  p.reviewed === 1 ? 'accepted' :
                  p.reviewed === 2 ? 'rejected' :
                  'unreviewed';
                const statusColor =
                  p.reviewed === 1 ? '#8fdc8f' :
                  p.reviewed === 2 ? '#e57373' :
                  '#aaa';
                return (
                  <tr key={p.edge_type}>
                    <td>
                      <code>{p.edge_type}</code>
                      {p.canonical && (
                        <span style={{
                          marginLeft: 6, fontSize: 10, padding: '2px 6px', borderRadius: 8,
                          background: '#1f3a1f', color: '#8fdc8f', border: '1px solid #2f5a2f',
                        }}>canonical</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>{p.seen_count}</td>
                    <td style={{ color: statusColor }}>{status}</td>
                    <td>
                      {p.reviewer_note ? (
                        <span style={{ color: '#aaa', fontSize: 11 }}>{p.reviewer_note}</span>
                      ) : (
                        <input
                          className="s-input"
                          placeholder="why accept/reject?"
                          value={reviewNotes[p.edge_type] || ''}
                          onChange={(e) => setReviewNotes((prev) => ({
                            ...prev, [p.edge_type]: e.target.value,
                          }))}
                          style={{ fontSize: 11, padding: '2px 6px', width: 200 }}
                        />
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => void reviewProposal(p.edge_type, 1)}
                        disabled={reviewBusy === p.edge_type || p.reviewed === 1}
                        style={{ marginRight: 4 }}
                      >
                        Accept
                      </button>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => void reviewProposal(p.edge_type, 2)}
                        disabled={reviewBusy === p.edge_type || p.reviewed === 2}
                      >
                        Reject
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

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
    </Pane>
  );
}
