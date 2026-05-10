import React from 'react';

export function useRuntimeActions() {
  const run = React.useCallback(async (key: string, payload?: any, options?: any) => {
    if (!( window as any).SHOGUN_RUNTIME || !(window as any).SHOGUN_RUNTIME.executeAction) return { ok: false };
    return (window as any).SHOGUN_RUNTIME.executeAction(key, payload, options || {});
  }, []);
  const confirmWrite = React.useCallback((key: string, payload: any, title: string, description: string) => {
    if (!(window as any).SHOGUN_RUNTIME || !(window as any).SHOGUN_RUNTIME.requestWriteAction) return;
    (window as any).SHOGUN_RUNTIME.requestWriteAction(key, payload, title, description);
  }, []);
  const toast = React.useCallback((message: string, kind?: string) => {
    if ((window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.pushToast) {
      (window as any).SHOGUN_RUNTIME.pushToast(message, kind || 'info');
    }
  }, []);
  return { run, confirmWrite, toast };
}
