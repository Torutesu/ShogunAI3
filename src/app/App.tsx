// App entry point (Phase 2 Step 11: split from monolith)
// src/main.tsx imports { App } from '@/app/App' — this re-export keeps that stable.
import React from 'react';
import { ShogunErrorBoundary } from './ErrorBoundary';
import { AppCore } from './AppCore';

export function App(): React.ReactElement {
  return (
    <ShogunErrorBoundary>
      <AppCore />
    </ShogunErrorBoundary>
  );
}
