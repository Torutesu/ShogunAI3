import { ContextLensScreen } from '@/features/context-lens';

export function ProjectMemoryScreen(): JSX.Element {
  return (
    <ContextLensScreen
      config={{
        headerEyebrow: 'APPLICATION LAYER',
        title: 'Project Memory',
        titleJp: 'プロジェクト記憶',
        descriptionEn: 'A builder-memory lens on the shared context core. Projects and tasks are assembled from the same AI Fields and Actions instead of a separate project tracker database.',
        descriptionJp: '別の project tracker 専用 DB ではなく、shared core の AI Fields / Actions から project / task を束ねる builder memory lens です。',
        summaryText: 'current blocker / next action / decision / owner / unresolved issue を、同じ shared core の追跡状態と Action Queue から再構成しています。',
        searchPlaceholder: 'Search project, task, blocker, decision, next action…',
        loadingText: 'Loading project memory context…',
        emptyText: 'No project:/task: entities found yet. Shared AI Fields and Actions with project-oriented owner ids will appear here.',
        ownerKinds: ['project', 'task'],
        fieldPriority: ['blocker', 'owner', 'status', 'next_action', 'decision', 'unresolved_issue'],
        statLabels: {
          primary: 'projects',
          secondary: 'tasks',
          openActions: 'open actions',
        },
        taskInbox: {
          title: 'Shared task queue across project and task entities',
          description: 'Pending create_task actions are pulled from the same desktop Action Layer, so builder follow-ups stay reviewable without introducing a separate task tracker.',
          emptyText: 'No pending shared tasks for project/task owners yet.',
          statuses: ['proposed', 'approved'],
          limit: 6,
        },
      }}
    />
  );
}
