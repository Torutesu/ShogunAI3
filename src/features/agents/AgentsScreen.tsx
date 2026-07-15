import { useState, useEffect, useMemo, useCallback } from 'react';
import { Icon } from '@/shared/icons';
import { runRuntimeAction, } from '@/shared/ipc/runtime-actions';
import { openChatWithSeed } from '@/shared/context/chat-composer-seed';
import { McpToolConsolePanel } from '@/shared/context/McpToolConsolePanel';
import { AGENTS_DEMO, AGENTS_DEMO_NOW, AGENTS_LIVE } from './lib/demo-data';
import { AGENT_RUNTIME, agentNeedsAttention } from './lib/metadata';
import {
  applyPersistedAgentRunsFromSettingsSections,
  buildPersistedAgentSettingsPatch,
  loadPersistedAgentStateFromLocalStorage,
  loadPersistedAgentStateFromSettingsSections,
  saveAgentOverrides,
  saveCustomAgents,
} from './lib/storage';
import { formatAgentRunSource } from './lib/run-source';
import { AttentionStrip } from './components/AttentionStrip';
import { AgentsEmptyState } from './components/AgentsEmptyState';
import { EditAgentModal } from './components/EditAgentModal';
import { NewAgentModal } from './components/NewAgentModal';
import { FilterBar } from './components/FilterBar';
import { AgentCard } from './components/AgentCard';
import { AgentRunHistoryDrawer } from './components/AgentRunHistoryDrawer';
import type { AgentDemo, AgentLiveEntry, AgentRun } from './types';

function computeNextRunMs(trigger: string, nowMs: number): number | null {
  const raw = String(trigger || '').trim();
  let m = raw.match(/^every (\d+) (minute|hour|day)s?$/);
  if (m) {
    const value = Number(m[1] || '1');
    const unit = m[2] || 'hour';
    const unitMs = unit === 'minute' ? 60_000 : unit === 'day' ? 24 * 60 * 60_000 : 60 * 60_000;
    return nowMs + value * unitMs;
  }
  m = raw.match(/^(\d{2}):(\d{2}) daily$/);
  if (m) {
    const target = new Date(nowMs);
    target.setHours(Number(m[1] || '12'), Number(m[2] || '0'), 0, 0);
    if (target.getTime() <= nowMs) target.setDate(target.getDate() + 1);
    return target.getTime();
  }
  if (raw === 'weekly') return nowMs + 7 * 24 * 60 * 60_000;
  return null;
}

