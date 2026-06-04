import { useState, useEffect, useMemo, useCallback } from 'react';
import { Icon } from '@/shared/icons';
import { runRuntimeActionA, runRuntimeActionB } from '@/shared/ipc/runtime-actions';
import { AGENTS_DEMO, AGENTS_DEMO_NOW, AGENTS_LIVE } from './lib/demo-data';
import { AGENT_RUNTIME } from './lib/metadata';
import { AttentionStrip } from './components/AttentionStrip';
import { AgentsEmptyState } from './components/AgentsEmptyState';
import { EditAgentModal } from './components/EditAgentModal';
import { NewAgentModal } from './components/NewAgentModal';
import { FilterBar } from './components/FilterBar';
import { AgentCard } from './components/AgentCard';
import { AgentRunHistoryDrawer } from './components/AgentRunHistoryDrawer';
import type { AgentDemo } from './types';

export function AgentsScreen() {
  const [runPrompt, setRunPrompt] = useState('');
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = useState(true);
  const [playgroundOpen, setPlaygroundOpen] = useState(false);
  const [newAgentModalOpen, setNewAgentModalOpen] = useState(false);
  const [historyDrawerAgentId, setHistoryDrawerAgentId] = useState<string | null>(null);
  const [editModalAgentId, setEditModalAgentId] = useState<string | null>(null);
  const [sourceAgents] = useState<AgentDemo[]>(() => AGENTS_DEMO);
  const [agentOverrides, setAgentOverrides] = useState<Record<string, Partial<AgentDemo>>>({});
  // Settings cache for the paused-overlay. Re-fetched whenever
  // settingsTick increments (e.g., after Pause/Resume save).
  const [settings, setSettings] = useState<any>(null);
  const [settingsTick, setSettingsTick] = useState(0);
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    runRuntimeActionA('settings.load', {}, { silentError: true }).then((r) => {
      if (cancelled) return;
      if (r?.ok && r.data?.settings?.sections) setSettings(r.data.settings.sections);
    });
    return () => { cancelled = true; };
  }, [settingsTick]);

  const effectiveAgents = useMemo<AgentDemo[]>(() => {
    return sourceAgents.map((a) => {
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
  }, [agentOverrides, sourceAgents, settings]);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const [filterStatus, setFilterStatus] = useState('all');

  const filterCounts = useMemo(() => {
    const c: Record<string, number> = { all: effectiveAgents.length, running: 0, scheduled: 0, paused: 0, error: 0 };
    for (const a of effectiveAgents) {
      const last = a.recentRuns && a.recentRuns[0];
      const eff = last && last.level === 'error' ? 'error' : a.status;
      if (c[eff] !== undefined) c[eff] += 1;
    }
    return c;
  }, [effectiveAgents]);

  const visibleAgents = useMemo(() => {
    if (filterStatus === 'all') return effectiveAgents;
    return effectiveAgents.filter((a) => {
      const last = a.recentRuns && a.recentRuns[0];
      const eff = last && last.level === 'error' ? 'error' : a.status;
      return eff === filterStatus;
    });
  }, [filterStatus, effectiveAgents]);

  const editingAgent = useMemo(
    () => effectiveAgents.find((a) => a.id === editModalAgentId) || null,
    [effectiveAgents, editModalAgentId],
  );

  const runAgentNow = useCallback(async (agentId: string) => {
    const agent = effectiveAgents.find((a) => a.id === agentId);
    const def = AGENT_RUNTIME[agentId];
    if (!agent || !def) return;
    setRunningIds((prev) => new Set([...prev, agentId]));
    try {
      const res = await runRuntimeActionA(def.runNowAction, def.runNowPayload(), { silentError: true });
      if (res?.ok) {
        (window as any).SHOGUN_RUNTIME?.pushToast?.(def.runNowSuccessMsg(res.data), 'success');
      } else {
        const errMsg = res?.error?.message || 'Run failed';
        (window as any).SHOGUN_RUNTIME?.pushToast?.(`${agent.name}: ${errMsg}`, 'warn');
        // Capture this failure as a Lesson (silent — no toast, no UI feedback)
        runRuntimeActionA('lesson.capture.tool_failure', {
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
  }, [effectiveAgents]);

  const togglePauseAgent = useCallback(async (agentId: string) => {
    const agent = effectiveAgents.find((a) => a.id === agentId);
    const def = AGENT_RUNTIME[agentId];
    if (!agent || !def) return;
    const [section, key] = def.pausedSettingPath;
    const currentEnabled = settings?.[section]?.[key];
    const nextEnabled = currentEnabled === false ? true : false;

    const patch = { section, [key]: nextEnabled };
    const res = await runRuntimeActionA('settings.save', patch, { silentError: true });
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
    let cancelled = false;
    void runRuntimeActionB('settings.load', {}, { silentError: true }).then((r) => {
      if (cancelled || !r?.ok || !r.data?.settings?.sections?.privacy) return;
      const priv = r.data.settings.sections.privacy;
      if (priv && typeof priv === 'object') {
        setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onPrivacy = () => {
      void runRuntimeActionB('settings.load', {}, { silentError: true }).then((r) => {
        const priv = r?.ok && r.data?.settings?.sections?.privacy;
        if (priv && typeof priv === 'object') {
          setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
        }
      });
    };
    window.addEventListener('shogun-privacy-settings-changed', onPrivacy);
    return () => window.removeEventListener('shogun-privacy-settings-changed', onPrivacy);
  }, []);

  const draftWithMemory = useCallback(() => {
    const raw = runPrompt.trim();
    const prompt =
      raw ||
      'Summarize actionable items from my recent local memory index. Output Markdown: bullets, owners if known, and open questions.';
    const payload: Record<string, unknown> = { target: 'agent_run', source: 'agents_playground', prompt };
    if (allowServerMemoryAssembly) {
      payload.memoryAssembly = { query: raw.slice(0, 480) || '', limit: 14, semantic: true };
    }
    return runRuntimeActionB('draft.create', payload, { successMessage: 'Draft ready', silentError: true }).then((r) => {
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

  const attentionCount = effectiveAgents.filter((a) => {
    const last = a.recentRuns && a.recentRuns[0];
    const stale = (a.status === 'scheduled' || a.trigger?.startsWith('every ')) &&
                  a.lastRunMs && (AGENTS_DEMO_NOW - a.lastRunMs) > 24 * 60 * 60 * 1000;
    return a.attention === 'error' || a.attention === 'auth_expired' ||
           (last && last.level === 'error') || a.attention === 'stale' || stale;
  }).length;

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
      <div style={{marginBottom:'var(--space-3)', color:'var(--text-mute)'}} className="t-sm">Your agents</div>
      <FilterBar
        active={filterStatus}
        onChange={setFilterStatus}
        counts={filterCounts}
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
        {AGENTS_LIVE.slice(0, 5).map((row, i) => {
          const levelColor = row.level === 'success' ? 'var(--success)'
                           : row.level === 'error'   ? 'var(--danger)'
                           : 'var(--text-mute)';
          return (
            <div key={i} style={{
              display:'grid', gridTemplateColumns:'80px 120px 1fr auto', columnGap:'var(--space-3)',
              alignItems:'baseline', fontSize:11,
            }} className="t-mono">
              <span style={{color:'var(--text-dim)'}}>{row.t}</span>
              <span style={{color:'var(--text-mute)'}}>{row.agent}</span>
              <span style={{color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontFamily:'inherit'}}>{row.msg}</span>
              <span style={{color:levelColor, textTransform:'uppercase', fontSize:10}}>{row.level}</span>
            </div>
          );
        })}
      </div>

      <NewAgentModal
        open={newAgentModalOpen}
        onClose={() => setNewAgentModalOpen(false)}
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
        />
      )}

      {editingAgent && (
        <EditAgentModal
          agent={editingAgent}
          onClose={() => setEditModalAgentId(null)}
          onSave={(patch) => {
            setAgentOverrides((prev) => ({
              ...prev,
              [editModalAgentId as string]: {
                ...(prev[editModalAgentId as string] || {}),
                ...patch,
              },
            }));
            setEditModalAgentId(null);
            (window as any).SHOGUN_RUNTIME?.pushToast?.('Agent updated', 'success');
          }}
        />
      )}

      {/* Playground drawer — kept for the memory-aware draft + chat flows */}
      {playgroundOpen && (
        <div className="card" style={{marginTop:'var(--space-8)', borderColor:'var(--gold-dim)'}}>
          <div className="row" style={{alignItems:'center', gap:'var(--space-3)', marginBottom:'var(--space-4)'}}>
            <div className="t-mono" style={{color:'var(--gold)'}}>NEW AGENT · PLAYGROUND</div>
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
