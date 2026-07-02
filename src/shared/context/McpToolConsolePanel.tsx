import React from 'react';
import { ShogunIpcClient } from '@/shared/ipc/ipc-client';
import { openChatWithSeed } from '@/shared/context/chat-composer-seed';
import {
  jumpToMemorySearch,
  jumpToMemoryTimeline,
  openMeetingDetail,
  openNativeDetailForEntityId,
} from '@/shared/context/context-target-navigation';
import { focusEntity } from '@/shared/context/entity-focus';
import { focusAiField } from '@/shared/context/ai-field-focus';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import { openQueueArtifactInActions } from '@/shared/context/open-queue-artifact';

type ToolCatalogItem = {
  name?: string;
  description?: string;
  sampleArgs?: Record<string, unknown>;
};

type ToolCatalogSection = {
  groupId?: string;
  count?: number;
  items?: ToolCatalogItem[];
};

function runtimeToast(message: string, kind: 'success' | 'warn' | 'info' = 'info') {
  (window as any).SHOGUN_RUNTIME?.pushToast?.(message, kind);
}

function activeRuntime(): any {
  return (window as any).SHOGUN_RUNTIME;
}

function parsePreviewArgs(value: string): Record<string, unknown> | null {
  try {
    const candidate = JSON.parse(value || '{}');
    if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object') return null;
    return candidate as Record<string, unknown>;
  } catch (_error) {
    return null;
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return String(args[key] || '').trim();
}

function stringProp(value: unknown, key: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return String((value as Record<string, unknown>)[key] || '').trim();
}

function parsePreviewJson(value: string): Record<string, unknown> | null {
  try {
    const candidate = JSON.parse(value || '');
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    return candidate as Record<string, unknown>;
  } catch (_error) {
    return null;
  }
}

function firstArrayItem(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value) || !value.length) return null;
  const first = value[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  return first as Record<string, unknown>;
}

function objectArrayProp(value: unknown, key: string): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const candidate = (value as Record<string, unknown>)[key];
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  );
}

function targetScreenForEntityId(entityId: string): string {
  const normalized = String(entityId || '').trim().toLowerCase();
  if (normalized.startsWith('company:') || normalized.startsWith('deal:')) return 'founder_sales';
  if (normalized.startsWith('investor:')) return 'fundraising';
  if (normalized.startsWith('project:') || normalized.startsWith('task:')) return 'project_memory';
  if (normalized.startsWith('workspace:')) return 'work';
  return 'entity_context';
}

function openEntitySurface(entityId: string): void {
  if (!entityId) return;
  if (openNativeDetailForEntityId(entityId)) return;
  focusEntity(entityId);
  activeRuntime()?.setActiveScreen?.(targetScreenForEntityId(entityId));
}

type PreviewResultRoute = {
  id: string;
  label: string;
  run: () => void;
};

function nativeRouteForTool(toolName: string, args: Record<string, unknown>): {
  label: string;
  run: () => void;
} | null {
  const name = String(toolName || '').trim();
  if (!name) return null;

  if (name === 'shogun.search_context' || name === 'shogun.memory_search') {
    const query = stringArg(args, 'query');
    if (!query) return null;
    return {
      label: 'Open Memory Search',
      run: () => jumpToMemorySearch(query, 'search'),
    };
  }

  if (name === 'shogun.memory_search_timeline') {
    const query = stringArg(args, 'query');
    if (!query) return null;
    return {
      label: 'Open Memory Timeline',
      run: () => jumpToMemorySearch(query, 'river'),
    };
  }

  if (name === 'shogun.get_recent_context') {
    return {
      label: 'Open Home',
      run: () => activeRuntime()?.setActiveScreen?.('home'),
    };
  }

  if (name === 'shogun.meetings_list' || name === 'shogun.meetings_search') {
    return {
      label: 'Open Meetings',
      run: () => activeRuntime()?.setActiveScreen?.('meetings'),
    };
  }

  if (name === 'shogun.get_customer_context' || name === 'shogun.get_project_context' || name === 'shogun.entity_context_get') {
    const entityId = stringArg(args, 'entityId');
    if (!entityId) return null;
    return {
      label: 'Open Related Surface',
      run: () => {
        openEntitySurface(entityId);
      },
    };
  }

  if (name === 'shogun.owner_context_summary') {
    const ownerEntityId = stringArg(args, 'ownerEntityId');
    if (!ownerEntityId) return null;
    return {
      label: 'Open Related Surface',
      run: () => {
        openEntitySurface(ownerEntityId);
      },
    };
  }

  if (
    name === 'shogun.get_meeting_summary' ||
    name === 'shogun.meeting_get' ||
    name === 'shogun.meeting_transcript' ||
    name === 'shogun.meeting_notes'
  ) {
    const meetingId = stringArg(args, 'meeting_id');
    if (!meetingId) return null;
    return {
      label: 'Open Meeting Detail',
      run: () => openMeetingDetail(meetingId),
    };
  }

  if (name === 'shogun.list_tasks' || name === 'shogun.action_queue_list' || name === 'shogun.queue_artifacts_list') {
    return {
      label: 'Open Actions',
      run: () => activeRuntime()?.setActiveScreen?.('actions'),
    };
  }

  if (name === 'shogun.ai_fields_list') {
    return {
      label: 'Open AI Fields',
      run: () => activeRuntime()?.setActiveScreen?.('ai_fields'),
    };
  }

  return null;
}

