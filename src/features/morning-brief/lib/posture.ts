import type { Posture, ContextItemType, FocusBlock } from '../types';

export const POSTURE_LABEL: Record<Posture, string> = {
  focus: 'Focus',
  'meeting-heavy': 'Meeting-heavy',
  recovery: 'Recovery',
  launch: 'Launch',
};

export const CONTEXT_ICON: Record<ContextItemType, string> = {
  document: 'note',
  person: 'users',
  decision: 'check',
  slack_thread: 'chat',
  email: 'mail',
  commit: 'terminal',
  calendar: 'calendar',
};

export function contextIconName(type: ContextItemType | string | undefined): string {
  if (!type) return 'file';
  return (CONTEXT_ICON as Record<string, string>)[type] || 'file';
}

export function formatFocusBlocks(blocks: FocusBlock[] | undefined): string | null {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  return blocks
    .map((b) => {
      const h = Math.round((b.duration_minutes || 0) / 60);
      const hm = h > 0 ? `${h}h` : `${b.duration_minutes || 0}m`;
      return `${b.start}-${b.end} (${hm})`;
    })
    .join(' · ');
}
