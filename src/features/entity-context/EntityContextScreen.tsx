import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/shared/icons';
import { seedActionDraft } from '@/shared/context/action-draft';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import { seedAiFieldDraft } from '@/shared/context/ai-field-draft';
import {
  ENTITY_FOCUS_EVENT,
  focusEntity,
  readEntityFocus,
} from '@/shared/context/entity-focus';
import {
  ENTITY_SIGNAL_FOCUS_EVENT,
  clearEntitySignalFocus,
  focusEntitySignal,
  readEntitySignalFocus,
} from '@/features/entity-context/entity-signal-focus';
import { focusAiField } from '@/shared/context/ai-field-focus';
import { normalizeContextActionType } from '@/shared/context/action-types';
import { buildEntityChatSeed, openChatWithSeed } from '@/shared/context/chat-composer-seed';
import {
  nativeDetailDescriptorForEntityId,
  openNativeDetailForEntityId,
  openContextTarget,
} from '@/shared/context/context-target-navigation';
import {
  queueArtifactDetail,
  queueArtifactNativeDetailState,
  queueArtifactOwnerEntityId,
  queueArtifactSourceActionId,
} from '@/shared/context/queue-artifact-meta';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import {
  getActionStarterForEntityKind,
  getFieldStartersForEntityKind,
  inferEntityKind,
} from '@/features/entity-context/entity-kind-presets';
import { buildEntitySignals } from '@/features/entity-context/entity-kind-signals';
import { useEventedValue } from '@/shared/context/focus-store';
import type {
  AiFieldRecord,
  ContextActionRecord,
  EntityContextRecord,
  OwnerContextSummaryRecord,
} from '@/shared/domain/context-layer';

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function normalizeActionRecord(item: ContextActionRecord): ContextActionRecord {
  return {
    ...item,
    actionType: normalizeContextActionType(item.actionType),
  };
}

function normalizeOwnerSummary(summary: OwnerContextSummaryRecord): OwnerContextSummaryRecord {
  return {
    ...summary,
    entityContext: summary.entityContext
      ? {
          ...summary.entityContext,
          actions: (summary.entityContext.actions || []).map(normalizeActionRecord),
        }
      : summary.entityContext,
    actions: {
      items: (summary.actions?.items || []).map(normalizeActionRecord),
      total: summary.actions?.total || 0,
    },
  };
}

function resolveOwnerSummaryAiFieldId(
  summary: OwnerContextSummaryRecord | null,
  actionId?: string | null,
): string | null {
  const normalizedActionId = String(actionId || '').trim();
  const matchedAction = normalizedActionId
    ? summary?.actions.items.find((candidate) => candidate.id === normalizedActionId) || null
    : null;
  return String(
    matchedAction?.sourceAiFieldId
      || summary?.actions.items?.[0]?.sourceAiFieldId
      || summary?.aiFields.items?.[0]?.id
      || '',
  ).trim() || null;
}