function pushPreviewRoute(
  routes: PreviewResultRoute[],
  seen: Set<string>,
  route: PreviewResultRoute | null,
): void {
  if (!route) return;
  if (seen.has(route.id)) return;
  seen.add(route.id);
  routes.push(route);
}

function previewResultRoutesForTool(
  toolName: string,
  previewOutput: string,
  args: Record<string, unknown>,
): PreviewResultRoute[] {
  const name = String(toolName || '').trim();
  const parsed = parsePreviewJson(previewOutput);
  if (!name || !parsed) return [];
  const routes: PreviewResultRoute[] = [];
  const seen = new Set<string>();

  const openAction = (action: Record<string, unknown>) => {
    const actionId = stringProp(action, 'id');
    if (!actionId) return;
    focusActionTrace({
      actionId,
      aiFieldId: stringProp(action, 'sourceAiFieldId') || null,
      openAudit: false,
    });
    const ownerEntityId = stringProp(action, 'ownerEntityId');
    if (ownerEntityId) focusEntity(ownerEntityId);
    activeRuntime()?.setActiveScreen?.('actions');
  };

  const openAiField = (field: Record<string, unknown>) => {
    const fieldId = stringProp(field, 'id');
    if (!fieldId) return;
    focusAiField(fieldId);
    const ownerEntityId = stringProp(field, 'ownerEntityId');
    if (ownerEntityId) focusEntity(ownerEntityId);
    activeRuntime()?.setActiveScreen?.('ai_fields');
  };

  const openQueueArtifact = (item: Record<string, unknown>) => {
    const queueId = stringProp(item, 'id');
    if (!queueId) return;
    const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? (item.payload as Record<string, unknown>)
      : {};
    openQueueArtifactInActions({
      queueId,
      sourceActionId: stringProp(payload, 'source_action_id') || null,
      sourceAiFieldId: null,
      ownerEntityId: stringProp(payload, 'owner_entity_id') || null,
    });
  };

  const openTimelineHit = (hit: Record<string, unknown>) => {
    const id = stringProp(hit, 'id');
    if (!id) return;
    const contentType = stringProp(hit, 'content_type');
    if (contentType === 'meeting' || id.startsWith('mtg-') || id.startsWith('meeting:')) {
      openMeetingDetail(id.replace(/^meeting:/, ''));
      return;
    }
    jumpToMemoryTimeline({
      memoryId: id,
      query: stringProp(hit, 'title') || stringArg(args, 'query'),
      view: 'river',
    });
  };

  const timelineRoute = (hit: Record<string, unknown>): PreviewResultRoute | null => {
    const id = stringProp(hit, 'id');
    if (!id) return null;
    const contentType = stringProp(hit, 'content_type');
    const title = stringProp(hit, 'title') || id;
    return {
      id: `timeline:${id}`,
      label: contentType === 'meeting' || id.startsWith('mtg-') || id.startsWith('meeting:')
        ? `Open meeting · ${title}`
        : `Open memory · ${title}`,
      run: () => openTimelineHit(hit),
    };
  };

  const aiFieldRoute = (field: Record<string, unknown>): PreviewResultRoute | null => {
    const id = stringProp(field, 'id');
    if (!id) return null;
    return {
      id: `ai_field:${id}`,
      label: `Open AI field · ${stringProp(field, 'fieldName') || id}`,
      run: () => openAiField(field),
    };
  };

  const actionRoute = (action: Record<string, unknown>): PreviewResultRoute | null => {
    const id = stringProp(action, 'id');
    if (!id) return null;
    return {
      id: `action:${id}`,
      label: `Open action · ${stringProp(action, 'title') || id}`,
      run: () => openAction(action),
    };
  };

  const queueRoute = (item: Record<string, unknown>): PreviewResultRoute | null => {
    const id = stringProp(item, 'id');
    if (!id) return null;
    const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? (item.payload as Record<string, unknown>)
      : {};
    return {
      id: `queue:${id}`,
      label: `Open queue item · ${stringProp(payload, 'title') || id}`,
      run: () => openQueueArtifact(item),
    };
  };

  const entityRoute = (entityId: string, label?: string): PreviewResultRoute | null => {
    const id = String(entityId || '').trim();
    if (!id) return null;
    return {
      id: `entity:${id}`,
      label: `Open related surface · ${label || id}`,
      run: () => openEntitySurface(id),
    };
  };

  if (name === 'shogun.search_context') {
    const timeline = parsed.timeline && typeof parsed.timeline === 'object' ? parsed.timeline as Record<string, unknown> : null;
    (Array.isArray(timeline?.hits) ? timeline?.hits : []).slice(0, 4).forEach((hit) => {
      if (hit && typeof hit === 'object' && !Array.isArray(hit)) {
        pushPreviewRoute(routes, seen, timelineRoute(hit as Record<string, unknown>));
      }
    });
    objectArrayProp(parsed.aiFields, 'items').slice(0, 3).forEach((field: Record<string, unknown>) => {
      pushPreviewRoute(routes, seen, aiFieldRoute(field));
    });
    objectArrayProp(parsed.actions, 'items').slice(0, 3).forEach((action: Record<string, unknown>) => {
      pushPreviewRoute(routes, seen, actionRoute(action));
    });
    objectArrayProp(parsed.queueArtifacts, 'items').slice(0, 3).forEach((item: Record<string, unknown>) => {
      pushPreviewRoute(routes, seen, queueRoute(item));
    });
  }

  if (name === 'shogun.get_recent_context') {
    const entityId = stringProp(parsed.entityContext, 'entityId') || stringProp(parsed, 'ownerEntityId');
    if (entityId) {
      pushPreviewRoute(routes, seen, entityRoute(entityId));
    }
    (Array.isArray(parsed.recentMeetings) ? parsed.recentMeetings : []).slice(0, 3).forEach((meeting) => {
      if (meeting && typeof meeting === 'object' && !Array.isArray(meeting)) {
        const id = stringProp(meeting, 'id');
        if (!id) return;
        pushPreviewRoute(routes, seen, {
          id: `meeting:${id}`,
          label: `Open meeting · ${stringProp(meeting, 'title') || id}`,
          run: () => openMeetingDetail(id),
        });
      }
    });
    objectArrayProp(parsed.recentAiFields, 'items').slice(0, 3).forEach((field: Record<string, unknown>) => {
      pushPreviewRoute(routes, seen, aiFieldRoute(field));
    });
    objectArrayProp(parsed.recentActions, 'items').slice(0, 3).forEach((action: Record<string, unknown>) => {
      pushPreviewRoute(routes, seen, actionRoute(action));
    });
    objectArrayProp(parsed.recentQueueArtifacts, 'items').slice(0, 3).forEach((item: Record<string, unknown>) => {
      pushPreviewRoute(routes, seen, queueRoute(item));
    });
  }

  if (
    name === 'shogun.get_customer_context'
    || name === 'shogun.get_project_context'
    || name === 'shogun.entity_context_get'
  ) {
    const entityId = stringProp(parsed, 'entityId');
    if (entityId) {
      pushPreviewRoute(routes, seen, entityRoute(entityId, stringProp(parsed, 'entityLabel') || entityId));
    }
  }

  if (name === 'shogun.owner_context_summary') {
    const entityId =
      stringProp(parsed.entityContext, 'entityId')
      || stringProp(parsed, 'ownerEntityId');
    if (entityId) {
      pushPreviewRoute(routes, seen, entityRoute(entityId));
    }
    objectArrayProp(parsed.actions, 'items').slice(0, 3).forEach((action: Record<string, unknown>) => {
      pushPreviewRoute(routes, seen, actionRoute(action));
    });
  }

  if (name === 'shogun.memory_search' || name === 'shogun.memory_search_timeline') {
    (Array.isArray(parsed.hits) ? parsed.hits : []).slice(0, 5).forEach((hit) => {
      if (hit && typeof hit === 'object' && !Array.isArray(hit)) {
        pushPreviewRoute(routes, seen, timelineRoute(hit as Record<string, unknown>));
      }
    });
  }

  if (name === 'shogun.memory_fetch') {
    (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 5).forEach((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        pushPreviewRoute(routes, seen, timelineRoute(item as Record<string, unknown>));
      }
    });
  }

  if (name === 'shogun.ai_fields_list') {
    (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 5).forEach((field) => {
      if (field && typeof field === 'object' && !Array.isArray(field)) {
        pushPreviewRoute(routes, seen, aiFieldRoute(field as Record<string, unknown>));
      }
    });
  }

  if (name === 'shogun.action_queue_list' || name === 'shogun.list_tasks') {
    (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 5).forEach((action) => {
      if (action && typeof action === 'object' && !Array.isArray(action)) {
        pushPreviewRoute(routes, seen, actionRoute(action as Record<string, unknown>));
      }
    });
  }

  if (name === 'shogun.action_audit_list') {
    const firstAudit = firstArrayItem(parsed.items);
    const actionId = stringProp(firstAudit, 'actionId') || stringArg(args, 'actionId');
    if (actionId) {
      pushPreviewRoute(routes, seen, {
        id: `audit:${actionId}`,
        label: `Open action audit · ${actionId}`,
        run: () => {
          focusActionTrace({ actionId, aiFieldId: null, openAudit: true });
          activeRuntime()?.setActiveScreen?.('actions');
        },
      });
    }
  }

  if (name === 'shogun.queue_artifacts_list') {
    (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 5).forEach((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        pushPreviewRoute(routes, seen, queueRoute(item as Record<string, unknown>));
      }
    });
  }

  return routes;
}

