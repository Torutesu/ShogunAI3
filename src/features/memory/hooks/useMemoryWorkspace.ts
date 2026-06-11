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

  useEffect(() => {
    const syncProjects = () => setWorkProjects(readWorkProjects());
    syncProjects();
    window.addEventListener('shogun-work-projects-changed', syncProjects);
    return () => window.removeEventListener('shogun-work-projects-changed', syncProjects);
  }, []);

  useEffect(() => {
    runRuntimeAction('settings.load', {}, { silentError: true }).then((r) => {
      const data = r?.data as {
        settings?: { sections?: { workspace_memberships?: { memberships?: Record<string, string> } } };
      } | undefined;
      const map = data?.settings?.sections?.workspace_memberships?.memberships;
      if (map && typeof map === 'object') setWorkspaceAssignments(map);
    });
  }, []);

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
