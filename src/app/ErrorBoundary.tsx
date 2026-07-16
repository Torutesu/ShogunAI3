// ShogunErrorBoundary extracted from App.tsx (Phase 2 Step 11)
import React from 'react';
import { captureError } from '@/shared/lib/product-telemetry';

interface ErrorBoundaryState {
  hasError: boolean;
  err: Error | null;
}

export class ShogunErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, err: null };
  }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, err: error };
  }
  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      if (
        (window as any).ShogunErrorReporting &&
        typeof (window as any).ShogunErrorReporting.reportReactError === 'function'
      ) {
        (window as any).ShogunErrorReporting.reportReactError(error, info);
      }
    } catch (_) {
      /* ignore */
    }
    // Aggregate crash signal (scope only, no message) — no-op unless the user
    // opted into telemetry. Gives the team a crash-rate number without content.
    try {
      captureError('render');
    } catch (_) {
      /* ignore */
    }
  }
  override render(): React.ReactNode {
    if (this.state.hasError && this.state.err) {
      const e = this.state.err;
      const msg = e && e.message ? String(e.message) : String(e);
      return (
        <div
          style={{
            padding: 32,
            fontFamily: 'var(--font-sans, system-ui, sans-serif)',
            maxWidth: 520,
            margin: '8vh auto',
            color: 'var(--text, #e8e8e8)',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Something went wrong</div>
          <div
            className="en-only"
            style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-dim, rgba(255,255,255,0.65))' }}
          >
            {msg}
          </div>
          <div
            className="jp"
            style={{
              fontSize: 13,
              lineHeight: 1.55,
              color: 'var(--text-dim, rgba(255,255,255,0.65))',
              marginTop: 8,
            }}
          >
            予期しないエラーが発生しました。下部のボタンで再試行できます。
          </div>
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginTop: 20 }}
            onClick={() => this.setState({ hasError: false, err: null })}
          >
            Try again / 再試行
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
