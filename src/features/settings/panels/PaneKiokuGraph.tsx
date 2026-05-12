import React, { useState } from 'react';
import { Pane } from '../components/Pane';
import { useRuntimeActions } from '../lib/hooks';
import { SettingsHydrationContext } from '../types';
import { GraphSettingsSection } from './PaneKiokuGraph/GraphSettingsSection';
import { CostSection } from './PaneKiokuGraph/CostSection';
import { SliThresholdsSection } from './PaneKiokuGraph/SliThresholdsSection';
import { RulesSection } from './PaneKiokuGraph/RulesSection';
import { EdgeReviewSection } from './PaneKiokuGraph/EdgeReviewSection';
import { BackupSection } from './PaneKiokuGraph/BackupSection';

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
      <GraphSettingsSection
        readPath={readPath}
        setReadPath={setReadPath}
        captureFlag={captureFlag}
        setCaptureFlag={setCaptureFlag}
        workerEnabled={workerEnabled}
        setWorkerEnabled={setWorkerEnabled}
        pollSecs={pollSecs}
        setPollSecs={setPollSecs}
        maxJobs={maxJobs}
        setMaxJobs={setMaxJobs}
        persistGraph={persistGraph}
      />
      <CostSection
        extractionModel={extractionModel}
        setExtractionModel={setExtractionModel}
        monthlyCap={monthlyCap}
        setMonthlyCap={setMonthlyCap}
        capAction={capAction}
        setCapAction={setCapAction}
        fallbackModel={fallbackModel}
        setFallbackModel={setFallbackModel}
        persistCost={persistCost}
        persistLLMModel={persistLLMModel}
      />
      <SliThresholdsSection
        sliBadSuccessLt={sliBadSuccessLt}
        setSliBadSuccessLt={setSliBadSuccessLt}
        sliBadP95Gt={sliBadP95Gt}
        setSliBadP95Gt={setSliBadP95Gt}
        sliBadBacklogGt={sliBadBacklogGt}
        setSliBadBacklogGt={setSliBadBacklogGt}
        sliWarnSuccessLt={sliWarnSuccessLt}
        setSliWarnSuccessLt={setSliWarnSuccessLt}
        sliWarnP95Gt={sliWarnP95Gt}
        setSliWarnP95Gt={setSliWarnP95Gt}
        sliWarnBacklogGt={sliWarnBacklogGt}
        setSliWarnBacklogGt={setSliWarnBacklogGt}
        persistObservability={persistObservability}
      />
      <RulesSection
        rulesText={rulesText}
        setRulesText={setRulesText}
        rulesError={rulesError}
        sections={sections}
        saveRules={saveRules}
      />
      <EdgeReviewSection
        proposals={proposals}
        proposalsBusy={proposalsBusy}
        proposalsErr={proposalsErr}
        showAllProposals={showAllProposals}
        setShowAllProposals={setShowAllProposals}
        reviewNotes={reviewNotes}
        setReviewNotes={setReviewNotes}
        reviewBusy={reviewBusy}
        refreshProposals={refreshProposals}
        reviewProposal={reviewProposal}
      />
      <BackupSection
        backupLabel={backupLabel}
        setBackupLabel={setBackupLabel}
        backupBusy={backupBusy}
        backupResult={backupResult}
        backupError={backupError}
        runBackup={runBackup}
      />
    </Pane>
  );
}