export function AgentsScreen() {
  const [runPrompt, setRunPrompt] = useState('');
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = useState(true);
  const [playgroundOpen, setPlaygroundOpen] = useState(false);
  const [newAgentModalOpen, setNewAgentModalOpen] = useState(false);
  const [historyDrawerAgentId, setHistoryDrawerAgentId] = useState<string | null>(null);
  const [editModalAgentId, setEditModalAgentId] = useState<string | null>(null);
  const [deleteAgentId, setDeleteAgentId] = useState<string | null>(null);
  const [sourceAgents] = useState<AgentDemo[]>(() => AGENTS_DEMO);
  const [customAgents, setCustomAgents] = useState<AgentDemo[]>([]);
  const [agentOverrides, setAgentOverrides] = useState<Record<string, Partial<AgentDemo>>>({});
  // Settings cache for the paused-overlay. Re-fetched whenever
  // settingsTick increments (e.g., after Pause/Resume save).
  const [settings, setSettings] = useState<any>(null);
  const [settingsTick, setSettingsTick] = useState(0);
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());
  const [listFocusTick, setListFocusTick] = useState(0);
  const [customAgentsHydrated, setCustomAgentsHydrated] = useState(false);
  const [liveActivity, setLiveActivity] = useState<AgentLiveEntry[]>(() => AGENTS_LIVE);

  const appendLiveEntry = useCallback((entry: AgentLiveEntry) => {
    setLiveActivity((prev) => {
      const duplicateWindowMs = 5_000;
      const next = [entry, ...prev.filter((item) => (
        !(
          item.agent === entry.agent &&
          item.msg === entry.msg &&
          item.level === entry.level &&
          item.source === entry.source &&
          item.atMs != null &&
          entry.atMs != null &&
          Math.abs(item.atMs - entry.atMs) <= duplicateWindowMs
        )
      ))];
      return next.slice(0, 12);
    });
  }, []);

  const hydrateFromSettingsSections = useCallback((sections: Record<string, unknown> | undefined) => {
    if (!sections) return;
    setSettings(sections);
    const priv = sections.privacy;
    if (priv && typeof priv === 'object') {
      setAllowServerMemoryAssembly((priv as Record<string, unknown>).allowChatServerMemoryAssembly !== false);
    }
    const persistedState = loadPersistedAgentStateFromSettingsSections(sections);
    setCustomAgents(persistedState?.customAgents || []);
    setAgentOverrides(persistedState?.agentOverrides || {});
    setCustomAgentsHydrated(true);
  }, []);

  const reloadAgentsSettings = useCallback(async () => {
    const res = await runRuntimeAction('settings.load', {}, { silentError: true });
    const sections = res?.ok && res.data?.settings
      ? ((res.data.settings as Record<string, unknown>).sections as Record<string, unknown> | undefined)
      : undefined;
    if (!sections) return;
    hydrateFromSettingsSections(sections);
  }, [hydrateFromSettingsSections]);

  const refreshCustomAgentRunsFromSettings = useCallback(async () => {
    const res = await runRuntimeAction('settings.load', {}, { silentError: true });
    const sections = res?.ok && res.data?.settings
      ? ((res.data.settings as Record<string, unknown>).sections as Record<string, unknown> | undefined)
      : undefined;
    if (!sections) return;
    setSettings(sections);
    setCustomAgents((prev) => applyPersistedAgentRunsFromSettingsSections(prev, sections));
  }, []);

  useEffect(() => {
    let cancelled = false;
    runRuntimeAction('settings.load', {}, { silentError: true }).then((r) => {
      if (cancelled) return;
      if (r?.ok && r.data?.settings?.sections) setSettings(r.data.settings.sections);
    });
    return () => { cancelled = true; };
  }, [settingsTick]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let nextState = null;
      try {
        const res = await runRuntimeAction('settings.load', {}, { silentError: true });
        const sections = res?.ok && res.data?.settings
          ? ((res.data.settings as Record<string, unknown>).sections as Record<string, unknown> | undefined)
          : undefined;
        if (sections) {
          hydrateFromSettingsSections(sections);
          nextState = loadPersistedAgentStateFromSettingsSections(sections);
        }
      } catch {
        /* ignore */
      }

      const fallbackState = loadPersistedAgentStateFromLocalStorage();
      const finalState = nextState || fallbackState;
      setCustomAgents(finalState.customAgents);
      setAgentOverrides(finalState.agentOverrides);
      if (!cancelled) setCustomAgentsHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrateFromSettingsSections]);

  useEffect(() => {
    if (!customAgentsHydrated) return;
    saveCustomAgents(customAgents);
    void runRuntimeAction(
      'settings.save',
      buildPersistedAgentSettingsPatch({ customAgents, agentOverrides }),
      { silentError: true },
    );
  }, [agentOverrides, customAgents, customAgentsHydrated]);

  useEffect(() => {
    if (!customAgentsHydrated) return;
    saveAgentOverrides(agentOverrides);
  }, [agentOverrides, customAgentsHydrated]);

  const effectiveAgents = useMemo<AgentDemo[]>(() => {
    return [...sourceAgents, ...customAgents].map((a) => {
      const o = agentOverrides[a.id];
      let merged = o ? { ...a, ...o } : a;
      const def = AGENT_RUNTIME[a.id];
      if (def && settings) {
        const [section, key] = def.pausedSettingPath;
        const enabled = settings[section]?.[key];
        if (enabled === false) {
          merged = { ...merged, status: 'paused' as const, paused: true };
        }
      }
      return merged;
    });
  }, [agentOverrides, customAgents, sourceAgents, settings]);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const [filterStatus, setFilterStatus] = useState('all');
  const [agentSearch, setAgentSearch] = useState('');

  const filterCounts = useMemo(() => {
    const c: Record<string, number> = {
      all: effectiveAgents.length,
      attention: 0,
      running: 0,
      scheduled: 0,
      paused: 0,
      error: 0,
    };
    for (const a of effectiveAgents) {
      const last = a.recentRuns && a.recentRuns[0];
      const eff = last && last.level === 'error' ? 'error' : a.status;
      if (agentNeedsAttention(a, AGENTS_DEMO_NOW)) c.attention = (c.attention ?? 0) + 1;
      if (c[eff] !== undefined) c[eff] += 1;
    }
    return c;
  }, [effectiveAgents]);

  const visibleAgents = useMemo(() => {
    const q = agentSearch.trim().toLowerCase();
    const byStatus = filterStatus === 'all'
      ? effectiveAgents
      : effectiveAgents.filter((a) => {
          if (filterStatus === 'attention') return agentNeedsAttention(a, AGENTS_DEMO_NOW);
          const last = a.recentRuns && a.recentRuns[0];
          const eff = last && last.level === 'error' ? 'error' : a.status;
          return eff === filterStatus;
        });
    if (!q) return byStatus;
    return byStatus.filter((a) => {
      const haystack = [
        a.name,
        a.description,
        a.trigger,
        a.attention || '',
        ...a.tools.map((t) => t.name),
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [agentSearch, filterStatus, effectiveAgents]);

  useEffect(() => {
    if (listFocusTick === 0) return;
    requestAnimationFrame(() => {
      const el = document.getElementById('agents-list-heading');
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }, [listFocusTick]);

  const editingAgent = useMemo(
    () => effectiveAgents.find((a) => a.id === editModalAgentId) || null,
    [effectiveAgents, editModalAgentId],
  );
  const deletingAgent = useMemo(
    () => effectiveAgents.find((a) => a.id === deleteAgentId) || null,
    [deleteAgentId, effectiveAgents],
  );

  const openAgentRunInChat = useCallback((agent: AgentDemo, run: AgentRun) => {
    const output = String(run.output || '').trim();
    if (!output) return;
    const lines = [
      `${agent.name} の出力を shared context と合わせてレビューしてください。`,
      run.input ? `Original prompt:\n${run.input}` : '',
      `Agent output:\n${output}`,
      '不足している論点、改善版、次の一手があれば提案してください。',
    ].filter(Boolean);
    openChatWithSeed({
      text: lines.join('\n\n'),
      assembleMemory: allowServerMemoryAssembly,
      memoryAssemblyQuery: agent.name,
      memoryAssemblyLimit: 14,
      memoryAssemblySemantic: true,
      newChat: true,
    });
  }, [allowServerMemoryAssembly]);

  const runAgentNow = useCallback(async (agentId: string) => {
    const agent = effectiveAgents.find((a) => a.id === agentId);
    const def = AGENT_RUNTIME[agentId];
    if (!agent) return;
    if (!def) {
      if (!String(agent.prompt || '').trim()) {
        (window as any).SHOGUN_RUNTIME?.pushToast?.(`${agent.name}: prompt is empty`, 'warn');
        return;
      }
      setRunningIds((prev) => new Set([...prev, agentId]));
      try {
        const nowMs = Date.now();
        const payload: Record<string, unknown> = {
          agentId,
        };
        payload.memoryAssembly = allowServerMemoryAssembly
          ? { query: agent.name, limit: 14, semantic: true }
          : null;
        const res = await runRuntimeAction('agent.run_now', payload, { silentError: true });
        if (res?.ok) {
          const summary = String(res?.data?.summary || `${agent.name}: draft created`);
          const nextRun: AgentRun = {
            id: `${agentId}-run-${Date.now()}`,
            atMs: nowMs,
            t: new Date(nowMs).toTimeString().slice(0, 5),
            msg: summary,
            level: 'success',
            durationMs: 900,
            tools: agent.tools.map((tool) => tool.name),
            input: String(agent.prompt || ''),
            output: String(res?.data?.content || 'Draft created via native custom agent.'),
            source: 'custom_agent_manual',
            memoryTouched: [],
          };
          (window as any).SHOGUN_RUNTIME?.pushToast?.(
            summary,
            'success',
            nextRun.output
              ? {
                  action: {
                    label: 'Open in Chat',
                    onClick: () => openAgentRunInChat(agent, nextRun),
                  },
                }
              : undefined,
          );
          appendLiveEntry({
            atMs: nowMs,
            t: new Date(nowMs).toTimeString().slice(0, 8),
            agent: agent.name,
            msg: summary,
            level: 'success',
            source: 'manual',
          });
          setCustomAgents((prev) => prev.map((item) => (
            item.id === agentId
              ? {
                  ...item,
                  status: 'scheduled',
                  lastRunMs: nowMs,
                  nextRunMs: computeNextRunMs(item.trigger, nowMs),
                  recentRuns: [nextRun, ...item.recentRuns].slice(0, 5),
                }
              : item
          )));
          void refreshCustomAgentRunsFromSettings();
        } else {
          const errMsg = res?.error?.message || 'Run failed';
          (window as any).SHOGUN_RUNTIME?.pushToast?.(`${agent.name}: ${errMsg}`, 'warn');
          appendLiveEntry({
            atMs: nowMs,
            t: new Date(nowMs).toTimeString().slice(0, 8),
            agent: agent.name,
            msg: errMsg,
            level: 'error',
            source: 'manual',
          });
          runRuntimeAction('lesson.capture.tool_failure', {
            agentId,
            agentName: agent.name,
            action: 'agent.run_now',
            payload,
            errorMessage: errMsg,
          }, { silentError: true });
          void refreshCustomAgentRunsFromSettings();
        }
      } finally {
        setRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }
      return;
    }
    setRunningIds((prev) => new Set([...prev, agentId]));
    try {
      const res = await runRuntimeAction(def.runNowAction, def.runNowPayload(), { silentError: true });
      if (res?.ok) {
        (window as any).SHOGUN_RUNTIME?.pushToast?.(def.runNowSuccessMsg(res.data), 'success');
        appendLiveEntry({
          atMs: Date.now(),
          t: new Date().toTimeString().slice(0, 8),
          agent: agent.name,
          msg: def.runNowSuccessMsg(res.data),
          level: 'success',
          source: 'manual',
        });
      } else {
        const errMsg = res?.error?.message || 'Run failed';
        (window as any).SHOGUN_RUNTIME?.pushToast?.(`${agent.name}: ${errMsg}`, 'warn');
        appendLiveEntry({
          atMs: Date.now(),
          t: new Date().toTimeString().slice(0, 8),
          agent: agent.name,
          msg: errMsg,
          level: 'error',
          source: 'manual',
        });
        // Capture this failure as a Lesson (silent — no toast, no UI feedback)
        runRuntimeAction('lesson.capture.tool_failure', {
          agentId,
          agentName: agent.name,
          action: def.runNowAction,
          payload: def.runNowPayload(),
          errorMessage: errMsg,
        }, { silentError: true });
      }
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  }, [allowServerMemoryAssembly, appendLiveEntry, effectiveAgents, openAgentRunInChat]);

  const togglePauseAgent = useCallback(async (agentId: string) => {
    const agent = effectiveAgents.find((a) => a.id === agentId);
    const def = AGENT_RUNTIME[agentId];
    if (!agent) return;
    if (!def) {
      setCustomAgents((prev) => prev.map((item) => (
        item.id === agentId
          ? {
              ...item,
              paused: !item.paused,
              status: item.paused ? 'scheduled' : 'paused',
            }
          : item
      )));
      (window as any).SHOGUN_RUNTIME?.pushToast?.(
        agent.paused ? `${agent.name} resumed` : `${agent.name} paused`,
        'info',
      );
      return;
    }
    const [section, key] = def.pausedSettingPath;
    const currentEnabled = settings?.[section]?.[key];
    const nextEnabled = currentEnabled === false ? true : false;

    const patch = { section, [key]: nextEnabled };
    const res = await runRuntimeAction('settings.save', patch, { silentError: true });
    if (res?.ok) {
      setSettingsTick((n) => n + 1);
      (window as any).SHOGUN_RUNTIME?.pushToast?.(
        nextEnabled
          ? `${agent.name} resumed`
          : `${agent.name} paused — background work halted`,
        'info',
      );
    } else {
      (window as any).SHOGUN_RUNTIME?.pushToast?.(`Failed to update ${agent.name}`, 'warn');
    }
  }, [effectiveAgents, settings]);

  useEffect(() => {
    void reloadAgentsSettings();
  }, [reloadAgentsSettings]);

  useEffect(() => {
    const onPrivacy = () => {
      void runRuntimeAction('settings.load', {}, { silentError: true }).then((r) => {
        const priv = r?.ok && r.data?.settings?.sections?.privacy;
        if (priv && typeof priv === 'object') {
          setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
        }
      });
    };
    window.addEventListener('shogun-privacy-settings-changed', onPrivacy);
    return () => window.removeEventListener('shogun-privacy-settings-changed', onPrivacy);
  }, []);

  useEffect(() => {
    const onSettingsRefresh = () => {
      setSettingsTick((n) => n + 1);
      void reloadAgentsSettings();
    };
    window.addEventListener('shogun-settings-refresh', onSettingsRefresh);
    return () => window.removeEventListener('shogun-settings-refresh', onSettingsRefresh);
  }, [reloadAgentsSettings]);

  useEffect(() => {
    const onAgentRunsChanged = (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as Record<string, unknown>;
      const agentId = String(detail.agentId || '').trim();
      const atMs = Number(detail.atMs) || Date.now();
      const ok = detail.ok !== false;
      const summary = String(detail.summary || '').trim() || (ok ? 'Run completed' : 'Run failed');
      const source = formatAgentRunSource(String(detail.source || '').trim() || undefined);
      const matchedAgent = effectiveAgents.find((item) => item.id === agentId);
      appendLiveEntry({
        atMs,
        t: new Date(atMs).toTimeString().slice(0, 8),
        agent: matchedAgent?.name || agentId || 'agent',
        msg: summary,
        level: ok ? 'success' : 'error',
        source,
      });
      void refreshCustomAgentRunsFromSettings();
    };
    window.addEventListener('shogun-agents-runs-changed', onAgentRunsChanged);
    return () => window.removeEventListener('shogun-agents-runs-changed', onAgentRunsChanged);
  }, [appendLiveEntry, effectiveAgents, refreshCustomAgentRunsFromSettings]);

  const draftWithMemory = useCallback(() => {
    const raw = runPrompt.trim();
    const prompt =
      raw ||
      'Summarize actionable items from my recent local memory index. Output Markdown: bullets, owners if known, and open questions.';
    const payload: Record<string, unknown> = { target: 'agent_run', source: 'agents_playground', prompt };
    if (allowServerMemoryAssembly) {
      payload.memoryAssembly = { query: raw.slice(0, 480) || '', limit: 14, semantic: true };
    }
    return runRuntimeAction('draft.create', payload, { successMessage: 'Draft ready', silentError: true }).then((r) => {
      if (!r.ok && (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.pushToast) {
        (window as any).SHOGUN_RUNTIME.pushToast(r.error && r.error.message ? r.error.message : 'Draft failed', 'warn');
      }
    });
  }, [runPrompt, allowServerMemoryAssembly]);

  const openChatWithMemory = useCallback(() => {
    const raw = runPrompt.trim();
    const text =
      raw ||
      'You are my execution agent. Use local memory context to propose the next 3 concrete steps (bullets).';
    const q = raw.slice(0, 480) || '';
    const detail: Record<string, unknown> = { text, webSearch: false, assembleMemory: allowServerMemoryAssembly };
    if (allowServerMemoryAssembly) {
      detail.memoryAssemblyPreset = { query: q, limit: 14, semantic: true };
    } else {
      detail.clearMemoryAssemblyPreset = true;
    }
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('chat');
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('shogun-chat-composer-seed', { detail }));
    }, 0);
  }, [runPrompt, allowServerMemoryAssembly]);

  const attentionCount = effectiveAgents.filter((a) => agentNeedsAttention(a, AGENTS_DEMO_NOW)).length;

  return (
    <div className="content-inner" style={{padding:'var(--space-8) var(--space-12) var(--space-12)', maxWidth:1280, margin:'0 auto'}}>
      {/* Header */}
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:'var(--space-2)'}}>EXECUTION LAYER</div>
          <h1>Agents</h1>
          <div className="sub">
            <span style={{color:'var(--text-mute)'}}>{effectiveAgents.length} agents · 11 MCP tools</span>
            {attentionCount > 0 && (
              <>
                <span style={{color:'var(--text-mute)'}}> · </span>
                <span style={{color:'var(--danger)'}}>{attentionCount} needs attention</span>
              </>
            )}
          </div>
        </div>
        <div className="row" style={{gap:'var(--space-2)', flexWrap:'wrap'}}>
          <button type="button" className="btn btn-secondary" onClick={() => setPlaygroundOpen((v) => !v)}>
            <Icon name="terminal" size={14}/> MCP console
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setNewAgentModalOpen(true)}>
            <Icon name="plus" size={14}/> New agent
          </button>
        </div>
      </div>

      <AttentionStrip
        agents={effectiveAgents}
        nowMs={AGENTS_DEMO_NOW}
        onRunNow={runAgentNow}
        onShowAllAttention={() => {
          setFilterStatus('attention');
          setAgentSearch('');
          setListFocusTick((n) => n + 1);
        }}
        onView={(id) => {
          setExpandedIds((prev) => new Set([...prev, id]));
          requestAnimationFrame(() => {
            const el = document.getElementById(`agent-card-${id}`);
            if (el && typeof el.scrollIntoView === 'function') {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          });
        }}
      />

      {/* Agents section */}
      <div id="agents-list-heading" style={{marginBottom:'var(--space-3)', color:'var(--text-mute)'}} className="t-sm">Your agents</div>
      <FilterBar
        active={filterStatus}
        onChange={setFilterStatus}
        counts={filterCounts}
        search={agentSearch}
        onSearchChange={setAgentSearch}
      />
      {visibleAgents.length === 0 ? (
        <div style={{marginBottom:'var(--space-8)'}}>
          <AgentsEmptyState
            filterStatus={filterStatus}
            totalCount={effectiveAgents.length}
            onCreate={() => setNewAgentModalOpen(true)}
          />
        </div>
      ) : (
        <div style={{display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:'var(--space-4)', marginBottom:'var(--space-8)'}}>
          {visibleAgents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              expanded={expandedIds.has(a.id)}
              onToggle={() => toggleExpanded(a.id)}
              nowMs={AGENTS_DEMO_NOW}
              onOpenHistory={setHistoryDrawerAgentId}
              onEdit={setEditModalAgentId}
              onDelete={(id) => setDeleteAgentId(id)}
              running={runningIds.has(a.id)}
              onRunNow={() => runAgentNow(a.id)}
              onTogglePause={() => togglePauseAgent(a.id)}
            />
          ))}
        </div>
      )}

      {/* Live activity (compressed footer per spec § 1) */}
      <div className="t-mono" style={{color:'var(--text-dim)', marginTop:'var(--space-8)', marginBottom:'var(--space-2)'}}>
        LIVE ACTIVITY
      </div>
      <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)', borderTop:'1px solid var(--border)', paddingTop:'var(--space-3)'}}>
        {liveActivity.slice(0, 5).map((row, i) => {
          const levelColor = row.level === 'success' ? 'var(--success)'
                           : row.level === 'error'   ? 'var(--danger)'
                           : 'var(--text-mute)';
          return (
            <div key={i} style={{
              display:'grid', gridTemplateColumns:'80px 120px 90px 1fr auto', columnGap:'var(--space-3)',
              alignItems:'baseline', fontSize:11,
            }} className="t-mono">
              <span style={{color:'var(--text-dim)'}}>{row.t}</span>
              <span style={{color:'var(--text-mute)'}}>{row.agent}</span>
              <span style={{color:'var(--gold)', textTransform:'uppercase', fontSize:10}}>
                {row.source || 'live'}
              </span>
              <span style={{color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontFamily:'inherit'}}>{row.msg}</span>
              <span style={{color:levelColor, textTransform:'uppercase', fontSize:10}}>{row.level}</span>
            </div>
          );
        })}
      </div>

      <NewAgentModal
        open={newAgentModalOpen}
        onClose={() => setNewAgentModalOpen(false)}
        onCreate={(draft) => {
          const nowMs = Date.now();
          const customAgent: AgentDemo = {
            id: `custom-${Date.now()}`,
            name: draft.name,
            icon: draft.tools[0]?.icon || 'agents',
            status: draft.trigger.startsWith('on ') ? 'idle' : 'scheduled',
            trigger: draft.trigger,
            triggerSince: new Date(nowMs).toISOString().slice(0, 10),
            description: draft.description,
            tools: draft.tools,
            lastRunMs: null,
            nextRunMs: computeNextRunMs(draft.trigger, nowMs),
            recentRuns: [],
            paused: false,
            isCustom: true,
            prompt: draft.prompt,
          };
          setCustomAgents((prev) => [customAgent, ...prev]);
          setNewAgentModalOpen(false);
          setExpandedIds((prev) => new Set([customAgent.id, ...prev]));
          (window as any).SHOGUN_RUNTIME?.pushToast?.(`${draft.name} created`, 'success');
        }}
        onOpenPlayground={() => {
          setNewAgentModalOpen(false);
          setPlaygroundOpen(true);
        }}
      />

      {historyDrawerAgentId && (
        <AgentRunHistoryDrawer
          agent={effectiveAgents.find((a) => a.id === historyDrawerAgentId) as AgentDemo}
          nowMs={AGENTS_DEMO_NOW}
          onClose={() => setHistoryDrawerAgentId(null)}
          onOpenRunOutput={openAgentRunInChat}
        />
      )}

      {editingAgent && (
        <EditAgentModal
          agent={editingAgent}
          onClose={() => setEditModalAgentId(null)}
          onSave={(patch) => {
            const agentId = editModalAgentId as string;
            if (editingAgent.isCustom) {
              const nowMs = Date.now();
              setCustomAgents((prev) => prev.map((item) => (
                item.id === agentId
                  ? {
                      ...item,
                      ...patch,
                      icon: patch.tools?.[0]?.icon || item.icon,
                      nextRunMs: computeNextRunMs(patch.trigger, nowMs),
                    }
                  : item
              )));
            } else {
              setAgentOverrides((prev) => ({
                ...prev,
                [agentId]: {
                  ...(prev[agentId] || {}),
                  ...patch,
                },
              }));
            }
            setEditModalAgentId(null);
            (window as any).SHOGUN_RUNTIME?.pushToast?.('Agent updated', 'success');
          }}
          onDelete={editingAgent.isCustom ? () => {
            setEditModalAgentId(null);
            setDeleteAgentId(editingAgent.id);
          } : null}
        />
      )}

      {deletingAgent ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Delete agent"
          onMouseDown={() => setDeleteAgentId(null)}
          style={{
            position:'fixed', inset:0, zIndex:1000,
            background:'rgba(0,0,0,0.5)',
            display:'flex', alignItems:'center', justifyContent:'center',
          }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              background:'var(--surface)',
              border:`1px solid var(--border-hi)`,
              borderRadius:'var(--radius-lg)',
              padding:'var(--space-8)',
              maxWidth:440, width:'90%',
              boxShadow:'var(--shadow-lg)',
              display:'flex', flexDirection:'column', gap:'var(--space-4)',
            }}
          >
            <div className="t-mono" style={{color:'var(--danger)'}}>DELETE AGENT</div>
            <div style={{fontSize:18, fontWeight:600, letterSpacing:'-0.01em'}}>
              Delete {deletingAgent.name}?
            </div>
            <p className="t-sm" style={{color:'var(--text-mute)', lineHeight:1.6, margin:0}}>
              This removes the custom agent, its saved prompt, and its recent local runs from this app.
            </p>
            <div className="row" style={{gap:'var(--space-2)', justifyContent:'flex-end'}}>
              <button type="button" className="btn btn-ghost" onClick={() => setDeleteAgentId(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const agentId = deletingAgent.id;
                  setCustomAgents((prev) => prev.filter((item) => item.id !== agentId));
                  setAgentOverrides((prev) => {
                    const next = { ...prev };
                    delete next[agentId];
                    return next;
                  });
                  setExpandedIds((prev) => {
                    const next = new Set(prev);
                    next.delete(agentId);
                    return next;
                  });
                  setHistoryDrawerAgentId((prev) => (prev === agentId ? null : prev));
                  setEditModalAgentId((prev) => (prev === agentId ? null : prev));
                  setDeleteAgentId(null);
                  (window as any).SHOGUN_RUNTIME?.pushToast?.('Agent deleted', 'success');
                }}
              >
                Delete agent
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Console drawer — pairs the read-only MCP console with the existing prompt playground */}
      {playgroundOpen && (
        <div className="card" style={{marginTop:'var(--space-8)', borderColor:'var(--gold-dim)'}}>
          <div className="row" style={{alignItems:'center', gap:'var(--space-3)', marginBottom:'var(--space-4)'}}>
            <div className="t-mono" style={{color:'var(--gold)'}}>MCP CONSOLE · PLAYGROUND</div>
            <span className="spacer"/>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setPlaygroundOpen(false)}
              aria-label="Close"
              style={{padding:'0 8px'}}
            >
              <Icon name="x" size={14}/>
            </button>
          </div>
          <div style={{ marginBottom:'var(--space-6)' }}>
            <McpToolConsolePanel
              title="Read-only SHOGUN MCP console"
              description="Try the same local MCP tools exposed to Claude Desktop, directly from the execution layer of this Mac app."
            />
          </div>
          <div className="t-mono" style={{color:'var(--gold)', marginBottom:'var(--space-3)'}}>PROMPT PLAYGROUND</div>
          <textarea
            className="input"
            style={{
              width:'100%',
              minHeight:88,
              height:'auto',
              resize:'vertical',
              padding:'var(--space-3)',
              boxSizing:'border-box',
              fontFamily:'inherit',
            }}
            placeholder="例: 今週のリスクを Memory から洗い出して / 投資家向けに1段落…"
            value={runPrompt}
            onChange={(e) => setRunPrompt(e.target.value)}
          />
          <div className="row" style={{gap:'var(--space-2)', marginTop:'var(--space-3)', flexWrap:'wrap'}}>
            <button className="btn btn-primary" type="button" onClick={draftWithMemory}>
              <Icon name="edit" size={14}/> Draft + Memory
            </button>
            <button className="btn btn-secondary" type="button" onClick={openChatWithMemory}>
              <Icon name="chat" size={14}/> Open in Chat
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
