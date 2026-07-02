import { useEffect, useState } from 'react';
import { Icon } from '@/shared/icons';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';
import { focusEntity } from '@/shared/context/entity-focus';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import {
  buildActionChatSeed,
  openChatWithSeed,
} from '@/shared/context/chat-composer-seed';
import {
  nativeDetailDescriptorForEntityId,
  openContextTarget,
  openNativeDetailForEntityId,
} from '@/shared/context/context-target-navigation';
import { normalizeContextActionType } from '@/shared/context/action-types';
import type { ContextActionRecord } from '@/shared/domain/context-layer';

interface TasksPayload {
  items?: ContextActionRecord[] | null;
  total?: number | null;
}

export function SharedTasksCard(): JSX.Element | null {
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<TasksPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      setLoading(true);
      runRuntimeAction(
        'context.tasks.list',
        { statuses: ['proposed', 'approved'], limit: 6 },
        { silentError: true },
      )
        .then((res) => {
          if (cancelled) return;
          setPayload((res?.ok && res.data ? res.data : null) as TasksPayload | null);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const onRefresh = () => {
      void load();
    };
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    };
  }, []);

  const items = (payload?.items || []).map((item) => ({
    ...item,
    actionType: normalizeContextActionType(item.actionType),
  }));
  if (!loading && items.length === 0) return null;

  const openTask = (item: ContextActionRecord) => {
    const actionId = String(item.id || '').trim();
    const ownerEntityId = String(item.ownerEntityId || '').trim();
    const aiFieldId = String(item.sourceAiFieldId || '').trim() || null;
    if (ownerEntityId) focusEntity(ownerEntityId);
    if (actionId) {
      focusActionTrace({ actionId, aiFieldId, openAudit: false });
      (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
    }
  };

  const openOwnerContext = (item: ContextActionRecord) => {
    const ownerEntityId = String(item.ownerEntityId || '').trim();
    if (!ownerEntityId) return;
    openContextTarget({ targetId: ownerEntityId });
  };

  const askChat = (item: ContextActionRecord) => {
    openChatWithSeed(
      buildActionChatSeed({
        ownerEntityId: item.ownerEntityId,
        title: item.title,
        actionType: item.actionType,
        status: item.status,
        riskLevel: item.riskLevel,
        detail: item.detail,
      }),
    );
  };

  return (
    <section
      style={{
        width: '100%',
        maxWidth: 900,
        margin: '28px auto 0',
        padding: '18px 18px 16px',
        borderRadius: 22,
        border: '1px solid var(--border)',
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 95%, var(--gold) 5%), var(--surface))',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'color-mix(in srgb, var(--gold) 14%, var(--surface-2))',
              color: 'var(--gold)',
              flexShrink: 0,
            }}
          >
            <Icon name="work" size={16} />
          </div>
          <div>
            <div className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)', letterSpacing: '0.12em' }}>
              SHARED TASKS
            </div>
            <div style={{ marginTop: 5, fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
              Pending tasks across the desktop context layer
            </div>
            <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-dim)' }}>
              `create_task` actions waiting in `proposed` / `approved` are shown here directly from the shared Action Layer, not from a separate task database.
            </div>
          </div>
        </div>
        <span className="pill t-mono" style={{ fontSize: 10.5 }}>
          pending {items.length}
        </span>
      </div>

      <div style={{ marginTop: 14, display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {loading && items.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>Loading shared tasks…</div>
        ) : null}
        {items.map((item) => {
          const ownerEntityId = String(item.ownerEntityId || '').trim();
          const nativeDetailDescriptor = nativeDetailDescriptorForEntityId(ownerEntityId);
          return (
            <div
              key={item.id}
              style={{
                borderRadius: 14,
                border: '1px solid var(--border)',
                background: 'color-mix(in srgb, var(--surface-2) 70%, transparent)',
                padding: '11px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span className="pill t-mono" style={{ fontSize: 10 }}>{item.actionType}</span>
                <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                  {item.status} · {item.riskLevel}
                </span>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{item.title}</div>
              <div className="t-mono" style={{ fontSize: 10.5, color: 'var(--gold)' }}>{ownerEntityId}</div>
              {item.detail ? (
                <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>{item.detail}</div>
              ) : null}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => openTask(item)}>
                  Open task
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => openOwnerContext(item)}>
                  Owner context
                </button>
                {nativeDetailDescriptor ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => openNativeDetailForEntityId(ownerEntityId)}
                  >
                    {nativeDetailDescriptor.label}
                  </button>
                ) : null}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => askChat(item)}>
                  Ask Chat
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
