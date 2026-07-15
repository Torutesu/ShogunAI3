import { useState, useEffect, useRef } from 'react';
import { Icon, Kamon } from '@/shared/icons';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { focusEntity } from '@/shared/context/entity-focus';
import { focusAiField } from '@/shared/context/ai-field-focus';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import { seedActionDraft } from '@/shared/context/action-draft';
import { SUPPORTED_CONTEXT_ACTION_TYPE_META, type SupportedContextActionType } from '@/shared/context/action-types';
import {
  nativeDetailDescriptorForEntityId,
  openContextTarget,
  openMeetingDetail,
  openNativeDetailForEntityId,
} from '@/shared/context/context-target-navigation';
import {
  queueArtifactDetail,
  queueArtifactOwnerEntityId,
  queueArtifactSourceActionId,
  queueArtifactTitle,
} from '@/shared/context/queue-artifact-meta';
import { normalizeSeedMemoryAssembly } from './lib/normalize-seed';
import { SHOGUN_DEMO_SEED } from '@/shared/lib/demo-seed';
import { BriefTelemetry } from '@/shared/lib/brief-telemetry';
import { ShogunHighlight } from '@/shared/lib/highlight';

interface ChatContextSearchPayload {
  timeline?: { hits?: Array<Record<string, any>> | null; total?: number | null } | null;
  aiFields?: { items?: Array<Record<string, any>> | null; total?: number | null } | null;
  actions?: { items?: Array<Record<string, any>> | null; total?: number | null } | null;
}

interface ChatRecentContextPayload {
  recentAiFields?: { items?: Array<Record<string, any>> | null; total?: number | null } | null;
  recentActions?: { items?: Array<Record<string, any>> | null; total?: number | null } | null;
  recentQueueArtifacts?: { items?: Array<Record<string, any>> | null; total?: number | null } | null;
  recentMeetings?: Array<Record<string, any>> | null;
}

export function buildSharedContextBlock(query: string, payload: ChatContextSearchPayload | ChatRecentContextPayload): string {
  const sections: string[] = [];
  const timelineHits = Array.isArray((payload as ChatContextSearchPayload)?.timeline?.hits)
    ? (payload as ChatContextSearchPayload).timeline?.hits || []
    : [];
  const aiFields = Array.isArray((payload as ChatContextSearchPayload)?.aiFields?.items)
    ? (payload as ChatContextSearchPayload).aiFields?.items || []
    : Array.isArray((payload as ChatRecentContextPayload)?.recentAiFields?.items)
      ? (payload as ChatRecentContextPayload).recentAiFields?.items || []
      : [];
  const actions = Array.isArray((payload as ChatContextSearchPayload)?.actions?.items)
    ? (payload as ChatContextSearchPayload).actions?.items || []
    : Array.isArray((payload as ChatRecentContextPayload)?.recentActions?.items)
      ? (payload as ChatRecentContextPayload).recentActions?.items || []
      : [];
  const queueArtifacts = Array.isArray((payload as ChatRecentContextPayload)?.recentQueueArtifacts?.items)
    ? (payload as ChatRecentContextPayload).recentQueueArtifacts?.items || []
    : [];
  const meetings = Array.isArray((payload as ChatRecentContextPayload)?.recentMeetings)
    ? (payload as ChatRecentContextPayload).recentMeetings || []
    : [];

  if (query) sections.push(`[context_query] ${query}`);

  for (const item of timelineHits.slice(0, 4)) {
    const title = String(item?.title || item?.targetId || item?.id || 'timeline').trim();
    const firstPoint = Array.isArray(item?.keyPoints) ? String(item.keyPoints[0] || '').trim() : '';
    const reason = String(item?.reason || item?.sourceType || '').trim();
    sections.push(
      [
        `[timeline] ${title}`,
        reason ? `Reason: ${reason}` : '',
        firstPoint ? `Point: ${firstPoint}` : '',
      ].filter(Boolean).join('\n'),
    );
  }

  for (const item of aiFields.slice(0, 5)) {
    const owner = String(item?.ownerEntityId || '').trim();
    const field = String(item?.fieldName || '').trim();
    const value = String(item?.currentValue || '').trim();
    const instruction = String(item?.instruction || '').trim();
    const evidence = Array.isArray(item?.evidenceEventIds) ? item.evidenceEventIds.join(', ') : '';
    sections.push(
      [
        `[ai_field] ${owner} / ${field}: ${value || '(empty)'}`,
        instruction ? `Instruction: ${instruction}` : '',
        evidence ? `Evidence: ${evidence}` : '',
      ].filter(Boolean).join('\n'),
    );
  }

  for (const item of actions.slice(0, 5)) {
    const owner = String(item?.ownerEntityId || '').trim();
    const title = String(item?.title || '').trim();
    const actionType = String(item?.actionType || '').trim();
    const status = String(item?.status || '').trim();
    const detail = String(item?.detail || '').trim();
    sections.push(
      [
        `[action] ${title || actionType || '(untitled action)'}`,
        [owner, status, actionType].filter(Boolean).join(' · '),
        detail,
      ].filter(Boolean).join('\n'),
    );
  }

  for (const item of queueArtifacts.slice(0, 4)) {
    const title = queueArtifactTitle(item).trim();
    const owner = queueArtifactOwnerEntityId(item);
    const actionId = queueArtifactSourceActionId(item);
    const detail = queueArtifactDetail(item);
    sections.push(
      [
        `[queue_artifact] ${title}`,
        [owner, actionId ? `action:${actionId}` : ''].filter(Boolean).join(' · '),
        detail,
      ].filter(Boolean).join('\n'),
    );
  }

  for (const item of meetings.slice(0, 3)) {
    const title = String(item?.title || item?.meetingTitle || item?.id || 'meeting').trim();
    const note = String(item?.summary || item?.snippet || item?.notes || '').trim();
    sections.push(
      [
        `[meeting] ${title}`,
        note,
      ].filter(Boolean).join('\n'),
    );
  }

  return sections.join('\n\n').slice(0, 12000);
}

