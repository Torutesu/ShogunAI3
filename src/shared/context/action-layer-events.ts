export const ACTION_LAYER_REFRESH_EVENT = 'shogun-action-layer-refresh';

export function dispatchActionLayerRefresh(reason: string): void {
  const detail = { reason: String(reason || 'unknown').trim() || 'unknown' };
  window.dispatchEvent(new CustomEvent(ACTION_LAYER_REFRESH_EVENT, { detail }));
}
