import React, { useCallback, useEffect, useState } from 'react';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';

function readWorkProjects(): Record<string, unknown>[] {
  const get = (window as Window & { SHOGUN_RUNTIME?: { getWorkProjects?: () => Record<string, unknown>[] } })
    .SHOGUN_RUNTIME?.getWorkProjects;
  return typeof get === 'function' ? get() : [];
}

/** Workspace assignment state shared across memory views. */
export function useMemoryWorkspace(): {
  workspaceAssignments: Record<string, string>;
  setWorkspaceAssignments: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  workProjects: Record<string, unknown>[];
  assignMemoryToWorkspace: (memoryId: string, workspaceId: string | null) => Promise<void>;
} {
  const [workspaceAssignments, setWorkspaceAssignments] = useState<Record<string, string>>({});
  const [workProjects, setWorkProjects] = useState<Record<string, unknown>[]>(readWorkProjects);
  const applyWorkspaceAssignmentsResponse = useCallback((r: any) => {
    const data = r?.data as {
      settings?: { sections?: { workspace_memberships?: { memberships?: Record<string, string> } } };
    } | undefined;
    const map = data?.settings?.sections?.workspace_memberships?.memberships;
    if (map && typeof map === 'object') setWorkspaceAssignments(map);
    else setWorkspaceAssignments({});
  }, []);
  const reloadWorkspaceAssignments = useCallback(async () => {
    const r = await runRuntimeAction('settings.load', {}, { silentError: true });
    applyWorkspaceAssignmentsResponse(r);
    return r;
  }, [applyWorkspaceAssignmentsResponse]);

  useEffect(() => {
    const syncProjects = () => setWorkProjects(readWorkProjects());
    syncProjects();
    window.addEventListener('shogun-work-projects-changed', syncProjects);
    return () => window.removeEventListener('shogun-work-projects-changed', syncProjects);
  }, []);

  useEffect(() => {
    void reloadWorkspaceAssignments();
  }, [reloadWorkspaceAssignments]);

  useEffect(() => {
    const onWorkspaceMembershipsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ memberships?: Record<string, string> }>).detail;
      const map = detail?.memberships;
      if (map && typeof map === 'object') {
        setWorkspaceAssignments(map);
        return;
      }
      void reloadWorkspaceAssignments();
    };
    window.addEventListener('shogun-workspace-memberships-changed', onWorkspaceMembershipsChanged as EventListener);
    return () => {
      window.removeEventListener('shogun-workspace-memberships-changed', onWorkspaceMembershipsChanged as EventListener);
    };
  }, [reloadWorkspaceAssignments]);

  useEffect(() => {
    const onSettingsRefresh = () => { void reloadWorkspaceAssignments(); };
    window.addEventListener('shogun-settings-refresh', onSettingsRefresh);
    return () => window.removeEventListener('shogun-settings-refresh', onSettingsRefresh);
  }, [reloadWorkspaceAssignments]);

  const assignMemoryToWorkspace = useCallback(async (memoryId: string, workspaceId: string | null) => {
    if (!memoryId) return;
    const next = { ...workspaceAssignments };
    if (workspaceId) next[memoryId] = workspaceId;
    else delete next[memoryId];
    setWorkspaceAssignments(next);
    await runRuntimeAction(
      'settings.save',
      { section: 'workspace_memberships', memberships: next },
      { silentError: true },
    );
    try {
      window.dispatchEvent(new CustomEvent('shogun-workspace-memberships-changed', {
        detail: { memberships: next },
      }));
    } catch {
      /* ignore */
    }
  }, [workspaceAssignments]);

  return { workspaceAssignments, setWorkspaceAssignments, workProjects, assignMemoryToWorkspace };
}
