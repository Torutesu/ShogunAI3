import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import '@/shared/tokens/tokens.css';
import '@/shared/tokens/app.css';

// Phase 3 Step 2: All shared/lib and shared/ipc modules are now imported directly
// via ESM from their consumer files. Only legal-versions remains here as a side-effect
// import because its window binding is consumed by the e2e test helper (preseed-consent.js)
// which installs an Object.defineProperty accessor trap on window.SHOGUN_LEGAL_VERSIONS.
// All other modules' window bindings have been removed and their symbols are imported
// directly by the files that need them.
import '@/shared/lib/legal-versions';
import '@/shared/ipc/runtime-actions';
// Phase 2.1.4 (cloud-mirror): memory-search.js installs window.ShogunMemorySearch
// for action-registry.ts's "memory.search" merge layer. Kept as a side-effect
// import for now — the IIFE shape is from the cloud-mirror branch; Phase 8 can
// ESM-ify it and remove the window binding.
import '@/shared/ipc/memory-search';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
