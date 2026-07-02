import { ContextLensScreen } from '@/features/context-lens';

export function FounderSalesScreen(): JSX.Element {
  return (
    <ContextLensScreen
      config={{
        headerEyebrow: 'APPLICATION LAYER',
        title: 'Founder Sales',
        titleJp: '営業コンテキスト',
        descriptionEn: 'A thin AI CRM surface built on the shared context core. Companies and deals are assembled from AI Fields and Actions instead of a separate sales database.',
        descriptionJp: '別の営業専用 DB ではなく、shared core の AI Fields / Actions から会社と商談を束ねる薄い AI CRM surface です。',
        summaryText: 'blocker / next action / budget / decision maker といった追跡状態と、人間承認つき Action Queue を sales lens で再構成しています。',
        searchPlaceholder: 'Search company, deal, blocker, budget, next action…',
        loadingText: 'Loading founder sales context…',
        emptyText: 'No company:/deal: entities found yet. Shared AI Fields and Actions with sales-oriented owner ids will appear here.',
        ownerKinds: ['company', 'deal'],
        fieldPriority: ['blocker', 'next_action', 'budget', 'decision_maker', 'urgency', 'competitor'],
        statLabels: {
          primary: 'companies',
          secondary: 'deals',
          openActions: 'open actions',
        },
        taskInbox: {
          title: 'Shared follow-up tasks across company and deal entities',
          description: 'Pending create_task actions stay in the same desktop Action Layer, so sales follow-ups remain reviewable without introducing a separate CRM task store.',
          emptyText: 'No pending shared sales tasks yet.',
          statuses: ['proposed', 'approved'],
          limit: 6,
        },
      }}
    />
  );
}
