import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import '@/shared/tokens/tokens.css';
import '@/shared/tokens/app.css';

// Side-effect imports: each shared/lib and shared/ipc module installs its
// public API on `window.X` at module-evaluation time. Feature code reads
// these as `(window as any).X` (a Phase 1/2 expedient). Without these
// side-effect imports the modules get tree-shaken and the globals are
// never set. Phase 3 will incrementally migrate readers to ESM imports
// and remove these one by one.
import '@/shared/lib/markdown-mini';
import '@/shared/lib/highlight';
import '@/shared/lib/brief-telemetry';
import '@/shared/lib/morning-brief';
import '@/shared/lib/meeting-media-recording';
import '@/shared/lib/meeting-note-local';
import '@/shared/lib/integration-connectors';
import '@/shared/lib/clerk-auth';
import '@/shared/lib/demo-seed';
import '@/shared/lib/keyboard-shortcuts';
import '@/shared/lib/legal-versions';
import '@/shared/lib/user-timezone';
import '@/shared/ipc/ipc-client';
import '@/shared/ipc/shogun-api';
import '@/shared/ipc/action-registry';
import '@/shared/ipc/runtime-actions';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
