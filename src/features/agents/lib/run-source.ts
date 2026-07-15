export function formatAgentRunSource(source?: string): string {
  const raw = String(source || '').trim();
  if (!raw) return '';
  if (raw === 'builtin_manual') return 'manual';
  if (raw === 'custom_agent_background') return 'background';
  if (raw === 'custom_agent') return 'manual';
  if (raw === 'custom_agent_manual') return 'manual';
  if (raw.startsWith('custom_agent_event:')) return `event:${raw.slice('custom_agent_event:'.length)}`;
  if (raw.startsWith('custom_agent_')) return raw.replace(/^custom_agent_/, '');
  return raw;
}