export function McpToolConsolePanel({
  title = 'Published SHOGUN MCP tools',
  description = 'Inspect the tool catalog bundled in this Mac app before opening Claude Desktop.',
}: {
  title?: string;
  description?: string;
}): JSX.Element | null {
  const ipc = React.useMemo(() => {
    if (!ShogunIpcClient || !ShogunIpcClient.createIpcClient) return null;
    return ShogunIpcClient.createIpcClient();
  }, []);
  const [toolCatalog, setToolCatalog] = React.useState<ToolCatalogSection[]>([]);
  const [toolCatalogTotal, setToolCatalogTotal] = React.useState(0);
  const [previewToolName, setPreviewToolName] = React.useState('');
  const [previewOutput, setPreviewOutput] = React.useState('');
  const [previewArgsText, setPreviewArgsText] = React.useState('{}');
  const [message, setMessage] = React.useState('');
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const parsedPreviewArgs = React.useMemo(
    () => parsePreviewArgs(previewArgsText),
    [previewArgsText],
  );
  const nativeRoute = React.useMemo(
    () => nativeRouteForTool(previewToolName, parsedPreviewArgs || {}),
    [parsedPreviewArgs, previewToolName],
  );
  const previewResultRoutes = React.useMemo(
    () => previewResultRoutesForTool(previewToolName, previewOutput, parsedPreviewArgs || {}),
    [parsedPreviewArgs, previewOutput, previewToolName],
  );

  const loadToolCatalog = React.useCallback(async () => {
    if (!ipc) return;
    setBusyAction('tools');
    const res = await ipc.invoke('mcp_setup_list_tools', {});
    setBusyAction(null);
    if (!res.ok) {
      setMessage(String(res.error?.message || 'Failed to load SHOGUN MCP tools'));
      return;
    }
    const sections = Array.isArray(res.data?.sections)
      ? (res.data.sections as ToolCatalogSection[])
      : [];
    setToolCatalog(sections);
    setToolCatalogTotal(Number(res.data?.total || 0));
    if (!previewToolName) {
      const firstName = String(sections[0]?.items?.[0]?.name || '').trim();
      if (firstName) {
        setPreviewToolName(firstName);
        setPreviewArgsText(JSON.stringify(sections[0]?.items?.[0]?.sampleArgs || {}, null, 2));
      }
    }
  }, [ipc, previewToolName]);

  React.useEffect(() => {
    void loadToolCatalog();
  }, [loadToolCatalog]);

  if (!ipc) return null;

  const selectPreviewTool = (toolName: string, sampleArgs?: Record<string, unknown>) => {
    const normalizedToolName = String(toolName || '').trim();
    if (!normalizedToolName) return;
    setPreviewToolName(normalizedToolName);
    setPreviewArgsText(JSON.stringify(sampleArgs || {}, null, 2));
  };

  const runPreview = async (toolName: string, args: Record<string, unknown>) => {
    const normalizedToolName = String(toolName || '').trim();
    if (!normalizedToolName) return;
    setBusyAction(`preview:${normalizedToolName}`);
    setPreviewToolName(normalizedToolName);
    setPreviewOutput('');
    const res = await ipc.invoke('mcp_setup_preview_tool', {
      toolName: normalizedToolName,
      args,
    });
    setBusyAction(null);
    if (!res.ok) {
      const nextMessage = String(res.error?.message || 'Failed to run MCP tool preview');
      setMessage(nextMessage);
      runtimeToast(nextMessage, 'warn');
      return;
    }
    const text = String(res.data?.text || '').trim();
    setPreviewOutput(text || '(empty response)');
    setMessage(`Ran ${normalizedToolName} with bundled sample args.`);
    runtimeToast(`Ran ${normalizedToolName} preview`, 'success');
  };

  const runEditedPreview = async () => {
    const normalizedToolName = String(previewToolName || '').trim();
    if (!normalizedToolName) {
      runtimeToast('Select an MCP tool first', 'warn');
      return;
    }
    const parsedArgs = parsePreviewArgs(previewArgsText);
    if (!parsedArgs) {
      const error = new Error('JSON must be an object');
      const nextMessage =
        error instanceof Error ? `Preview args JSON is invalid: ${error.message}` : 'Preview args JSON is invalid';
      setMessage(nextMessage);
      runtimeToast(nextMessage, 'warn');
      return;
    }
    await runPreview(normalizedToolName, parsedArgs);
  };

  const askChatAboutPreview = () => {
    const normalizedToolName = String(previewToolName || '').trim();
    const previewText = String(previewOutput || '').trim();
    if (!normalizedToolName || !previewText) {
      runtimeToast('Run an MCP preview first', 'warn');
      return;
    }
    openChatWithSeed({
      text: [
        `この SHOGUN MCP preview を読んで整理してください。`,
        `Tool: ${normalizedToolName}`,
        `Args:`,
        previewArgsText || '{}',
        `Output:`,
        previewText,
        '要点、気づき、次に試すべきことを提案してください。',
      ].join('\n\n').slice(0, 12000),
      assembleMemory: false,
      newChat: true,
    });
  };

  const openPreviewInApp = () => {
    if (!nativeRoute) {
      runtimeToast('This MCP tool does not map to a native app view yet', 'warn');
      return;
    }
    nativeRoute.run();
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
          <div className="s-field-hint">{description}</div>
        </div>
        <button className="btn btn-sm btn-secondary" type="button" disabled={busyAction === 'tools'} onClick={() => { void loadToolCatalog(); }}>
          {busyAction === 'tools' ? 'Loading…' : 'Refresh tools'}
        </button>
      </div>
      <div className="s-field-hint" style={{ marginBottom: 10 }}>
        {toolCatalogTotal > 0 ? `${toolCatalogTotal} tools available across meetings, memory, context, and kioku.` : 'No tool metadata loaded yet.'}
      </div>
      {message ? (
        <div className="s-field-hint" style={{ marginBottom: 10, lineHeight: 1.55 }}>
          {message}
        </div>
      ) : null}
      <div style={{ display: 'grid', gap: 10 }}>
        {toolCatalog.map((section) => (
          <div key={String(section.groupId || 'group')} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', background: 'var(--surface-2)' }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>{section.groupId || 'tools'}</div>
              <div className="t-mono" style={{ fontSize: 11, color: 'var(--text-mute)' }}>{Number(section.count || 0)} tools</div>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {(section.items || []).slice(0, 6).map((item) => (
                <div key={String(item.name || '')} style={{ paddingBottom: 4 }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="t-mono" style={{ fontSize: 11.5 }}>{item.name}</div>
                      <div className="s-field-hint" style={{ lineHeight: 1.45 }}>{item.description}</div>
                    </div>
                    <button
                      className="btn btn-sm btn-ghost"
                      type="button"
                      disabled={!!busyAction}
                      onClick={() => {
                        selectPreviewTool(String(item.name || ''), item.sampleArgs);
                        void runPreview(String(item.name || ''), item.sampleArgs || {});
                      }}
                    >
                      {busyAction === `preview:${String(item.name || '').trim()}` ? 'Running…' : 'Run preview'}
                    </button>
                  </div>
                </div>
              ))}
              {(section.items || []).length > 6 ? (
                <div className="s-field-hint">+ {(section.items || []).length - 6} more</div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', background: 'var(--surface)' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Preview output</div>
          <div className="t-mono" style={{ fontSize: 11, color: 'var(--text-mute)' }}>{previewToolName || 'No tool selected'}</div>
        </div>
        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-mute)', marginBottom: 6 }}>
          Editable preview args (JSON object)
        </label>
        <textarea
          aria-label="Editable preview args (JSON object)"
          className="s-input"
          value={previewArgsText}
          onChange={(e) => setPreviewArgsText(e.target.value)}
          rows={8}
          style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', marginBottom: 8 }}
          placeholder="{}"
        />
        <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm btn-secondary" type="button" disabled={!!busyAction || !previewToolName} onClick={() => { void runEditedPreview(); }}>
            {busyAction === `preview:${previewToolName}` ? 'Running…' : 'Run edited args'}
          </button>
          <button
            className="btn btn-sm btn-ghost"
            type="button"
            disabled={!previewResultRoutes.length}
            onClick={() => previewResultRoutes[0]?.run()}
          >
            {previewResultRoutes[0]?.label || 'Open Preview Result'}
          </button>
          <button
            className="btn btn-sm btn-ghost"
            type="button"
            disabled={!nativeRoute}
            onClick={openPreviewInApp}
          >
            {nativeRoute?.label || 'Open in App'}
          </button>
          <button
            className="btn btn-sm btn-ghost"
            type="button"
            disabled={!String(previewOutput || '').trim()}
            onClick={askChatAboutPreview}
          >
            Ask Chat
          </button>
          <button
            className="btn btn-sm btn-ghost"
            type="button"
            disabled={!!busyAction || !previewToolName}
            onClick={() => {
              const selected = toolCatalog
                .flatMap((section) => section.items || [])
                .find((item) => String(item.name || '').trim() === String(previewToolName || '').trim());
              setPreviewArgsText(JSON.stringify(selected?.sampleArgs || {}, null, 2));
            }}
          >
            Reset to sample
          </button>
        </div>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-dim)' }}>
          {previewOutput || 'Run a preview from one of the listed MCP tools to inspect its current text payload.'}
        </pre>
        {previewResultRoutes.length > 1 ? (
          <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
            <div className="s-field-hint">Preview result deep links</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {previewResultRoutes.map((route) => (
                <button
                  key={route.id}
                  className="btn btn-sm btn-ghost"
                  type="button"
                  onClick={route.run}
                  style={{ justifyContent: 'flex-start' }}
                >
                  {route.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
