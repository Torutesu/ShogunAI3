/** After a successful appearance save, live-apply tokens in `app.jsx` without closing the modal. */
export function scheduleAppearanceLive(run: (key: string, payload: any, options: any) => Promise<any>, appearance: any) {
  void run(
    'settings.save',
    { section: 'appearance', ...appearance },
    { silentError: true },
  ).then((res: any) => {
    if (res && res.ok) {
      window.dispatchEvent(
        new CustomEvent('shogun-appearance-changed', { detail: { appearance } }),
      );
    }
  });
}