export function buildSharedContextHits(payload: ChatContextSearchPayload | ChatRecentContextPayload): any[] {
  const timelineHits = Array.isArray((payload as ChatContextSearchPayload)?.timeline?.hits)
    ? (payload as ChatContextSearchPayload).timeline?.hits || []
    : [];
  const aiFields = Array.isArray((payload as ChatContextSearchPayload)?.aiFields?.items)
    ? (payload as ChatContextSearchPayload).aiFields?.items || []
    : Array.isArray((payload as ChatRecentContextPayload)?.recentAiFields?.items)
      ? (payload as ChatRecentContextPayload).recentAiFields?.items || []
      : [];
  const actions = Array.isArray((payload as ChatContextSearchPayload)?.actions?.items)
    ? (payload as ChatContextSearchPayload).actions?.items || []
    : Array.isArray((payload as ChatRecentContextPayload)?.recentActions?.items)
      ? (payload as ChatRecentContextPayload).recentActions?.items || []
      : [];
  const queueArtifacts = Array.isArray((payload as ChatRecentContextPayload)?.recentQueueArtifacts?.items)
    ? (payload as ChatRecentContextPayload).recentQueueArtifacts?.items || []
    : [];
  const meetings = Array.isArray((payload as ChatRecentContextPayload)?.recentMeetings)
    ? (payload as ChatRecentContextPayload).recentMeetings || []
    : [];

  return [
    ...timelineHits.slice(0, 4).map((item, index) => ({
      id: String(item?.id || item?.targetId || `timeline-${index}`),
      provenance: 'timeline',
      source: item?.sourceType || 'summary',
      created_at: item?.generatedAt || null,
      title: item?.title || item?.targetId || 'Timeline hit',
      snippet: Array.isArray(item?.keyPoints) ? item.keyPoints[0] || '' : '',
      targetId: item?.targetId || null,
      targetKind: item?.targetKind || null,
    })),
    ...aiFields.slice(0, 5).map((item, index) => ({
      id: String(item?.id || `ai-field-${index}`),
      provenance: 'ai_field',
      source: 'ai_field',
      created_at: item?.lastUpdatedAt || item?.createdAt || null,
      title: `${item?.ownerEntityId || ''} / ${item?.fieldName || ''}`,
      snippet: item?.currentValue || item?.instruction || '',
      ownerEntityId: item?.ownerEntityId || null,
      fieldId: item?.id || null,
      evidenceIds: Array.isArray(item?.evidenceEventIds) ? item.evidenceEventIds : [],
    })),
    ...actions.slice(0, 5).map((item, index) => ({
      id: String(item?.id || `action-${index}`),
      provenance: 'action',
      source: item?.actionType || 'action',
      created_at: item?.updatedAt || item?.createdAt || null,
      title: item?.title || item?.actionType || 'Action',
      snippet: item?.detail || `${item?.ownerEntityId || ''} · ${item?.status || ''}`,
      ownerEntityId: item?.ownerEntityId || null,
      actionId: item?.id || null,
      fieldId: item?.sourceAiFieldId || null,
    })),
    ...queueArtifacts.slice(0, 4).map((item, index) => ({
      id: String(item?.id || `queue-${index}`),
      provenance: 'queue_artifact',
      source: 'queue',
      created_at: item?.createdAt || null,
      title: queueArtifactTitle(item),
      snippet: queueArtifactDetail(item),
      ownerEntityId: queueArtifactOwnerEntityId(item) || null,
      actionId: queueArtifactSourceActionId(item) || null,
      fieldId: item?.payload?.source_ai_field_id || null,
    })),
    ...meetings.slice(0, 3).map((item, index) => ({
      id: String(item?.id || item?.meetingId || `meeting-${index}`),
      provenance: 'meeting',
      source: 'meeting',
      created_at: item?.started_at || item?.startedAt || item?.createdAt || null,
      title: item?.title || item?.meetingTitle || 'Meeting',
      snippet: item?.summary || item?.snippet || item?.notes || '',
      meetingId: item?.id || item?.meetingId || null,
    })),
  ];
}

function canOpenContextHit(hit: any): boolean {
  const provenance = String(hit?.provenance || '').trim();
  if (provenance === 'ai_field') return Boolean(hit?.fieldId);
  if (provenance === 'action') return Boolean(hit?.actionId);
  if (provenance === 'queue_artifact') return Boolean(hit?.actionId || hit?.ownerEntityId);
  if (provenance === 'meeting') return Boolean(hit?.meetingId);
  if (provenance === 'timeline') return Boolean(hit?.targetId || hit?.title);
  return false;
}

export function contextHitEntityId(hit: any): string | null {
  const provenance = String(hit?.provenance || '').trim();
  if (provenance === 'ai_field' || provenance === 'action' || provenance === 'queue_artifact') {
    const owner = String(hit?.ownerEntityId || '').trim();
    return owner || null;
  }
  if (provenance === 'meeting') {
    const meetingId = String(hit?.meetingId || '').trim();
    return meetingId ? `meeting:${meetingId}` : null;
  }
  return null;
}

export function inferActionOwnerEntityIdFromChatContext(hits: any[] | null, memoryContext: string): string {
  if (Array.isArray(hits)) {
    for (const hit of hits) {
      const entityId = contextHitEntityId(hit);
      if (entityId) return entityId;
    }
  }
  const raw = String(memoryContext || '');
  const match = raw.match(/\b(person|company|project|workspace|deal|investor|meeting|document|task|app):[A-Za-z0-9._:-]+\b/);
  if (match) return match[0]!;
  return 'workspace:chat';
}

export function inferSourceAiFieldIdFromChatContext(
  hits: any[] | null,
  ownerEntityId: string,
): string | null {
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const owner = String(ownerEntityId || '').trim();
  const exact = hits.find((hit) => (
    String(hit?.provenance || '').trim() === 'ai_field'
    && String(hit?.ownerEntityId || '').trim() === owner
    && String(hit?.fieldId || '').trim()
  ));
  if (exact) return String(exact.fieldId).trim();
  const fallback = hits.find((hit) => (
    String(hit?.provenance || '').trim() === 'ai_field'
    && String(hit?.fieldId || '').trim()
  ));
  return fallback ? String(fallback.fieldId).trim() : null;
}

