import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/shared/icons';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { seedActionDraft } from '@/shared/context/action-draft';
import { seedAiFieldDraft } from '@/shared/context/ai-field-draft';
import { focusEntity } from '@/shared/context/entity-focus';
import { focusAiField } from '@/shared/context/ai-field-focus';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import {
  jumpToMemorySearch,
  nativeDetailDescriptorForEntityId,
  openNativeDetailForEntityId,
  openContextTarget,
} from '@/shared/context/context-target-navigation';
import {
  queueArtifactDetail,
  queueArtifactNativeDetailState,
  queueArtifactSourceActionId,
} from '@/shared/context/queue-artifact-meta';
import { buildActionChatSeed, buildEntityChatSeed, openChatWithSeed } from '@/shared/context/chat-composer-seed';
import { normalizeContextActionType } from '@/shared/context/action-types';
import {
  ACTION_LAYER_REFRESH_EVENT,
  dispatchActionLayerRefresh,
} from '@/shared/context/action-layer-events';
import { buildEntityConventionExamples } from '@/shared/domain/entity-id-conventions';
import {
  getActionStarterForEntityKind,
  getFieldStartersForEntityKind,
  inferEntityKind,
} from '@/features/entity-context/entity-kind-presets';
import type {
  AiFieldRecord,
  ContextActionRecord,
  OwnerContextSummaryRecord,
  QueueArtifactRecord,
} from '@/shared/domain/context-layer';

interface ContextLensConfig {
  headerEyebrow: string;
  title: string;
  titleJp: string;
  descriptionEn: string;
  descriptionJp: string;
  summaryText: string;
  searchPlaceholder: string;
  loadingText: string;
  emptyText: string;
  ownerKinds: string[];
  fieldPriority: string[];
  statLabels: {
    primary: string;
    secondary: string;
    openActions: string;
  };
  taskInbox?: {
    title: string;
    description: string;
    emptyText: string;
    statuses?: Array<'proposed' | 'approved' | 'executed' | 'rejected'>;
    limit?: number;
  };
}

interface LensCard {
  entityId: string;
  kind: string;
  title: string;
  aiFields: AiFieldRecord[];
  actions: ContextActionRecord[];
  lastTouchedAt: number;
}

interface LensEvidenceState {
  loading: boolean;
  bundle: OwnerContextSummaryRecord | null;
}

function normalizeActionRecord(item: ContextActionRecord): ContextActionRecord {
  return {
    ...item,
    actionType: normalizeContextActionType(item.actionType),
  };
}

interface LensFieldStarter {
  fieldName: string;
  label: string;
  instruction: string;
}

function parseOwnerKind(entityId: string, allowedKinds: string[]): string | null {
  const [kind] = String(entityId || '').split(':');
  if (!kind) return null;
  return allowedKinds.includes(kind) ? kind : null;
}

function displayEntityLabel(entityId: string): string {
  const [prefix, ...rest] = entityId.split(':');
  const tail = rest.join(':').trim();
  if (!tail) return entityId;
  return `${tail} · ${prefix}`;
}

function latestTimestamp(fields: AiFieldRecord[], actions: ContextActionRecord[]): number {
  const fieldTs = fields.map((item) => Number(item.lastUpdatedAt || item.createdAt || 0));
  const actionTs = actions.map((item) => Number(item.updatedAt || item.createdAt || 0));
  return Math.max(0, ...fieldTs, ...actionTs);
}

function humanizeFieldName(fieldName: string): string {
  return String(fieldName || '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function buildLensFieldStarters(card: LensCard, fieldPriority: string[]): LensFieldStarter[] {
  const existing = new Set(card.aiFields.map((item) => String(item.fieldName || '').trim().toLowerCase()));
  const entityKind = inferEntityKind(card.entityId);
  const starterMap = new Map(
    getFieldStartersForEntityKind(entityKind).map((item) => [String(item.fieldName || '').trim().toLowerCase(), item]),
  );

  const starters: LensFieldStarter[] = [];
  for (const fieldName of fieldPriority) {
    const normalizedFieldName = String(fieldName || '').trim().toLowerCase();
    if (!normalizedFieldName || existing.has(normalizedFieldName)) continue;
    const starter = starterMap.get(normalizedFieldName);
    const label = starter?.label || humanizeFieldName(normalizedFieldName);
    starters.push({
      fieldName: normalizedFieldName,
      label,
      instruction: starter?.instruction || `Track ${label.toLowerCase()} for ${card.entityId} using shared desktop context evidence.`,
    });
  }
  return starters.slice(0, 3);
}

function sortFieldPriority(fields: AiFieldRecord[], fieldPriority: string[]): AiFieldRecord[] {
  return [...fields].sort((a, b) => {
    const aIdx = fieldPriority.indexOf(String(a.fieldName || '').toLowerCase());
    const bIdx = fieldPriority.indexOf(String(b.fieldName || '').toLowerCase());
    const normA = aIdx === -1 ? 999 : aIdx;
    const normB = bIdx === -1 ? 999 : bIdx;
    if (normA !== normB) return normA - normB;
    return Number(b.lastUpdatedAt || 0) - Number(a.lastUpdatedAt || 0);
  });
}

function firstNativeDetailTargetId(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    if (nativeDetailDescriptorForEntityId(normalized)) return normalized;
  }
  return null;
}

