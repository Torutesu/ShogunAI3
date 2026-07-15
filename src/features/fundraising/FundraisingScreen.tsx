import { ContextLensScreen } from '@/features/context-lens';

export function FundraisingScreen(): JSX.Element {
  return (
    <ContextLensScreen
      config={{
        headerEyebrow: 'APPLICATION LAYER',
        title: 'Fundraising',
        titleJp: '資金調達コンテキスト',
        descriptionEn: 'A fundraising CRM lens on the shared context core. Investors and fundraising deals are assembled from AI Fields and Actions, not a separate investor database.',
        descriptionJp: '投資家専用 DB を増やさず、shared core の AI Fields / Actions から investor / deal を束ねる fundraising CRM lens です。',
        summaryText: 'investor concern / check size / decision process / next action / interest level を、同じ shared core の追跡状態と Action Queue から再構成しています。',
        searchPlaceholder: 'Search investor, deal, concern, check size, next action…',
        loadingText: 'Loading fundraising context…',
        emptyText: 'No investor:/deal: entities found yet. Shared AI Fields and Actions with fundraising-oriented owner ids will appear here.',
        ownerKinds: ['investor', 'deal'],
        fieldPriority: ['investor_concern', 'interest_level', 'check_size', 'decision_process', 'next_action', 'blocker'],
        statLabels: {
          primary: 'investors',
          secondary: 'deals',
          openActions: 'open actions',
        },
        taskInbox: {
          title: 'Shared fundraising tasks across investor and deal entities',
          description: 'Pending create_task actions stay on the same desktop Action Layer, so investor follow-ups and diligence work remain reviewable without a separate fundraising task system.',
          emptyText: 'No pending shared fundraising tasks yet.',
          statuses: ['proposed', 'approved'],
          limit: 6,
        },
      }}
    />
  );
}