export function EntityContextScreen(): JSX.Element {
  const [entityId, setEntityId] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [bundle, setBundle] = useState<EntityContextRecord | null>(null);
  const [ownerSummary, setOwnerSummary] = useState<OwnerContextSummaryRecord | null>(null);
  const [pendingTasks, setPendingTasks] = useState<ContextActionRecord[]>([]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const focusedEntityId = useEventedValue(readEntityFocus, ENTITY_FOCUS_EVENT);
  const focusedSignalId = useEventedValue(readEntitySignalFocus, ENTITY_SIGNAL_FOCUS_EVENT);

  async function loadEntityContext(nextEntityId?: string) {
    const id = String(nextEntityId || entityId || '').trim();
    if (!id) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.('entity id を入力してください', 'warn');
      return;
    }
    setLoading(true);
    const lang = (typeof document !== 'undefined' && document.body.getAttribute('data-lang')) || 'en';
    const [summaryRes, taskRes] = await Promise.all([
      runRuntimeAction(
        'context.owner_summary.get',
        { ownerEntityId: id, entityLabel: id, lang, limit: 6 },
        { silentError: true },
      ),
      runRuntimeAction(
        'context.tasks.list',
        { ownerEntityId: id, statuses: ['proposed', 'approved'], limit: 12 },
        { silentError: true },
      ),
    ]);
    setLoading(false);
    if (!summaryRes?.ok || !summaryRes.data) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.(summaryRes?.error?.message || 'Entity context を読み込めませんでした', 'error');
      return;
    }
    const nextOwnerSummary = normalizeOwnerSummary(summaryRes.data as OwnerContextSummaryRecord);
    const nextBundle = nextOwnerSummary.entityContext;
    if (!nextBundle) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.('Entity context bundle が見つかりませんでした', 'warn');
      return;
    }
    setEntityId(id);
    setOwnerSummary(nextOwnerSummary);
    setBundle(nextBundle);
    setPendingTasks(
      taskRes?.ok && Array.isArray(taskRes.data?.items)
        ? (taskRes.data.items as ContextActionRecord[]).map(normalizeActionRecord)
        : [],
    );
  }

  useEffect(() => {
    let cancelled = false;
    const loadSuggestions = async () => {
      const [fieldsRes, actionsRes, taskQueueRes, crmQueueRes] = await Promise.all([
        runRuntimeAction('ai_field.list', { limit: 60 }, { silentError: true }),
        runRuntimeAction('action.list', { limit: 60 }, { silentError: true }),
        runRuntimeAction('queue.tasks.list', { limit: 60 }, { silentError: true }),
        runRuntimeAction('queue.crm_updates.list', { limit: 60 }, { silentError: true }),
      ]);
      if (cancelled) return;
      const fieldOwners = fieldsRes?.ok && Array.isArray(fieldsRes.data?.items)
        ? (fieldsRes.data.items as AiFieldRecord[]).map((item) => item.ownerEntityId)
        : [];
      const actionOwners = actionsRes?.ok && Array.isArray(actionsRes.data?.items)
        ? (actionsRes.data.items as ContextActionRecord[]).map((item) => item.ownerEntityId)
        : [];
      const taskQueueOwners = taskQueueRes?.ok && Array.isArray(taskQueueRes.data?.items)
        ? taskQueueRes.data.items
          .map((item: any) => queueArtifactOwnerEntityId(item))
          .filter(Boolean)
        : [];
      const crmQueueOwners = crmQueueRes?.ok && Array.isArray(crmQueueRes.data?.items)
        ? crmQueueRes.data.items
          .map((item: any) => queueArtifactOwnerEntityId(item))
          .filter(Boolean)
        : [];
      setSuggestions(uniq([...fieldOwners, ...actionOwners, ...taskQueueOwners, ...crmQueueOwners]));
    };
    void loadSuggestions();
    return () => { cancelled = true; };
  }, [refreshNonce]);

  useEffect(() => {
    const onRefresh = () => {
      setRefreshNonce((prev) => prev + 1);
      const activeEntityId = String(bundle?.entityId || entityId || '').trim();
      if (activeEntityId) {
        void loadEntityContext(activeEntityId);
      }
    };
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    return () => {
      window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    };
  }, [bundle?.entityId, entityId]);

  useEffect(() => {
    if (!focusedEntityId || focusedEntityId === bundle?.entityId || focusedEntityId === entityId) return;
    void loadEntityContext(focusedEntityId);
  }, [bundle?.entityId, entityId, focusedEntityId]);

  const visibleSuggestions = useMemo(() => {
    const q = entityId.trim().toLowerCase();
    if (!q) return suggestions.slice(0, 12);
    return suggestions.filter((item) => item.toLowerCase().includes(q)).slice(0, 12);
  }, [entityId, suggestions]);

  const entityKind = useMemo(
    () => inferEntityKind(bundle?.entityId || entityId),
    [bundle?.entityId, entityId],
  );
  const fieldStarters = useMemo(() => getFieldStartersForEntityKind(entityKind), [entityKind]);
  const actionStarter = useMemo(() => getActionStarterForEntityKind(entityKind), [entityKind]);
  const entitySignals = useMemo(
    () => (bundle ? buildEntitySignals(entityKind, bundle) : []),
    [bundle, entityKind],
  );

  const openAiField = (fieldId: string) => {
    const id = String(fieldId || '').trim();
    if (!id) return;
    focusAiField(id);
    if (bundle?.entityId) focusEntity(bundle.entityId);
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('ai_fields');
  };

  const handleSignalAction = (signal: (typeof entitySignals)[number]) => {
    focusEntitySignal(signal.id);
    if (signal.ctaKind === 'open_field' && signal.fieldId) {
      openAiField(signal.fieldId);
      return;
    }
    if (signal.ctaKind === 'create_field' && signal.fieldName) {
      createFieldForEntity(signal.fieldName, signal.fieldInstruction || undefined);
      return;
    }
    if (signal.ctaKind === 'open_action' && signal.actionId) {
      openAction(signal.actionId, signal.fieldId || null);
      return;
    }
    if (signal.ctaKind === 'propose_action') {
      proposeActionForEntity();
    }
  };

  const openAction = (actionId: string, aiFieldId?: string | null) => {
    const id = String(actionId || '').trim();
    if (!id) return;
    focusActionTrace({ actionId: id, aiFieldId: String(aiFieldId || '').trim() || null, openAudit: false });
    if (bundle?.entityId) focusEntity(bundle.entityId);
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
  };

  const createFieldForEntity = (fieldName = 'next_action', instruction?: string) => {
    const id = String(bundle?.entityId || entityId || '').trim();
    if (!id) return;
    seedAiFieldDraft({
      ownerEntityId: id,
      fieldName,
      instruction: String(instruction || `Track ${fieldName} for ${id} from shared desktop context evidence.`),
      currentValue: '',
      confidence: 0.72,
      evidenceEventIds: [],
    });
    focusEntity(id);
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('ai_fields');
  };

  const proposeActionForEntity = () => {
    const id = String(bundle?.entityId || entityId || '').trim();
    if (!id) return;
    const titleBase = bundle?.rollup?.title || bundle?.entityLabel || id;
    seedActionDraft({
      ownerEntityId: id,
      actionType: actionStarter.actionType,
      title: `${actionStarter.titleTemplate} · ${titleBase}`,
      detail: actionStarter.detail,
      riskLevel: actionStarter.riskLevel,
      evidenceEventIds: [],
    });
    focusEntity(id);
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
  };

  const proposeActionFromField = (field: AiFieldRecord) => {
    seedActionDraft({
      ownerEntityId: field.ownerEntityId,
      actionType:
        field.fieldName === 'next_action'
          ? 'follow_up_email_draft'
          : field.fieldName === 'blocker'
            ? 'create_task'
            : 'update_crm',
      title: field.currentValue || `Act on ${field.fieldName} for ${field.ownerEntityId}`,
      detail: field.instruction,
      riskLevel: field.fieldName === 'blocker' ? 'high' : 'medium',
      sourceAiFieldId: field.id,
      evidenceEventIds: field.evidenceEventIds,
    });
    focusEntity(field.ownerEntityId);
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
  };

  const openEntityFields = () => {
    const id = String(bundle?.entityId || entityId || '').trim();
    if (!id) return;
    focusEntity(id);
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('ai_fields');
  };

  const openEntityActions = () => {
    const id = String(bundle?.entityId || entityId || '').trim();
    if (!id) return;
    focusEntity(id);
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
  };

  const askChatForEntity = () => {
    const id = String(bundle?.entityId || entityId || '').trim();
    if (!id || !bundle) return;
    const topField = bundle.aiFields[0];
    const topAction = bundle.actions[0];
    openChatWithSeed(buildEntityChatSeed({
      entityId: id,
      entityLabel: bundle.entityLabel,
      rollupTitle: bundle.rollup?.title ?? null,
      fieldLabel: topField ? `${topField.fieldName} = ${topField.currentValue || '(empty)'}` : null,
      actionLabel: topAction ? `${topAction.title} [${topAction.status}]` : null,
    }));
  };

  const openNativeDetail = () => {
    openNativeDetailForEntityId(String(bundle?.entityId || entityId || ''));
  };
  const nativeDetailDescriptor = nativeDetailDescriptorForEntityId(String(bundle?.entityId || entityId || ''));

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{ marginBottom: 8 }}>CONTEXT PLATFORM</div>
          <h1>Entity Context <span className="jp">対象コンテキスト</span></h1>
          <div className="sub">
            <span className="en-only">One entity-centric view over rollups, summaries, AI Fields, and Actions using the same shared core exposed through MCP.</span>
            <span className="jp">MCP にも公開している shared core を使って、rollup / summaries / AI Fields / Actions を 1 つの対象単位で見る surface です。</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 18 }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--gold) 14%, var(--surface-2))', color: 'var(--gold)' }}>
          <Icon name="memory" size={16} />
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
            Surface-specific CRM ではなく shared core の context bundle
          </div>
          <div>
            `company:acme` や `deal:seed-round`、`workspace:apollo` のような owner entity id ごとに、
            すでに蓄積された要約・追跡状態・行動提案を横断表示します。
          </div>
        </div>
      </div>

      <section
        style={{
          width: '100%',
          maxWidth: 1080,
          margin: '0 auto',
          padding: '18px 18px 16px',
          borderRadius: 22,
          border: '1px solid var(--border)',
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 94%, var(--gold) 6%), var(--surface))',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 280px) 120px', gap: 10, alignItems: 'center' }}>
          <input
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            placeholder="company:acme / deal:seed-round / workspace:apollo"
            className="s-input"
          />
          <button
            type="button"
            onClick={() => { void loadEntityContext(); }}
            style={{
              height: 38,
              borderRadius: 12,
              border: 'none',
              background: 'var(--gold)',
              color: '#fff',
              fontWeight: 600,
              cursor: loading ? 'progress' : 'pointer',
              opacity: loading ? 0.8 : 1,
            }}
          >
            {loading ? 'Loading…' : 'Load'}
          </button>
        </div>

        {visibleSuggestions.length ? (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {visibleSuggestions.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => { void loadEntityContext(item); }}
                className="pill t-mono"
                style={{ fontSize: 10.5, border: '1px solid var(--border-hi)', background: 'var(--surface-2)' }}
              >
                {item}
              </button>
            ))}
          </div>
        ) : null}

        {!bundle ? (
          <div style={{ marginTop: 18, fontSize: 13, lineHeight: 1.6, color: 'var(--text-dim)' }}>
            No entity selected yet. Start from an owner entity id already used by AI Fields, Actions, or queue artifacts.
          </div>
        ) : (
          <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: 'minmax(0, 1.05fr) minmax(320px, 0.95fr)', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ border: '1px solid var(--border)', borderRadius: 18, padding: 14, background: 'var(--surface)' }}>
                <div className="t-mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>entity {bundle.entityId}</div>
                {entityKind ? (
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span className="pill t-mono" style={{ fontSize: 10.5 }}>{entityKind}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                      application layer starter tuned for this entity kind
                    </span>
                  </div>
                ) : null}
                <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => createFieldForEntity('next_action')}
                    style={{
                      height: 28,
                      padding: '0 10px',
                      borderRadius: 9,
                      border: '1px solid color-mix(in srgb, var(--gold) 55%, var(--border-hi))',
                      background: 'color-mix(in srgb, var(--gold) 12%, var(--surface-2))',
                      color: 'var(--text)',
                      fontSize: 11.5,
                    }}
                  >
                    Create AI Field
                  </button>
                  <button
                    type="button"
                    onClick={askChatForEntity}
                    style={{
                      height: 28,
                      padding: '0 10px',
                      borderRadius: 9,
                      border: '1px solid var(--border-hi)',
                      background: 'var(--surface-2)',
                      color: 'var(--text)',
                      fontSize: 11.5,
                    }}
                  >
                    Ask Chat
                  </button>
                  <button
                    type="button"
                    onClick={proposeActionForEntity}
                    style={{
                      height: 28,
                      padding: '0 10px',
                      borderRadius: 9,
                      border: '1px solid var(--border-hi)',
                      background: 'var(--surface-2)',
                      color: 'var(--text)',
                      fontSize: 11.5,
                    }}
                  >
                    Propose Action
                  </button>
                  {nativeDetailDescriptor ? (
                    <button
                      type="button"
                      onClick={openNativeDetail}
                      style={{
                        height: 28,
                        padding: '0 10px',
                        borderRadius: 9,
                        border: '1px solid var(--border-hi)',
                        background: 'var(--surface-2)',
                        color: 'var(--text)',
                        fontSize: 11.5,
                      }}
                    >
                      {nativeDetailDescriptor.label}
                    </button>
                  ) : null}
                </div>
                <div style={{ marginTop: 8, fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>
                  {bundle.rollup?.title || bundle.entityLabel}
                </div>
                {bundle.rollup?.reason ? (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-dim)' }}>{bundle.rollup.reason}</div>
                ) : null}
                {ownerSummary ? (
                  <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                      fields {ownerSummary.summary.aiFieldCount}
                    </span>
                    <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                      actions {ownerSummary.summary.actionCount}
                    </span>
                    <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                      queue {ownerSummary.summary.queueArtifactCount}
                    </span>
                  </div>
                ) : null}
                {bundle.rollup?.keyPoints?.length ? (
                  <ul style={{ margin: '10px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {bundle.rollup.keyPoints.map((point, index) => (
                      <li key={`${bundle.entityId}-kp-${index}`} style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.55 }}>
                        {point}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-dim)' }}>
                    No cached entity rollup yet.
                  </div>
                )}
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: 18, padding: 14, background: 'var(--surface)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Key signals</div>
                  <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                    {entityKind || 'generic'}
                  </span>
                </div>
                <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                  {entitySignals.map((signal) => (
                    <div
                      key={signal.id}
                      style={{
                        borderRadius: 14,
                        border: focusedSignalId === signal.id
                          ? '1px solid color-mix(in srgb, var(--gold) 72%, var(--border-hi))'
                          : '1px solid var(--border)',
                        background:
                          signal.tone === 'positive'
                            ? 'color-mix(in srgb, #2ca061 11%, var(--surface-2))'
                            : signal.tone === 'warning'
                              ? 'color-mix(in srgb, var(--gold) 14%, var(--surface-2))'
                              : 'color-mix(in srgb, var(--surface-2) 65%, transparent)',
                        padding: '11px 12px',
                        boxShadow: focusedSignalId === signal.id ? '0 0 0 1px color-mix(in srgb, var(--gold) 24%, transparent), var(--shadow-sm)' : 'none',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <div className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                          {signal.label}
                        </div>
                        {focusedSignalId === signal.id ? (
                          <button
                            type="button"
                            onClick={() => {
                              clearEntitySignalFocus();
                            }}
                            style={{
                              height: 22,
                              padding: '0 7px',
                              borderRadius: 999,
                              border: '1px solid var(--border-hi)',
                              background: 'var(--surface)',
                              color: 'var(--text-dim)',
                              fontSize: 10.5,
                            }}
                          >
                            Clear
                          </button>
                        ) : null}
                      </div>
                      <div style={{ marginTop: 7, fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.45 }}>
                        {signal.value}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                        {signal.detail}
                      </div>
                      {signal.ctaKind && signal.ctaLabel ? (
                        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            onClick={() => handleSignalAction(signal)}
                            style={{
                              height: 26,
                              padding: '0 9px',
                              borderRadius: 8,
                              border: '1px solid var(--border-hi)',
                              background: 'var(--surface)',
                              color: 'var(--text)',
                              fontSize: 11,
                            }}
                          >
                            {signal.ctaLabel}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: 18, padding: 14, background: 'var(--surface)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Starter fields</div>
                  <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                    {entityKind || 'generic'}
                  </span>
                </div>
                <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-dim)' }}>
                  共通 core の `AI Field` に対して、entity kind ごとに最初に追跡したい項目を薄い application layer として載せます。
                </div>
                <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                  {fieldStarters.map((starter) => (
                    <button
                      key={`${bundle.entityId}-${starter.fieldName}`}
                      type="button"
                      onClick={() => createFieldForEntity(starter.fieldName, starter.instruction)}
                      style={{
                        textAlign: 'left',
                        borderRadius: 14,
                        border: '1px solid var(--border)',
                        background: 'color-mix(in srgb, var(--surface-2) 65%, transparent)',
                        padding: '11px 12px',
                        color: 'var(--text)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span className="pill t-mono" style={{ fontSize: 10 }}>{starter.fieldName}</span>
                        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{starter.label}</span>
                      </div>
                      <div style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                        {starter.instruction}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: 18, padding: 14, background: 'var(--surface)' }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Recent summaries</div>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {bundle.recentSummaries.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>No related summaries yet.</div>
                  ) : bundle.recentSummaries.map((item) => (
                    <button
                      key={item.targetId}
                      type="button"
                      onClick={() => {
                        openContextTarget({
                          targetId: item.targetId,
                          targetKind: item.targetKind,
                          title: item.title,
                        });
                      }}
                      style={{ borderRadius: 12, padding: '10px 11px', border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface-2) 65%, transparent)', textAlign: 'left', color: 'var(--text)' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{item.title}</div>
                        <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{item.priority}</span>
                      </div>
                      {item.keyPoints?.length ? (
                        <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                          {item.keyPoints.slice(0, 2).join(' ')}
                        </div>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ border: '1px solid var(--border)', borderRadius: 18, padding: 14, background: 'var(--surface)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>AI Fields</div>
                  <button
                    type="button"
                    onClick={openEntityFields}
                    style={{
                      height: 26,
                      padding: '0 9px',
                      borderRadius: 8,
                      border: '1px solid var(--border-hi)',
                      background: 'var(--surface-2)',
                      color: 'var(--text)',
                      fontSize: 11,
                    }}
                  >
                    Open all
                  </button>
                </div>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {bundle.aiFields.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>No AI Fields for this entity.</div>
                  ) : bundle.aiFields.map((field) => (
                    <div key={field.id} style={{ borderRadius: 12, padding: '10px 11px', border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface-2) 65%, transparent)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                        <span className="pill t-mono" style={{ fontSize: 10 }}>{field.fieldName}</span>
                        <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                          {typeof field.confidence === 'number' ? `${Math.round(field.confidence * 100)}%` : '—'}
                        </span>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text)' }}>
                        {field.currentValue || 'No current value yet'}
                      </div>
                      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            onClick={() => proposeActionFromField(field)}
                            style={{
                              height: 26,
                              padding: '0 9px',
                              borderRadius: 8,
                              border: '1px solid color-mix(in srgb, var(--gold) 55%, var(--border-hi))',
                              background: 'color-mix(in srgb, var(--gold) 12%, var(--surface-2))',
                              color: 'var(--text)',
                              fontSize: 11,
                            }}
                          >
                            Propose action
                          </button>
                          <button
                            type="button"
                            onClick={() => openAiField(field.id)}
                            style={{
                              height: 26,
                              padding: '0 9px',
                              borderRadius: 8,
                              border: '1px solid var(--border-hi)',
                              background: 'var(--surface)',
                              color: 'var(--text)',
                              fontSize: 11,
                            }}
                          >
                            Open field
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: 18, padding: 14, background: 'var(--surface)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Actions</div>
                  <button
                    type="button"
                    onClick={openEntityActions}
                    style={{
                      height: 26,
                      padding: '0 9px',
                      borderRadius: 8,
                      border: '1px solid var(--border-hi)',
                      background: 'var(--surface-2)',
                      color: 'var(--text)',
                      fontSize: 11,
                    }}
                  >
                    Open queue
                  </button>
                </div>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {bundle.actions.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>No Actions for this entity.</div>
                  ) : bundle.actions.map((action) => (
                    <div key={action.id} style={{ borderRadius: 12, padding: '10px 11px', border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface-2) 65%, transparent)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                        <span className="pill t-mono" style={{ fontSize: 10 }}>{action.actionType}</span>
                        <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{action.status}</span>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{action.title}</div>
                      {action.detail ? (
                        <div style={{ marginTop: 5, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                          {action.detail}
                        </div>
                      ) : null}
                      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          onClick={() => openAction(action.id, action.sourceAiFieldId || null)}
                          style={{
                            height: 26,
                            padding: '0 9px',
                            borderRadius: 8,
                            border: '1px solid var(--border-hi)',
                            background: 'var(--surface)',
                            color: 'var(--text)',
                            fontSize: 11,
                          }}
                        >
                          Open action
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: 18, padding: 14, background: 'var(--surface)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Pending tasks</div>
                  <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                    {pendingTasks.length} pending
                  </span>
                </div>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {pendingTasks.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>No pending shared tasks for this entity.</div>
                  ) : pendingTasks.map((task) => (
                    <div
                      key={task.id}
                      style={{ borderRadius: 12, padding: '10px 11px', border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface-2) 65%, transparent)' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                        <span className="pill t-mono" style={{ fontSize: 10 }}>{task.actionType}</span>
                        <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                          {task.status} · {task.riskLevel}
                        </span>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{task.title}</div>
                      {task.detail ? (
                        <div style={{ marginTop: 5, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                          {task.detail}
                        </div>
                      ) : null}
                      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          onClick={() => openAction(task.id, task.sourceAiFieldId || null)}
                          style={{
                            height: 26,
                            padding: '0 9px',
                            borderRadius: 8,
                            border: '1px solid var(--border-hi)',
                            background: 'var(--surface)',
                            color: 'var(--text)',
                            fontSize: 11,
                          }}
                        >
                          Open task
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            openChatWithSeed(buildEntityChatSeed({
                              entityId: task.ownerEntityId,
                              entityLabel: task.ownerEntityId,
                              actionLabel: `${task.title} [${task.status}]`,
                            }));
                          }}
                          style={{
                            height: 26,
                            padding: '0 9px',
                            borderRadius: 8,
                            border: '1px solid var(--border-hi)',
                            background: 'var(--surface)',
                            color: 'var(--text)',
                            fontSize: 11,
                          }}
                        >
                          Ask Chat
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: 18, padding: 14, background: 'var(--surface)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Queue artifacts</div>
                  <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                    {ownerSummary?.queueArtifacts.total || 0} queued
                  </span>
                </div>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {!ownerSummary || ownerSummary.queueArtifacts.items.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>No queued artifacts for this entity.</div>
                  ) : ownerSummary.queueArtifacts.items.map((item) => {
                    const queueActionId = queueArtifactSourceActionId(item);
                    const {
                      ownerEntityId: queueOwnerEntityId,
                      nativeDetailDescriptor: queueNativeDetailDescriptor,
                      showNativeDetail: showQueueNativeDetail,
                    } = queueArtifactNativeDetailState(item, {
                      currentEntityId: bundle?.entityId,
                    });
                    return (
                      <div key={item.id} style={{ borderRadius: 12, padding: '10px 11px', border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface-2) 65%, transparent)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                          <span className="pill t-mono" style={{ fontSize: 10 }}>queue</span>
                          <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{item.id}</span>
                        </div>
                        <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                          {String(item.payload?.title || 'Queued artifact')}
                        </div>
                        {queueArtifactDetail(item) ? (
                          <div style={{ marginTop: 5, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                            {queueArtifactDetail(item)}
                          </div>
                        ) : null}
                        {queueActionId || showQueueNativeDetail ? (
                          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                            {queueActionId ? (
                              <button
                                type="button"
                                onClick={() => openAction(queueActionId, resolveOwnerSummaryAiFieldId(ownerSummary, queueActionId))}
                                style={{
                                  height: 26,
                                  padding: '0 9px',
                                  borderRadius: 8,
                                  border: '1px solid var(--border-hi)',
                                  background: 'var(--surface)',
                                  color: 'var(--text)',
                                  fontSize: 11,
                                }}
                              >
                                Open queued action
                              </button>
                            ) : null}
                            {showQueueNativeDetail && queueNativeDetailDescriptor ? (
                              <button
                                type="button"
                                onClick={() => openNativeDetailForEntityId(queueOwnerEntityId)}
                                style={{
                                  height: 26,
                                  padding: '0 9px',
                                  borderRadius: 8,
                                  border: '1px solid var(--border-hi)',
                                  background: 'var(--surface)',
                                  color: 'var(--text)',
                                  fontSize: 11,
                                }}
                              >
                                {queueNativeDetailDescriptor.label}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: 18, padding: 14, background: 'var(--surface)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Latest audits</div>
                  <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                    {ownerSummary?.latestAudits.filter((item) => item.latestAudit).length || 0} events
                  </span>
                </div>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {!ownerSummary || ownerSummary.latestAudits.filter((item) => item.latestAudit).length === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>No audit trail for this entity yet.</div>
                  ) : ownerSummary.latestAudits
                    .filter((item) => item.latestAudit)
                    .map((item) => (
                      <div key={`${item.actionId}:${item.latestAudit?.id || 'audit'}`} style={{ borderRadius: 12, padding: '10px 11px', border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface-2) 65%, transparent)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                          <span className="pill t-mono" style={{ fontSize: 10 }}>{item.latestAudit?.eventType || 'audit'}</span>
                          <button
                            type="button"
                            onClick={() => {
                              const action = ownerSummary?.actions.items.find((candidate) => candidate.id === item.actionId) || null;
                              focusActionTrace({
                                actionId: item.actionId,
                                aiFieldId: String(action?.sourceAiFieldId || '').trim() || null,
                                openAudit: true,
                              });
                              (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
                            }}
                            style={{
                              height: 24,
                              padding: '0 8px',
                              borderRadius: 8,
                              border: '1px solid var(--border-hi)',
                              background: 'var(--surface)',
                              color: 'var(--text)',
                              fontSize: 10.5,
                            }}
                          >
                            Open audit
                          </button>
                        </div>
                        <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                          {item.latestAudit?.detail || 'Audit recorded'}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