export function inferActionEvidenceIdsFromChatContext(hits: any[] | null): string[] {
  if (!Array.isArray(hits) || hits.length === 0) return [];
  const out = new Set<string>();
  for (const hit of hits) {
    const provenance = String(hit?.provenance || '').trim();
    if (provenance === 'ai_field') {
      const evidenceIds = Array.isArray(hit?.evidenceIds) ? hit.evidenceIds : [];
      for (const evidenceId of evidenceIds) {
        const normalized = String(evidenceId || '').trim();
        if (normalized) out.add(normalized);
      }
      const fieldId = String(hit?.fieldId || '').trim();
      if (fieldId) out.add(fieldId);
      continue;
    }
    if (provenance === 'action') {
      const actionId = String(hit?.actionId || hit?.id || '').trim();
      if (actionId) out.add(actionId);
      continue;
    }
    if (provenance === 'queue_artifact') {
      const actionId = String(hit?.actionId || '').trim();
      if (actionId) out.add(actionId);
      else {
        const queueId = String(hit?.id || '').trim();
        if (queueId) out.add(queueId);
      }
      continue;
    }
    if (provenance === 'meeting') {
      const meetingId = String(hit?.meetingId || '').trim();
      if (meetingId) out.add(`meeting:${meetingId}`);
      continue;
    }
    if (provenance === 'timeline') {
      const targetId = String(hit?.targetId || hit?.id || '').trim();
      if (targetId) out.add(targetId);
    }
  }
  return Array.from(out).slice(0, 8);
}

export function contextHitNativeDetailKind(hit: any): 'meeting' | 'workspace' | null {
  return nativeDetailDescriptorForEntityId(contextHitEntityId(hit) || '')?.kind || null;
}

export function openNativeDetailForContextHit(hit: any): boolean {
  const entityId = contextHitEntityId(hit);
  if (!entityId) return false;
  return openNativeDetailForEntityId(entityId);
}