function sourceNativeDetailLabel(targetId: string): string | null {
  const descriptor = nativeDetailDescriptorForEntityId(targetId);
  if (!descriptor) return null;
  return descriptor.kind === 'meeting' ? 'Open source meeting' : 'Open source workspace';
}

function resolveActionAiFieldId(
  actionId: string,
  card: LensCard,
  evidenceBundle?: OwnerContextSummaryRecord | null,
): string | null {
  const normalizedActionId = String(actionId || '').trim();
  if (!normalizedActionId) return null;
  const evidenceAction = evidenceBundle?.actions.items.find((item) => item.id === normalizedActionId);
  const cardAction = card.actions.find((item) => item.id === normalizedActionId);
  return String(evidenceAction?.sourceAiFieldId || cardAction?.sourceAiFieldId || '').trim() || null;
}

function normalizeEntitySuffix(kind: string, value: string): string {
  const normalizedKind = String(kind || '').trim().toLowerCase();
  const raw = String(value || '').trim().toLowerCase();
  const withoutPrefix = raw.startsWith(`${normalizedKind}:`)
    ? raw.slice(normalizedKind.length + 1)
    : raw;
  return withoutPrefix
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function ContextLensScreen({ config }: { config: ContextLensConfig }): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [aiFields, setAiFields] = useState<AiFieldRecord[]>([]);
  const [actions, setActions] = useState<ContextActionRecord[]>([]);
  const [taskInboxItems, setTaskInboxItems] = useState<ContextActionRecord[]>([]);
  const [evidenceByEntity, setEvidenceByEntity] = useState<Record<string, LensEvidenceState>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [createKind, setCreateKind] = useState(config.ownerKinds[0] || 'company');
  const [createSuffix, setCreateSuffix] = useState('');
  const [createFieldName, setCreateFieldName] = useState('');
  const [createInstruction, setCreateInstruction] = useState('');
  const [createCurrentValue, setCreateCurrentValue] = useState('');
  const [createStarterAction, setCreateStarterAction] = useState(true);
  const [createAfterCreateMode, setCreateAfterCreateMode] = useState<'auto' | 'entity_context' | 'stay'>('auto');
  const [creating, setCreating] = useState(false);
  const evidenceByEntityRef = useRef(evidenceByEntity);
  const evidenceRequestSeqRef = useRef<Record<string, number>>({});

  useEffect(() => {
    evidenceByEntityRef.current = evidenceByEntity;
  }, [evidenceByEntity]);

  const refreshSurfaceData = async (): Promise<void> => {
    setLoading(true);
    const taskStatuses = config.taskInbox?.statuses || ['proposed', 'approved'];
    const taskLimit = config.taskInbox?.limit || 8;
    const requests: Array<Promise<any>> = [
      runRuntimeAction('ai_field.list', { limit: 120 }, { silentError: true }),
      runRuntimeAction('action.list', { limit: 120 }, { silentError: true }),
    ];
    if (config.taskInbox) {
      requests.push(
        runRuntimeAction(
          'context.tasks.list',
          { limit: taskLimit, statuses: taskStatuses },
          { silentError: true },
        ),
      );
    }
    const [fieldsRes, actionsRes, taskInboxRes] = await Promise.all(requests);
    setAiFields(
      fieldsRes?.ok && Array.isArray(fieldsRes.data?.items)
        ? (fieldsRes.data.items as AiFieldRecord[])
        : [],
    );
    setActions(
      actionsRes?.ok && Array.isArray(actionsRes.data?.items)
        ? (actionsRes.data.items as ContextActionRecord[]).map(normalizeActionRecord)
        : [],
    );
    if (config.taskInbox) {
      const items =
        taskInboxRes?.ok && Array.isArray(taskInboxRes.data?.items)
          ? (taskInboxRes.data.items as ContextActionRecord[]).map(normalizeActionRecord)
          : [];
      setTaskInboxItems(
        items.filter((item) => parseOwnerKind(String(item.ownerEntityId || ''), config.ownerKinds)),
      );
    } else {
      setTaskInboxItems([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    refreshSurfaceData()
      .catch(() => {
        if (!cancelled) {
          setAiFields([]);
          setActions([]);
          setTaskInboxItems([]);
          setLoading(false);
        }
      })
      .then(() => {
        if (cancelled) return;
      });
    return () => {
      cancelled = true;
    };
  }, [config.ownerKinds, config.taskInbox]);

  useEffect(() => {
    const onRefresh = () => {
      const loadedEntityIds = Object.entries(evidenceByEntityRef.current)
        .filter(([, state]) => Boolean(state?.bundle) || Boolean(state?.loading))
        .map(([entityId]) => entityId);
      if (loadedEntityIds.length > 0) {
        setEvidenceByEntity((prev) => {
          const next: Record<string, LensEvidenceState> = {};
          for (const entityId of loadedEntityIds) {
            if (prev[entityId]) next[entityId] = { loading: true, bundle: null };
          }
          return next;
        });
      } else {
        setEvidenceByEntity({});
      }
      void refreshSurfaceData()
        .then(async () => {
          if (loadedEntityIds.length === 0) return;
          await Promise.all(loadedEntityIds.map((entityId) => loadEvidence(entityId, { force: true })));
        })
        .catch(() => {
          /* ignore */
        });
    };
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
  }, [config.ownerKinds, config.taskInbox]);

  const cards = useMemo(() => {
    const byEntity = new Map<string, { kind: string; fields: AiFieldRecord[]; actions: ContextActionRecord[] }>();
    for (const item of aiFields) {
      const entityId = String(item.ownerEntityId || '').trim();
      const kind = parseOwnerKind(entityId, config.ownerKinds);
      if (!kind) continue;
      const current = byEntity.get(entityId) || { kind, fields: [], actions: [] };
      current.fields.push(item);
      byEntity.set(entityId, current);
    }
    for (const item of actions) {
      const entityId = String(item.ownerEntityId || '').trim();
      const kind = parseOwnerKind(entityId, config.ownerKinds);
      if (!kind) continue;
      const current = byEntity.get(entityId) || { kind, fields: [], actions: [] };
      current.actions.push(item);
      byEntity.set(entityId, current);
    }
    return Array.from(byEntity.entries())
      .map(([entityId, group]) => ({
        entityId,
        kind: group.kind,
        title: displayEntityLabel(entityId),
        aiFields: sortFieldPriority(group.fields, config.fieldPriority),
        actions: [...group.actions].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)),
        lastTouchedAt: latestTimestamp(group.fields, group.actions),
      }))
      .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt) as LensCard[];
  }, [aiFields, actions, config.fieldPriority, config.ownerKinds]);

  const filteredCards = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((card) => {
      const haystack = [
        card.entityId,
        card.title,
        ...card.aiFields.flatMap((item) => [item.fieldName, item.currentValue, item.instruction]),
        ...card.actions.flatMap((item) => [item.title, item.detail, item.actionType, item.status]),
      ]
        .map((value) => String(value || '').toLowerCase())
        .join(' ');
      return haystack.includes(q);
    });
  }, [cards, query]);

  const stats = useMemo(() => {
    const primary = cards.filter((card) => card.kind === config.ownerKinds[0]).length;
    const secondary = cards.filter((card) => card.kind === config.ownerKinds[1]).length;
    const openActions = cards.reduce(
      (acc, card) => acc + card.actions.filter((item) => item.status === 'proposed' || item.status === 'approved').length,
      0,
    );
    return { primary, secondary, openActions };
  }, [cards, config.ownerKinds]);
  const ownerExamples = useMemo(
    () => buildEntityConventionExamples(config.ownerKinds),
    [config.ownerKinds],
  );
  const createFieldStarters = useMemo(
    () => getFieldStartersForEntityKind(createKind ? inferEntityKind(`${createKind}:seed`) : null),
    [createKind],
  );
  const createActionStarter = useMemo(
    () => getActionStarterForEntityKind(createKind ? inferEntityKind(`${createKind}:seed`) : null),
    [createKind],
  );
  const createOwnerEntityId = useMemo(() => {
    const suffix = normalizeEntitySuffix(createKind, createSuffix);
    return suffix ? `${createKind}:${suffix}` : '';
  }, [createKind, createSuffix]);

  useEffect(() => {
    if (!config.ownerKinds.includes(createKind)) {
      setCreateKind(config.ownerKinds[0] || 'company');
    }
  }, [config.ownerKinds, createKind]);

  useEffect(() => {
    const starters = getFieldStartersForEntityKind(
      createKind ? inferEntityKind(`${createKind}:seed`) : null,
    );
    if (!starters.length) return;
    const current = starters.find((item) => item.fieldName === createFieldName);
    const next = current ?? starters[0];
    if (!next) return;
    setCreateFieldName(next.fieldName);
    setCreateInstruction(next.instruction);
  }, [createKind, createFieldName]);

  const openEntityContext = (entityId: string) => {
    openContextTarget({ targetId: entityId });
  };

  const openAiFields = (entityId: string, fieldId?: string) => {
    focusEntity(entityId);
    if (fieldId) focusAiField(fieldId);
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('ai_fields');
  };

  const createFieldDraft = (entityId: string, starter: LensFieldStarter) => {
    const ownerEntityId = String(entityId || '').trim();
    if (!ownerEntityId) return;
    seedAiFieldDraft({
      ownerEntityId,
      fieldName: starter.fieldName,
      instruction: starter.instruction,
      currentValue: '',
      confidence: 0.72,
      evidenceEventIds: [],
    });
    focusEntity(ownerEntityId);
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('ai_fields');
  };

  const openActions = (entityId: string, actionId?: string, options?: { openAudit?: boolean; aiFieldId?: string | null }) => {
    focusEntity(entityId);
    if (actionId) {
      focusActionTrace({
        actionId,
        aiFieldId: String(options?.aiFieldId || '').trim() || null,
        openAudit: options?.openAudit === true,
      });
    }
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
  };

  const createActionDraft = (card: LensCard) => {
    const entityKind = inferEntityKind(card.entityId);
    const actionStarter = getActionStarterForEntityKind(entityKind);
    const sourceField = card.aiFields[0] || null;
    seedActionDraft({
      ownerEntityId: card.entityId,
      actionType: actionStarter.actionType,
      title: `${actionStarter.titleTemplate} · ${card.title}`,
      detail: actionStarter.detail,
      riskLevel: actionStarter.riskLevel,
      sourceAiFieldId: sourceField?.id || null,
      evidenceEventIds: Array.from(
        new Set(
          card.aiFields
            .flatMap((item) => item.evidenceEventIds || [])
            .map((item) => String(item || '').trim())
            .filter(Boolean),
        ),
      ).slice(0, 6),
    });
    focusEntity(card.entityId);
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
  };

  const openMemorySearch = (queryText: string) => {
    jumpToMemorySearch(queryText, 'search');
  };

  const openNativeDetail = (targetId?: string | null) => {
    const id = String(targetId || '').trim();
    if (!id) return;
    openNativeDetailForEntityId(id);
  };

  const openChatForEntity = (card: LensCard, evidenceBundle?: OwnerContextSummaryRecord | null) => {
    const rollupTitle = String(evidenceBundle?.entityContext?.rollup?.title || '').trim();
    const field = card.aiFields[0];
    const action = card.actions[0];
    openChatWithSeed(buildEntityChatSeed({
      entityId: card.entityId,
      entityLabel: card.title,
      rollupTitle,
      fieldLabel: field ? `${field.fieldName} = ${field.currentValue || '(empty)'}` : null,
      actionLabel: action ? `${action.title} [${action.status}]` : null,
    }));
  };

  const loadEvidence = async (entityId: string, options?: { force?: boolean }) => {
    const current = evidenceByEntityRef.current[entityId];
    if (!options?.force && (current?.loading || current?.bundle)) return;
    const requestSeq = (evidenceRequestSeqRef.current[entityId] || 0) + 1;
    evidenceRequestSeqRef.current[entityId] = requestSeq;
    setEvidenceByEntity((prev) => ({
      ...prev,
      [entityId]: { loading: true, bundle: null },
    }));
    const lang = (typeof document !== 'undefined' && document.body.getAttribute('data-lang')) || 'en';
    const res = await runRuntimeAction(
      'context.owner_summary.get',
      { ownerEntityId: entityId, entityLabel: entityId, lang, limit: 4 },
      { silentError: true },
    );
    if (evidenceRequestSeqRef.current[entityId] !== requestSeq) return;
    setEvidenceByEntity((prev) => ({
      ...prev,
      [entityId]: {
        loading: false,
        bundle: res?.ok && res.data ? (res.data as OwnerContextSummaryRecord) : null,
      },
    }));
  };

  const saveQuickCreate = async () => {
    const ownerEntityId = createOwnerEntityId.trim();
    if (!ownerEntityId || !createFieldName.trim() || !createInstruction.trim()) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.('entity kind / suffix / starter field を入力してください', 'warn');
      return;
    }
    setCreating(true);
    const res = await runRuntimeAction(
      'ai_field.upsert',
      {
        ownerEntityId,
        fieldName: createFieldName.trim(),
        instruction: createInstruction.trim(),
        currentValue: createCurrentValue.trim(),
        confidence: 0.72,
        evidenceEventIds: [],
      },
      { silentError: true },
    );
    setCreating(false);
    if (!res?.ok) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.('entity starter を保存できませんでした', 'danger');
      return;
    }
    dispatchActionLayerRefresh('context-lens-ai-field-created');
    const fieldItem = res.data?.item as AiFieldRecord | undefined;
    let createdActionId: string | null = null;
    if (createStarterAction) {
      const actionRes = await runRuntimeAction(
        'action.propose',
        {
          ownerEntityId,
          actionType: createActionStarter.actionType,
          title: `${createActionStarter.titleTemplate} · ${displayEntityLabel(ownerEntityId)}`,
          detail: createActionStarter.detail,
          riskLevel: createActionStarter.riskLevel,
          sourceAiFieldId: String(fieldItem?.id || '').trim() || null,
          evidenceEventIds: Array.isArray(fieldItem?.evidenceEventIds) ? fieldItem.evidenceEventIds : [],
        },
        { silentError: true },
      );
      if (!actionRes?.ok) {
        (window as any).SHOGUN_RUNTIME?.pushToast?.('starter action は作成できませんでしたが entity は保存しました', 'warn');
      } else {
        createdActionId = String(actionRes.data?.item?.id || '').trim() || null;
      }
    }
    focusEntity(ownerEntityId);
    setCreateSuffix('');
    setCreateCurrentValue('');
    setCreateOpen(false);
    setQuery('');
    if (createAfterCreateMode === 'entity_context') {
      openEntityContext(ownerEntityId);
    } else if (createAfterCreateMode === 'auto') {
      if (createdActionId) {
        openActions(ownerEntityId, createdActionId, {
          aiFieldId: String(fieldItem?.id || '').trim() || null,
        });
      } else if (fieldItem?.id) {
        openAiFields(ownerEntityId, fieldItem.id);
      }
    }
    (window as any).SHOGUN_RUNTIME?.pushToast?.(
      createStarterAction ? `Created ${ownerEntityId} and starter action` : `Created ${ownerEntityId}`,
      'success',
      {
        action: createdActionId
          ? {
              label: 'Open action',
              onClick: () => {
                openActions(ownerEntityId, createdActionId, {
                  aiFieldId: String(fieldItem?.id || '').trim() || null,
                });
              },
            }
          : fieldItem?.id
            ? {
                label: 'Open field',
                onClick: () => {
                  openAiFields(ownerEntityId, fieldItem.id);
                },
              }
            : undefined,
      },
    );
    await refreshSurfaceData();
  };

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{ marginBottom: 8 }}>{config.headerEyebrow}</div>
          <h1>{config.title} <span className="jp">{config.titleJp}</span></h1>
          <div className="sub">
            <span className="en-only">{config.descriptionEn}</span>
            <span className="jp">{config.descriptionJp}</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 18 }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--gold) 14%, var(--surface-2))', color: 'var(--gold)' }}>
          <Icon name="work" size={16} />
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            {config.summaryText}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span className="pill t-mono">{config.statLabels.primary} {stats.primary}</span>
            <span className="pill t-mono">{config.statLabels.secondary} {stats.secondary}</span>
            <span className="pill t-mono">{config.statLabels.openActions} {stats.openActions}</span>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={config.searchPlaceholder}
              className="s-input"
              style={{ maxWidth: 360 }}
            />
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setQuery('')}>
              Clear
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => setCreateOpen((value) => !value)}
            >
              {createOpen ? 'Close quick create' : 'Quick create'}
            </button>
          </div>
        </div>
      </div>

      {createOpen ? (
        <div className="card" style={{ padding: 14, marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
              QUICK CREATE
            </div>
            <span className="pill t-mono" style={{ fontSize: 10 }}>
              native desktop save
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            この surface から shared core に最初の `AI Field` を保存して、company / deal / investor / project / task の文脈を実際に立ち上げます。
            別の専用DBは増やさず、保存先は同じ desktop context layer です。
          </div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
              <span>Entity kind</span>
              <select
                aria-label="Entity kind"
                className="s-input"
                value={createKind}
                onChange={(e) => setCreateKind(e.target.value)}
              >
                {config.ownerKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
              <span>Entity suffix</span>
              <input
                aria-label="Entity suffix"
                className="s-input"
                value={createSuffix}
                onChange={(e) => setCreateSuffix(e.target.value)}
                placeholder={createKind === 'company' ? 'acme' : createKind === 'deal' ? 'seed-round' : `${createKind}-alpha`}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
              <span>Starter field</span>
              <select
                aria-label="Starter field"
                className="s-input"
                value={createFieldName}
                onChange={(e) => {
                  const nextFieldName = e.target.value;
                  setCreateFieldName(nextFieldName);
                  const starter = createFieldStarters.find((item) => item.fieldName === nextFieldName);
                  if (starter) setCreateInstruction(starter.instruction);
                }}
              >
                {createFieldStarters.map((item) => (
                  <option key={item.fieldName} value={item.fieldName}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
            <span>Starter value</span>
            <textarea
              aria-label="Starter value"
              className="s-input"
              value={createCurrentValue}
              onChange={(e) => setCreateCurrentValue(e.target.value)}
              rows={3}
              placeholder="Enter the first concrete signal you want to track on this entity."
              style={{ resize: 'vertical' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
            <span>Instruction</span>
            <textarea
              aria-label="Instruction"
              className="s-input"
              value={createInstruction}
              onChange={(e) => setCreateInstruction(e.target.value)}
              rows={3}
              style={{ resize: 'vertical' }}
            />
          </label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 12,
              color: 'var(--text)',
            }}
          >
            <input
              aria-label="Also create starter action"
              type="checkbox"
              checked={createStarterAction}
              onChange={(e) => setCreateStarterAction(e.target.checked)}
            />
            <span>
              Also create starter action
              <span className="t-mono" style={{ marginLeft: 8, fontSize: 10, color: 'var(--text-dim)' }}>
                {createActionStarter.actionType} · {createActionStarter.titleTemplate}
              </span>
            </span>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
            <span>After create</span>
            <select
              aria-label="After create"
              className="s-input"
              value={createAfterCreateMode}
              onChange={(e) => setCreateAfterCreateMode(e.target.value as 'auto' | 'entity_context' | 'stay')}
            >
              <option value="auto">
                {createStarterAction ? 'Open created action/field' : 'Open created field'}
              </option>
              <option value="entity_context">Open entity context</option>
              <option value="stay">Stay here</option>
            </select>
          </label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="pill t-mono" style={{ fontSize: 10 }}>
              ownerEntityId {createOwnerEntityId || `${createKind}:...`}
            </span>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => void saveQuickCreate()}
              disabled={creating}
            >
              {creating ? 'Creating…' : `Create ${createKind}`}
            </button>
          </div>
        </div>
      ) : null}

      <div className="card" style={{ padding: 14, marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
          OWNER ENTITY CONVENTION
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          AI Fields / Actions の `ownerEntityId` は shared core の entity id 規約に従います。surface ごとに別 schema を持たず、同じ prefix ルールで束ねます。
        </div>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          {ownerExamples.map((item) => (
            <div key={item.kind} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)' }}>
              <div className="row" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <span className="pill t-mono" style={{ fontSize: 10 }}>{item.kind}</span>
                <span className="t-mono" style={{ fontSize: 11, color: 'var(--gold)' }}>{item.example}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-mute)', lineHeight: 1.5 }}>
                {item.description}
              </div>
            </div>
          ))}
        </div>
      </div>

      {config.taskInbox ? (
        <div className="card" style={{ padding: 14, marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
              SHARED TASK INBOX
            </div>
            <span className="pill t-mono" style={{ fontSize: 10 }}>
              pending {taskInboxItems.length}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{config.taskInbox.title}</div>
            {config.taskInbox.description}
          </div>
          {taskInboxItems.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              {config.taskInbox.emptyText}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
              {taskInboxItems.slice(0, config.taskInbox.limit || 8).map((item) => (
                <div
                  key={item.id}
                  style={{
                    padding: '10px 12px',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    background: 'var(--surface-2)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="pill t-mono" style={{ fontSize: 10 }}>{item.actionType}</span>
                    <span className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                      {item.status} · {item.riskLevel}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{item.title}</div>
                  <div className="t-mono" style={{ fontSize: 10.5, color: 'var(--gold)' }}>
                    {item.ownerEntityId}
                  </div>
                  {item.detail ? (
                    <div style={{ fontSize: 11, color: 'var(--text-mute)', lineHeight: 1.5 }}>{item.detail}</div>
                  ) : null}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => openActions(item.ownerEntityId, item.id, { aiFieldId: item.sourceAiFieldId || null })}
                    >
                      Open task
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => openEntityContext(item.ownerEntityId)}
                    >
                      Owner context
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() =>
                        openChatWithSeed(
                          buildActionChatSeed({
                            ownerEntityId: item.ownerEntityId,
                            title: item.title,
                            actionType: item.actionType,
                            status: item.status,
                            riskLevel: item.riskLevel,
                            detail: item.detail,
                          }),
                        )
                      }
                    >
                      Ask Chat
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {loading ? (
        <div className="card" style={{ padding: 18, color: 'var(--text-dim)' }}>
          {config.loadingText}
        </div>
      ) : null}

      {!loading && filteredCards.length === 0 ? (
        <div className="card" style={{ padding: 18, color: 'var(--text-dim)' }}>
          {config.emptyText}
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: 16 }}>
        {filteredCards.map((card) => {
          const openItems = card.actions.filter((item) => item.status === 'proposed' || item.status === 'approved');
          const evidenceState = evidenceByEntity[card.entityId];
          const evidenceBundle = evidenceState?.bundle || null;
          const evidenceEntityContext = evidenceBundle?.entityContext || null;
          const fieldStarters = buildLensFieldStarters(card, config.fieldPriority);
          const actionStarter = getActionStarterForEntityKind(inferEntityKind(card.entityId));
          return (
            <div key={card.entityId} className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div className="row" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                    <span className="pill t-mono" style={{ fontSize: 10 }}>{card.kind}</span>
                    <span className="pill t-mono" style={{ fontSize: 10 }}>{card.entityId}</span>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>{card.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
                    {card.aiFields.length} fields · {card.actions.length} actions · {openItems.length} open actions
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => openEntityContext(card.entityId)}>
                    Entity Context
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => openAiFields(card.entityId)}>
                    AI Fields
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => openActions(card.entityId)}>
                    Actions
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => void loadEvidence(card.entityId)}>
                    {evidenceState?.loading ? 'Loading summary…' : evidenceBundle ? 'Refresh summary' : 'Load summary'}
                  </button>
                  {nativeDetailDescriptorForEntityId(card.entityId) ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => openNativeDetail(card.entityId)}
                    >
                      {nativeDetailDescriptorForEntityId(card.entityId)?.label}
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => openChatForEntity(card, evidenceBundle)}>
                    Ask Chat
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => openMemorySearch(card.entityId)}>
                    Open Memory
                  </button>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => createActionDraft(card)}>
                    {actionStarter.titleTemplate}
                  </button>
                </div>
              </div>

              {fieldStarters.length > 0 ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {fieldStarters.map((starter) => (
                    <button
                      key={`${card.entityId}:${starter.fieldName}`}
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => createFieldDraft(card.entityId, starter)}
                    >
                      Track {starter.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
                    TRACKED FIELDS
                  </div>
                  {card.aiFields.slice(0, 4).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => openAiFields(card.entityId, item.id)}
                      style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)', textAlign: 'left', color: 'var(--text)' }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{item.fieldName}</div>
                      {item.currentValue ? (
                        <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6, lineHeight: 1.5 }}>
                          {item.currentValue}
                        </div>
                      ) : (
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
                          No current value yet
                        </div>
                      )}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
                    OPEN ACTIONS
                  </div>
                  {(openItems.length ? openItems : card.actions).slice(0, 4).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => openActions(card.entityId, item.id, { aiFieldId: item.sourceAiFieldId || null })}
                      style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)', textAlign: 'left', color: 'var(--text)' }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{item.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
                        {item.status} · {item.riskLevel}
                      </div>
                      {item.detail ? (
                        <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6, lineHeight: 1.5 }}>
                          {item.detail}
                        </div>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>

              {evidenceState?.loading ? (
                <div className="card" style={{ padding: 14, background: 'var(--surface-2)' }}>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Loading owner summary, queue, and audit evidence…</div>
                </div>
              ) : null}

              {evidenceBundle ? (
                <div className="card" style={{ padding: 14, background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
                      EVIDENCE SNAPSHOT
                    </div>
                    {evidenceEntityContext?.rollup?.reason ? (
                      <span className="pill" style={{ fontSize: 10 }}>{evidenceEntityContext.rollup.reason}</span>
                    ) : null}
                    <span className="spacer" />
                    <span className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                      summaries {evidenceEntityContext?.recentSummaries.length || 0}
                    </span>
                    <span className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                      queue {Number(evidenceBundle.summary?.queueArtifactCount || 0)}
                    </span>
                  </div>
                  {evidenceEntityContext?.rollup ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                        {evidenceEntityContext.rollup.title}
                      </div>
                      {Array.isArray(evidenceEntityContext.rollup.keyPoints) && evidenceEntityContext.rollup.keyPoints.length > 0 ? (
                        <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {evidenceEntityContext.rollup.keyPoints.slice(0, 3).map((point, index) => (
                            <li key={index} style={{ fontSize: 11, color: 'var(--text-mute)', lineHeight: 1.5 }}>
                              {point}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                      No cached entity rollup yet.
                    </div>
                  )}
                  <div style={{ display: 'grid', gap: 8 }}>
                    {evidenceBundle.actions.items.slice(0, 3).map((item) => (
                      (() => {
                        const nativeSourceTargetId = firstNativeDetailTargetId(item.evidenceEventIds || []);
                        const nativeSourceLabel = nativeSourceTargetId
                          ? sourceNativeDetailLabel(nativeSourceTargetId)
                          : null;
                        return (
                          <div
                            key={item.id}
                            style={{
                              padding: '10px 12px',
                              border: '1px solid var(--border)',
                              borderRadius: 10,
                              background: 'var(--surface)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 8,
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span className="pill t-mono" style={{ fontSize: 10 }}>{item.actionType}</span>
                              <span className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                                {item.status} · {item.riskLevel}
                              </span>
                            </div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                              {item.title}
                            </div>
                            {item.detail ? (
                              <div style={{ fontSize: 11, color: 'var(--text-mute)', lineHeight: 1.5 }}>
                                {item.detail}
                              </div>
                            ) : null}
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => openActions(card.entityId, item.id, { aiFieldId: item.sourceAiFieldId || null })}
                              >
                                Open queue
                              </button>
                              {nativeSourceTargetId && nativeSourceLabel ? (
                                <button
                                  type="button"
                                  className="btn btn-sm btn-ghost"
                                  onClick={() => openNativeDetail(nativeSourceTargetId)}
                                >
                                  {nativeSourceLabel}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => {
                                  openChatWithSeed(buildActionChatSeed({
                                    ownerEntityId: card.entityId,
                                    title: item.title,
                                    actionType: item.actionType,
                                    status: item.status,
                                    riskLevel: item.riskLevel,
                                    detail: item.detail,
                                  }));
                                }}
                              >
                                Ask Chat
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() =>
                                  openActions(card.entityId, item.id, {
                                    openAudit: true,
                                    aiFieldId: item.sourceAiFieldId || null,
                                  })}
                              >
                                Open audit
                              </button>
                            </div>
                          </div>
                        );
                      })()
                    ))}
                    {evidenceBundle.actions.items.length > 0 ? (
                      <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                        action trail from the same shared entity context
                      </div>
                    ) : null}
                    {evidenceBundle.latestAudits
                      .filter((item) => item.latestAudit)
                      .slice(0, 2)
                      .map((item) => (
                        <div
                          key={`${item.actionId}:${item.latestAudit?.id || 'audit'}`}
                          style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)' }}
                        >
                          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                            <span className="pill t-mono" style={{ fontSize: 10 }}>
                              audit
                            </span>
                            <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                              {item.actionId}
                            </span>
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-mute)', lineHeight: 1.5 }}>
                            {String(item.latestAudit?.detail || item.latestAudit?.eventType || 'audit recorded')}
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              onClick={() =>
                                openActions(card.entityId, item.actionId, {
                                  aiFieldId: resolveActionAiFieldId(item.actionId, card, evidenceBundle),
                                })}
                            >
                              Open action
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              onClick={() =>
                                openActions(card.entityId, item.actionId, {
                                  openAudit: true,
                                  aiFieldId: resolveActionAiFieldId(item.actionId, card, evidenceBundle),
                                })}
                            >
                              Open audit
                            </button>
                          </div>
                        </div>
                      ))}
                    {evidenceBundle.queueArtifacts.items.slice(0, 2).map((item: QueueArtifactRecord) => {
                      const queueActionId = queueArtifactSourceActionId(item);
                      const {
                        ownerEntityId: queueOwnerEntityId,
                        nativeDetailDescriptor: queueNativeDetailDescriptor,
                        showNativeDetail: showQueueNativeDetail,
                      } = queueArtifactNativeDetailState(item, {
                        currentEntityId: card.entityId,
                      });
                      return (
                        <div
                          key={item.id}
                          style={{
                            padding: '10px 12px',
                            border: '1px solid var(--border)',
                            borderRadius: 10,
                            background: 'var(--surface)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 8,
                          }}
                        >
                          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                            <span className="pill t-mono" style={{ fontSize: 10 }}>
                              queue
                            </span>
                            <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                              {item.id}
                            </span>
                          </div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                            {String(item.payload?.title || 'Queued artifact')}
                          </div>
                          {queueArtifactDetail(item) ? (
                            <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                              {queueArtifactDetail(item)}
                            </div>
                          ) : null}
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {queueActionId ? (
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => openActions(card.entityId, queueActionId, { aiFieldId: card.aiFields[0]?.id || null })}
                              >
                                Open queued action
                              </button>
                            ) : null}
                            {showQueueNativeDetail && queueNativeDetailDescriptor ? (
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => openNativeDetail(queueOwnerEntityId)}
                              >
                                {queueNativeDetailDescriptor.label}
                              </button>
                            ) : null}
                            {queueOwnerEntityId ? (
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => openChatWithSeed(buildEntityChatSeed({
                                  entityId: queueOwnerEntityId,
                                  entityLabel: queueOwnerEntityId,
                                  actionLabel: String(item.payload?.title || '').trim() || null,
                                }))}
                              >
                                Ask Chat
                              </button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                    {evidenceEntityContext?.recentSummaries.slice(0, 3).map((item) => (
                      (() => {
                        const nativeDetailDescriptor = nativeDetailDescriptorForEntityId(item.targetId || '');
                        return (
                      <button
                        key={`${item.targetId}:${item.generatedAt}:${item.title}`}
                        type="button"
                        onClick={() => {
                          openContextTarget({
                            targetId: item.targetId,
                            targetKind: item.targetKind,
                            title: item.title,
                          });
                        }}
                        style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)', textAlign: 'left', color: 'var(--text)' }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{item.title}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
                          {item.sourceType} · {item.priority}
                        </div>
                        {Array.isArray(item.keyPoints) && item.keyPoints[0] ? (
                          <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6, lineHeight: 1.5 }}>
                            {item.keyPoints[0]}
                          </div>
                        ) : null}
                        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                          <span className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                            open in Memory
                          </span>
                          {nativeDetailDescriptor ? (
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => {
                                e.stopPropagation();
                                openNativeDetail(item.targetId);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  openNativeDetail(item.targetId);
                                }
                              }}
                              className="t-mono"
                              style={{ fontSize: 10, color: 'var(--gold)', cursor: 'pointer' }}
                            >
                              {nativeDetailDescriptor.label}
                            </span>
                          ) : null}
                        </div>
                      </button>
                        );
                      })()
                    ))}
                    {(evidenceEntityContext?.recentSummaries.length || 0) === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                        No recent summaries for this entity yet.
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