// ═══════════════════════════════════════════════════════════════════════════
// L3 · CHAT — interaction layer (memory-aware conversations)
// ═══════════════════════════════════════════════════════════════════════════
export function ChatScreen() {
  const [messages, setMessages] = useState<any[]>([]);
  const [composerText, setComposerText] = useState('');
  const [memoryContext, setMemoryContext] = useState('');
  /**
   * Structured hits when the memory block came from an in-app search (so we
   * can render FTS5 highlights per field). `null` when the block came from
   * a composer seed — the plain string in `memoryContext` is the source of
   * truth in that case.
   */
  const [memoryContextHits, setMemoryContextHits] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [memoryTotal, setMemoryTotal] = useState(0);
  const [modelHint, setModelHint] = useState('');
  const [chatMax, setChatMax] = useState(false);
  const [webSearchOn, setWebSearchOn] = useState(true);
  /** Server-side Memory assembly (`memoryAssembly` on `chat.complete`); desktop runs search / semantic rerank. */
  const [assembleMemoryOn, setAssembleMemoryOn] = useState(false);
  /** Mirrors `sections.privacy.allowChatServerMemoryAssembly` (default true). */
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = useState(true);
  const [chatActionType, setChatActionType] = useState<SupportedContextActionType>('follow_up_email_draft');
  const [chatActionRiskLevel, setChatActionRiskLevel] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const pendingMemoryAssemblyRef = useRef<any>(null);
  const pendingAutoSendRef = useRef(false);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function formatFreshness(createdAt: any) {
    const t = Number(createdAt);
    if (!Number.isFinite(t) || t <= 0) return null;
    const ageMs = Date.now() - t;
    if (ageMs < 0) return 'future';
    const mins = Math.floor(ageMs / (60 * 1000));
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const r = await runRuntimeAction('stats.get', {}, { silentError: true });
      if (cancelled || !r.ok || !r.data) return;
      setMemoryTotal(Number(r.data.memoryTotal) || 0);
    };
    void load();
    window.addEventListener('shogun-memory-index-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('shogun-memory-index-changed', load);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const r = await runRuntimeAction('settings.load', {}, { silentError: true });
      if (cancelled || !r.ok || !r.data?.settings?.sections) return;
      const llm = r.data.settings.sections.llm;
      if (llm && typeof llm === 'object' && llm.model) setModelHint(String(llm.model));
      const priv = r.data.settings.sections.privacy;
      if (priv && typeof priv === 'object') {
        setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
      }
    };
    void load();
    window.addEventListener('shogun-settings-refresh', load);
    return () => {
      cancelled = true;
      window.removeEventListener('shogun-settings-refresh', load);
    };
  }, []);

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

  const toast = (msg: string, kind?: string) => {
    if ((window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.pushToast) {
      (window as any).SHOGUN_RUNTIME.pushToast(msg, kind || 'info');
    }
  };

  const openScreen = (screen: string) => {
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.(screen);
  };

  const openContextHit = (hit: any) => {
    const provenance = String(hit?.provenance || '').trim();
    if (provenance === 'ai_field' && hit?.fieldId) {
      const ownerEntityId = String(hit?.ownerEntityId || '').trim();
      if (ownerEntityId) focusEntity(ownerEntityId);
      focusAiField(String(hit.fieldId));
      openScreen('ai_fields');
      return;
    }
    if (provenance === 'action' && hit?.actionId) {
      const ownerEntityId = String(hit?.ownerEntityId || '').trim();
      if (ownerEntityId) focusEntity(ownerEntityId);
      const aiFieldId = String(hit?.fieldId || '').trim() || inferSourceAiFieldIdFromChatContext(memoryContextHits, ownerEntityId);
      focusActionTrace({
        actionId: String(hit.actionId),
        aiFieldId: aiFieldId || null,
        openAudit: false,
      });
      openScreen('actions');
      return;
    }
    if (provenance === 'queue_artifact') {
      const ownerEntityId = String(hit?.ownerEntityId || '').trim();
      const actionId = String(hit?.actionId || '').trim();
      if (ownerEntityId) focusEntity(ownerEntityId);
      if (actionId) {
        const aiFieldId = String(hit?.fieldId || '').trim() || inferSourceAiFieldIdFromChatContext(memoryContextHits, ownerEntityId);
        focusActionTrace({
          actionId,
          aiFieldId: aiFieldId || null,
          openAudit: false,
        });
        openScreen('actions');
        return;
      }
      if (ownerEntityId) {
        openContextTarget({ targetId: ownerEntityId });
        return;
      }
    }
    if (provenance === 'meeting' && hit?.meetingId) {
      openMeetingDetail(String(hit.meetingId));
      return;
    }
    if (provenance === 'timeline') {
      openContextTarget({
        targetId: hit?.targetId,
        targetKind: hit?.targetKind,
        title: hit?.title,
      });
    }
  };

  const openEntityContextHit = (hit: any) => {
    const entityId = contextHitEntityId(hit);
    if (!entityId) return;
    openContextTarget({ targetId: entityId });
  };

  const openNativeDetailHit = (hit: any) => {
    openNativeDetailForContextHit(hit);
  };

  useEffect(() => {
    const syncFromShell = () => {
      const seed = SHOGUN_DEMO_SEED as any;
      const rt = (window as any).SHOGUN_RUNTIME;
      const id =
        (typeof window !== 'undefined' && (window as any).__SHOGUN_SHELL_ACTIVE_CHAT__) ||
        (rt && rt.__activeChatId) ||
        (rt && typeof rt.getActiveChat === 'function' && rt.getActiveChat() && rt.getActiveChat().id) ||
        null;
      if (!id || !seed || !seed.chatThreads || !seed.chatThreads[id]) {
        setMessages([]);
        setMemoryContext('');
        setMemoryContextHits(null);
        return;
      }
      setMessages(seed.chatThreads[id].map((m: any) => ({ ...m })));
      const ctx = seed.chatMemoryContext && seed.chatMemoryContext[id];
      setMemoryContext(ctx ? String(ctx) : '');
      // Seed-provided contexts are plain strings — structured hits only come
      // from in-app searches.
      setMemoryContextHits(null);
    };
    syncFromShell();
    window.addEventListener('shogun-active-chat-changed', syncFromShell);
    return () => window.removeEventListener('shogun-active-chat-changed', syncFromShell);
  }, []);

  useEffect(() => {
    const onMax = () => setChatMax((v) => !v);
    const onComposerSeed = (ev: Event | any) => {
      const d = ev && ev.detail ? ev.detail : {};
      if (d.text != null) setComposerText(String(d.text));
      if (typeof d.webSearch === 'boolean') setWebSearchOn(d.webSearch);
      if (typeof d.assembleMemory === 'boolean') setAssembleMemoryOn(d.assembleMemory);
      const preset = normalizeSeedMemoryAssembly(d);
      if (preset) pendingMemoryAssemblyRef.current = preset;
      else if (d.clearMemoryAssemblyPreset) pendingMemoryAssemblyRef.current = null;
      if (d.autoSend && d.text != null && String(d.text).trim()) {
        pendingAutoSendRef.current = true;
      }
    };
    window.addEventListener('shogun-chat-toggle-max', onMax);
    window.addEventListener('shogun-chat-composer-seed', onComposerSeed);
    return () => {
      window.removeEventListener('shogun-chat-toggle-max', onMax);
      window.removeEventListener('shogun-chat-composer-seed', onComposerSeed);
    };
  }, []);

  const attachMemory = async () => {
    // Composer text drives the search when present so the attached memory is
    // topically relevant; an empty composer falls back to the old behavior of
    // attaching the most recent 12 items.
    const query = composerText.trim();
    const r = await runRuntimeAction(
      'memory.search',
      { query, limit: 12 },
      { silentError: true }
    );
    if (!r.ok) {
      const msg = r && r.error && typeof r.error.message === 'string' ? r.error.message : '';
      toast(msg ? 'Memory search failed — ' + msg : 'Memory search failed', 'warn');
      return;
    }
    const hits = (r.data && Array.isArray(r.data.hits)) ? r.data.hits : [];
    if (!hits.length) {
      toast(query ? 'No memory matched "' + query.slice(0, 40) + '"' : 'No memory items to attach', 'warn');
      return;
    }
    // Plain-text block is what actually reaches the LLM (payload.memoryContext
    // in chat_complete). We keep the existing "[provenance] title: snippet"
    // format so the backend contract is unchanged.
    const block = hits
      .map((h: any) => '[' + (h.provenance || 'user') + '] ' + (h.title || '') + ': ' + (h.snippet || ''))
      .join('\n');
    setMemoryContext(block.slice(0, 12000));
    setMemoryContextHits(hits);
    toast(
      query
        ? 'Memory matching "' + query.slice(0, 40) + '" attached (' + hits.length + ')'
        : 'Attached ' + hits.length + ' recent memory items',
      'success'
    );
  };

  const attachAiFields = async () => {
    const query = composerText.trim();
    const r = await runRuntimeAction(
      'ai_field.list',
      { query, limit: 10 },
      { silentError: true },
    );
    if (!r.ok) {
      const msg = r && r.error && typeof r.error.message === 'string' ? r.error.message : '';
      toast(msg ? 'AI Field search failed — ' + msg : 'AI Field search failed', 'warn');
      return;
    }
    const hits = (r.data && Array.isArray(r.data.items)) ? r.data.items : [];
    if (!hits.length) {
      toast(query ? 'No AI Fields matched "' + query.slice(0, 40) + '"' : 'No AI Fields to attach', 'warn');
      return;
    }
    const block = hits
      .map((h: any) => {
        const owner = String(h.ownerEntityId || '').trim();
        const field = String(h.fieldName || '').trim();
        const value = String(h.currentValue || '').trim();
        const instruction = String(h.instruction || '').trim();
        const evidence = Array.isArray(h.evidenceEventIds) ? h.evidenceEventIds.join(', ') : '';
        return [
          `[ai_field] ${owner} / ${field}: ${value || '(empty)'}`,
          instruction ? `Instruction: ${instruction}` : '',
          evidence ? `Evidence: ${evidence}` : '',
        ].filter(Boolean).join('\n');
      })
      .join('\n\n');
    setMemoryContext(block.slice(0, 12000));
    setMemoryContextHits(
      hits.map((h: any) => ({
        id: h.id,
        provenance: 'ai_field',
        source: 'ai_field',
        created_at: h.lastUpdatedAt || h.createdAt || null,
        title: `${h.ownerEntityId || ''} / ${h.fieldName || ''}`,
        snippet: h.currentValue || h.instruction || '',
      })),
    );
    toast(
      query
        ? 'AI Fields matching "' + query.slice(0, 40) + '" attached (' + hits.length + ')'
        : 'Attached ' + hits.length + ' AI Fields',
      'success'
    );
  };

  const attachSharedContext = async () => {
    const query = composerText.trim();
    const actionKey = query ? 'context.search' : 'context.recent.get';
    const payload = query ? { query, limit: 4 } : { limit: 6 };
    const r = await runRuntimeAction(actionKey, payload, { silentError: true });
    if (!r.ok || !r.data) {
      const msg = r && r.error && typeof r.error.message === 'string' ? r.error.message : '';
      toast(msg ? 'Shared context fetch failed — ' + msg : 'Shared context fetch failed', 'warn');
      return;
    }
    const block = buildSharedContextBlock(query, r.data as ChatContextSearchPayload | ChatRecentContextPayload);
    const hits = buildSharedContextHits(r.data as ChatContextSearchPayload | ChatRecentContextPayload);
    if (!block || hits.length === 0) {
      toast(query ? 'No shared context matched "' + query.slice(0, 40) + '"' : 'No recent shared context to attach', 'warn');
      return;
    }
    setMemoryContext(block);
    setMemoryContextHits(hits);
    toast(
      query
        ? 'Shared context matching "' + query.slice(0, 40) + '" attached (' + hits.length + ')'
        : 'Attached ' + hits.length + ' recent shared context items',
      'success',
    );
  };

  const formatAttachmentSize = (bytes: any) => {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const addFiles = (fileList: FileList | null | undefined) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const mapped = files.map((f) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: f.name || 'file',
      type: f.type || '',
      size: Number(f.size) || 0,
      file: f,
    }));
    setAttachments((prev) => prev.concat(mapped));
    toast(`${mapped.length} ${mapped.length === 1 ? 'file' : 'files'} attached`, 'success');
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const openFilePicker = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const seedActionFromComposer = () => {
    const text = composerText.trim();
    if (!text) {
      toast('Compose some text before creating an action draft', 'warn');
      return;
    }
    const ownerEntityId = inferActionOwnerEntityIdFromChatContext(memoryContextHits, memoryContext);
    const sourceAiFieldId = inferSourceAiFieldIdFromChatContext(memoryContextHits, ownerEntityId);
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const title = (lines[0] || text).slice(0, 120);
    seedActionDraft({
      ownerEntityId,
      actionType: chatActionType,
      title,
      detail: text,
      riskLevel: chatActionRiskLevel,
      sourceAiFieldId,
      evidenceEventIds: inferActionEvidenceIdsFromChatContext(memoryContextHits),
    });
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
    toast(`Seeded ${chatActionType} as an action draft`, 'success');
  };

  const sendChat = async () => {
    const text = composerText.trim();
    if ((!text && attachments.length === 0) || loading) return;
    const attachmentSummary = attachments.length
      ? '\n\n[Attached: ' + attachments.map((a: any) => a.name).join(', ') + ']'
      : '';
    const userTurn = { role: 'user', content: text + attachmentSummary };
    const next = messages.concat(userTurn);
    setMessages(next);
    setComposerText('');
    setAttachments([]);
    setLoading(true);
    const payload: Record<string, any> = {
      messages: next,
      memoryContext: memoryContext || undefined,
      webSearch: webSearchOn,
    };
    const preset = pendingMemoryAssemblyRef.current;
    const usePreset = preset && typeof preset.query === 'string';
    const shouldAssemble = assembleMemoryOn || usePreset;
    const assemblyAllowed = shouldAssemble && allowServerMemoryAssembly;
    if (assemblyAllowed) {
      if (usePreset) {
        payload.memoryAssembly = {
          query: preset.query,
          limit: preset.limit != null ? preset.limit : 12,
          semantic: preset.semantic !== false,
        };
        pendingMemoryAssemblyRef.current = null;
      } else {
        payload.memoryAssembly = {
          query: text.slice(0, 480),
          limit: 12,
          semantic: true,
        };
      }
    }
    const manualCtx = (memoryContext || '').trim();
    if (BriefTelemetry && BriefTelemetry.log && BriefTelemetry.EVENTS) {
      BriefTelemetry.log(BriefTelemetry.EVENTS.CHAT_COMPLETION_CONTEXT, {
        hasManualMemoryContext: manualCtx.length > 0,
        manualMemoryContextChars: manualCtx.length,
        memoryAssemblyRequested: shouldAssemble,
        memoryAssemblySent: assemblyAllowed && Boolean(payload.memoryAssembly),
        memoryAssemblyPreset: usePreset,
        privacyAllowsServerAssembly: allowServerMemoryAssembly,
      });
    }
    const res = await runRuntimeAction('chat.complete', payload, { silentError: true });
    setLoading(false);
    if (!res.ok) {
      toast(res.error?.message || 'Chat request failed', 'error');
      return;
    }
    const d = res.data;
    let assistantText;
    if (d && d.mock) {
      assistantText = 'Mock transport: open the macOS app (Tauri) with an API key in Settings → Model & API for real replies.';
    } else {
      assistantText = d && d.message != null ? String(d.message) : 'Empty response';
    }
    setMessages((prev) => prev.concat({ role: 'assistant', content: assistantText }));
  };

  const openLlmSettings = () => {
    if ((window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.openSettingsPane) {
      (window as any).SHOGUN_RUNTIME.openSettingsPane('llm');
    } else {
      toast('Open Settings → Model & API', 'info');
    }
  };

  useEffect(() => {
    if (!pendingAutoSendRef.current) return;
    if (!composerText.trim() || loading) return;
    pendingAutoSendRef.current = false;
    void sendChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sendChat is intentionally captured at call time; adding it would cause a loop
  }, [composerText, loading]);

  return (
    <div
      className={'shogun-chat-layout' + (chatMax ? ' shogun-chat-max' : '') + (dropActive ? ' shogun-chat-dropping' : '')}
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setDropActive(true);
      }}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDropActive(false);
      }}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        e.preventDefault();
        dragDepthRef.current = 0;
        setDropActive(false);
        const dropped = e.dataTransfer?.files;
        if (dropped && dropped.length) addFiles(dropped);
      }}
    >
      {dropActive && (
        <div className="shogun-chat-drop-overlay" aria-hidden="true">
          <div className="shogun-chat-drop-card">
            <Icon name="paperclip" size={22} />
            <div className="shogun-chat-drop-title">
              <span className="en-only">Drop to attach</span>
              <span className="jp">ドロップして添付</span>
            </div>
            <div className="shogun-chat-drop-sub">
              <span className="en-only">Files & images — added to this message</span>
              <span className="jp">ファイル・画像をこのメッセージに添付</span>
            </div>
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="shogun-chat-main">
        <div className="shogun-chat-header">
          <div>
            <div style={{fontSize:14, fontWeight:500}}>Chat <span className="jp dim" style={{fontSize:11, marginLeft:6}}>対話</span></div>
            <div className="t-mono" style={{fontSize:9, marginTop:2}}>
              {modelHint || 'model from settings'} · {memoryTotal} memories indexed
            </div>
          </div>
          <span className="spacer"/>
          <button className="btn btn-sm btn-ghost" type="button" onClick={openLlmSettings}>Model & API</button>
        </div>

        <div className="shogun-chat-scroll">
          <div
            className={'shogun-chat-thread' + (messages.length === 0 && !loading ? ' shogun-chat-thread--empty' : '')}
            style={{maxWidth:720, margin:'0 auto', display:'flex', flexDirection:'column', gap:20, width:'100%'}}
          >
            {messages.length === 0 && (
              <div style={{textAlign:'center', color:'var(--text-mute)', fontSize:14, marginBottom:8}}>
                Ask anything. Use <strong>Context</strong>, <strong>Memory</strong>, or <strong>AI Fields</strong> to attach shared context, <strong>Assemble</strong> for server-side index pull, or open from <strong>Memory / Agents</strong> with a one-shot preset. API key: Settings → Model & API.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth:'85%'}}>
                <div style={{
                  background: m.role === 'user' ? 'var(--surface-2)' : 'transparent',
                  padding: m.role === 'user' ? '12px 16px' : '0',
                  borderRadius: m.role === 'user' ? 'var(--radius-lg) var(--radius-lg) 2px var(--radius-lg)' : 0,
                  fontSize:14,
                  lineHeight:1.65,
                  color:'var(--text)',
                  whiteSpace:'pre-wrap',
                }}>
                  {m.role === 'assistant' && (
                    <div className="row" style={{marginBottom:8, gap:8}}>
                      <Kamon size={16} color="var(--gold)"/>
                      <span style={{fontSize:11, color:'var(--gold)', fontWeight:500}}>SHOGUN</span>
                    </div>
                  )}
                  {m.content}
                </div>
                <div className="t-mono" style={{fontSize:9, marginTop:4, textAlign: m.role === 'user' ? 'right' : 'left', color:'var(--text-dim)'}}>
                  {m.role === 'user' ? 'YOU' : 'ASSISTANT'}
                </div>
              </div>
            ))}
            {loading && (
              <div style={{color:'var(--text-mute)', fontSize:13}}>Waiting for model…</div>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          <div style={{maxWidth:720, margin:'0 auto'}}>
            <div className="composer">
              <textarea
                className="s-input"
                style={{width:'100%', minHeight:72, resize:'vertical', background:'transparent', border:'none', fontSize:14, fontFamily:'inherit', color:'var(--text)'}}
                placeholder="Message…"
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendChat();
                    return;
                  }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    sendChat();
                  }
                }}
              />
              {attachments.length > 0 && (
                <div className="composer-attachments">
                  {attachments.map((a) => (
                    <span key={a.id} className="composer-attachment-chip" title={`${a.name} · ${formatAttachmentSize(a.size)}`}>
                      <Icon name={a.type.startsWith('image/') ? 'note' : 'file'} size={12} />
                      <span className="composer-attachment-name">{a.name}</span>
                      <span className="composer-attachment-size">{formatAttachmentSize(a.size)}</span>
                      <button
                        type="button"
                        className="composer-attachment-remove"
                        aria-label={`Remove ${a.name}`}
                        onClick={() => removeAttachment(a.id)}
                      >
                        <Icon name="x" size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="row composer-actions" style={{gap:6, marginTop:8}}>
                <button className="composer-pill" type="button" onClick={openFilePicker} title="Attach files or images"><Icon name="paperclip" size={13}/>Attach</button>
                <button className="composer-pill" type="button" onClick={attachSharedContext}><Icon name="work" size={13}/>Context</button>
                <button className="composer-pill" type="button" onClick={attachMemory}><Icon name="memory" size={13}/>Memory</button>
                <button className="composer-pill" type="button" onClick={attachAiFields}><Icon name="sparkles" size={13}/>AI Fields</button>
                <button
                  className={'composer-pill' + (webSearchOn ? ' is-on' : '')}
                  type="button"
                  title="Web research mode (prompts the model for current-style answers; no live browse unless you paste URLs)"
                  onClick={() => setWebSearchOn((v) => !v)}
                >
                  <Icon name="globe" size={13} /> Web
                </button>
                <button
                  className={'composer-pill' + (assembleMemoryOn ? ' is-on' : '')}
                  type="button"
                  title="memoryAssembly: server assembles context from local Memory (semantic search when API key is set)"
                  onClick={() => setAssembleMemoryOn((v) => !v)}
                >
                  <Icon name="memory" size={13} /> Assemble
                </button>
                <button className="composer-pill" type="button" onClick={() => (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('agents')}><Icon name="agents" size={13}/>Agents</button>
                <button
                  className="composer-pill"
                  type="button"
                  onClick={seedActionFromComposer}
                  disabled={!composerText.trim()}
                  title="Convert the current composer text into a shared Action draft"
                >
                  <Icon name="bolt" size={13}/>To Action
                </button>
                <select
                  className="composer-pill"
                  aria-label="Action type"
                  value={chatActionType}
                  onChange={(e) => setChatActionType(e.target.value as SupportedContextActionType)}
                  title="Action type for To Action"
                >
                  {SUPPORTED_CONTEXT_ACTION_TYPE_META.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
                <select
                  className="composer-pill"
                  aria-label="Action risk"
                  value={chatActionRiskLevel}
                  onChange={(e) => setChatActionRiskLevel(e.target.value as typeof chatActionRiskLevel)}
                  title="Risk level for To Action"
                >
                  <option value="low">Risk: low</option>
                  <option value="medium">Risk: medium</option>
                  <option value="high">Risk: high</option>
                  <option value="critical">Risk: critical</option>
                </select>
                <button className="composer-pill" type="button" onClick={() => (window as any).SHOGUN_RUNTIME?.openSettingsPane?.('integrations')}><Icon name="plug" size={13}/>Integrations</button>
                <span className="spacer"/>
                <button
                  className="composer-send"
                  type="button"
                  disabled={loading || (!composerText.trim() && attachments.length === 0)}
                  onClick={sendChat}
                  aria-label="Send message"
                  title="Send (Return)"
                >
                  <Icon name="arrowUp" size={18} />
                </button>
              </div>
            </div>
            <div className="t-mono" style={{fontSize:11, marginTop:8, textAlign:'center', color:'var(--text-dim)', textTransform:'none', letterSpacing:'0.02em'}}>
              {memoryTotal} memories indexed · Local
              <span style={{marginLeft:10}}>Return sends · Shift+Return new line · Cmd+Return also sends</span>
            </div>
          </div>
        </div>
      </div>

      <div className="shogun-chat-context">
        <div className="memory-context-head">
          <div className="memory-context-head-main">
            <div className="memory-context-icon" aria-hidden>
              <Icon name="memory" size={15} />
            </div>
            <div>
              <div className="memory-context-title">
                <span className="en-only">Attached context</span>
                <span className="jp">添付コンテキスト</span>
              </div>
              <div className="memory-context-sub dim">
                <span className="en-only">Shared context attached to this thread</span>
                <span className="jp">このスレッドに載せる共有コンテキスト</span>
              </div>
            </div>
          </div>
          <button
            className="memory-context-clear"
            type="button"
            disabled={!memoryContext}
            onClick={() => { setMemoryContext(''); setMemoryContextHits(null); }}
          >
            Clear
          </button>
        </div>
        {memoryContextHits && memoryContextHits.length ? (
          <div className="memory-context-body memory-context-body--filled memory-context-body--hits">
            {memoryContextHits.map((h, i) => {
              const prov = (h && h.provenance) || 'user';
              const titleSrc = (h && (h.title_highlight || h.title)) || '';
              const snippetSrc = (h && (h.snippet_highlight || h.snippet)) || '';
              const openable = canOpenContextHit(h);
              const entityId = contextHitEntityId(h);
              const nativeDetailKind = contextHitNativeDetailKind(h);
              const nativeDetailLabel = entityId
                ? nativeDetailDescriptorForEntityId(entityId)?.label || null
                : null;
              return (
                <div
                  key={(h && h.id) || (`mch-${i}`)}
                  className={'memory-context-hit' + (openable ? ' memory-context-hit--openable' : '')}
                  role={openable ? 'button' : undefined}
                  tabIndex={openable ? 0 : undefined}
                  onClick={() => {
                    if (!openable) return;
                    openContextHit(h);
                  }}
                  onKeyDown={(event) => {
                    if (!openable) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openContextHit(h);
                    }
                  }}
                  title={openable ? 'Open in related context surface' : undefined}
                >
                  <div className="memory-context-hit-head">
                    <span className="memory-context-hit-tag">{prov}</span>
                    {h && h.source && (
                      <span className="memory-context-hit-tag" style={{ opacity: 0.8 }}>
                        src:{String(h.source)}
                      </span>
                    )}
                    {(() => {
                      const fresh = h ? formatFreshness(h.created_at) : null;
                      return fresh ? (
                        <span className="memory-context-hit-tag" style={{ opacity: 0.8 }}>
                          {fresh}
                        </span>
                      ) : null;
                    })()}
                    <span className="memory-context-hit-title">
                      {ShogunHighlight ? ShogunHighlight.renderHighlighted(titleSrc) : titleSrc}
                    </span>
                    {openable ? (
                      <span className="memory-context-hit-tag" style={{ color: 'var(--gold)' }}>
                        open
                      </span>
                    ) : null}
                  </div>
                  {snippetSrc && (
                    <div className="memory-context-hit-snippet">
                      {ShogunHighlight ? ShogunHighlight.renderHighlighted(snippetSrc) : snippetSrc}
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                    {openable ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          openContextHit(h);
                        }}
                      >
                        Open
                      </button>
                    ) : null}
                    {entityId ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          openEntityContextHit(h);
                        }}
                      >
                        Entity Context
                      </button>
                    ) : null}
                    {nativeDetailKind === 'meeting' ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                      onClick={(event) => {
                          event.stopPropagation();
                          openNativeDetailHit(h);
                        }}
                      >
                        {nativeDetailLabel || 'Open Meeting Detail'}
                      </button>
                    ) : null}
                    {nativeDetailKind === 'workspace' ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          openNativeDetailHit(h);
                        }}
                      >
                        {nativeDetailLabel || 'Open Workspace Detail'}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : memoryContext ? (
          <div className="memory-context-body memory-context-body--filled">
            {memoryContext}
          </div>
        ) : (
          <div className="memory-context-body memory-context-body--empty">
            <div className="memory-context-empty-icon" aria-hidden>
              <Icon name="memory" size={22} />
            </div>
            <div className="memory-context-empty-title">
              <span className="en-only">No context yet</span>
              <span className="jp">まだ文脈はありません</span>
            </div>
            <div className="memory-context-empty-desc">
                <span className="en-only">
                  Use <strong>Context</strong>, <strong>Memory</strong>, or <strong>AI Fields</strong> in the composer below to pull shared context — it appears here.
                </span>
                <span className="jp">
                  下のコンポーザーで <strong>Context</strong>、<strong>Memory</strong>、<strong>AI Fields</strong> から取り込んだ文脈がここに表示されます。
                </span>
              </div>
          </div>
        )}
        <p className="memory-context-foot">
          <span className="en-only">From local shared context on this device, including Memory, AI Fields, Actions, and meeting evidence.</span>
          <span className="jp">この端末のローカル共有コンテキスト由来。Memory / AI Fields / Actions / 会議エビデンスを含みます。</span>
        </p>
      </div>

      <style>{`
        .chat-hero-composer {
          border:1px solid var(--border-hi); background:var(--surface);
          border-radius:var(--radius-lg);
          box-shadow:0 2px 0 rgba(0,0,0,0.2), 0 20px 40px -20px rgba(0,0,0,0.35);
        }
        .shogun-chat-layout .composer-wrap { border-top:1px solid var(--border); background:var(--bg); }
        .composer {
          border:1px solid var(--border-hi); border-radius:var(--radius-lg);
          padding:12px 14px; background:var(--surface);
          box-shadow:0 1px 0 rgba(0,0,0,0.2);
        }
        .composer:focus-within { border-color:var(--gold-dim); }
        .composer-actions { align-items:center; }
        .composer-pill {
          display:inline-flex; align-items:center; gap:6px;
          height:30px; padding:0 12px;
          border-radius:999px;
          border:1px solid var(--border);
          background:color-mix(in srgb, var(--surface) 65%, var(--bg) 35%);
          color:var(--text-mute);
          font-size:12.5px; font-weight:450; letter-spacing:0.01em;
          font-family:inherit; cursor:pointer;
          transition:border-color 120ms, background 120ms, color 120ms;
        }
        .composer-pill:hover {
          border-color:var(--border-hi);
          background:var(--surface);
          color:var(--text);
        }
        .composer-pill.is-on {
          color:var(--gold);
          border-color:color-mix(in srgb, var(--gold-dim) 60%, var(--border) 40%);
          background:color-mix(in srgb, var(--gold) 8%, var(--surface) 92%);
        }
        .composer-pill:focus-visible {
          outline:2px solid var(--gold);
          outline-offset:2px;
        }
        .composer-send {
          display:inline-flex; align-items:center; justify-content:center;
          width:38px; height:38px;
          border-radius:12px;
          border:0;
          background:var(--gold);
          color:#fff;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.18),
            0 1px 0 rgba(0,0,0,0.35),
            0 2px 8px -2px color-mix(in srgb, var(--gold) 55%, transparent);
          cursor:pointer;
          transition:background 120ms, transform 80ms, box-shadow 120ms;
        }
        .composer-send:hover:not(:disabled) {
          background:var(--gold-hover);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.22),
            0 1px 0 rgba(0,0,0,0.35),
            0 4px 14px -2px color-mix(in srgb, var(--gold) 70%, transparent);
        }
        .composer-send:active:not(:disabled) { transform:scale(0.96); }
        .composer-send:disabled {
          opacity:0.5;
          cursor:not-allowed;
          box-shadow:none;
        }
        .composer-send:focus-visible {
          outline:2px solid var(--gold);
          outline-offset:2px;
        }
        .shogun-chat-thread--empty { min-height:100%; justify-content:center; box-sizing:border-box; padding-block:12px; }

        .composer-send {
          width:36px; height:36px; border-radius:10px;
          display:inline-flex; align-items:center; justify-content:center;
          background:var(--gold); color:#151212;
          border:0; padding:0; cursor:pointer;
          transition:background var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out), opacity var(--dur-base) var(--ease-out);
          box-shadow:0 1px 0 rgba(0,0,0,0.25);
        }
        .composer-send:hover:not(:disabled) { background:var(--gold-hover); }
        .composer-send:active:not(:disabled) { transform:translateY(1px); }
        .composer-send:disabled { opacity:0.45; cursor:not-allowed; }
        .composer-send:focus-visible { outline:2px solid var(--gold); outline-offset:2px; }

        .composer-attachments {
          display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;
        }
        .composer-attachment-chip {
          display:inline-flex; align-items:center; gap:6px;
          height:26px; padding:0 6px 0 8px;
          background:var(--surface-2); border:1px solid var(--border);
          border-radius:var(--radius-sm);
          font-size:11px; color:var(--text);
          max-width:240px;
        }
        .composer-attachment-name {
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
          max-width:140px;
        }
        .composer-attachment-size {
          font-family:var(--font-mono); font-size:10px; color:var(--text-dim);
        }
        .composer-attachment-remove {
          display:inline-flex; align-items:center; justify-content:center;
          width:16px; height:16px; border-radius:4px;
          color:var(--text-dim); background:transparent; border:0; cursor:pointer;
        }
        .composer-attachment-remove:hover { color:var(--text); background:var(--surface); }

        .shogun-chat-layout { position:relative; }
        .shogun-chat-drop-overlay {
          position:absolute; inset:0; z-index:50;
          display:flex; align-items:center; justify-content:center;
          background:color-mix(in srgb, var(--bg) 70%, transparent);
          backdrop-filter:blur(2px);
          pointer-events:none;
        }
        .shogun-chat-drop-card {
          display:flex; flex-direction:column; align-items:center; gap:8px;
          padding:24px 32px;
          border:2px dashed var(--gold);
          border-radius:var(--radius-lg);
          background:var(--surface);
          color:var(--text);
          box-shadow:0 20px 40px -16px rgba(0,0,0,0.5);
        }
        .shogun-chat-drop-title { font-size:15px; font-weight:500; color:var(--gold); }
        .shogun-chat-drop-sub { font-size:12px; color:var(--text-mute); }
      `}</style>
    </div>
  );
}
