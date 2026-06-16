import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import importPlugin from 'eslint-plugin-import';
import unusedImports from 'eslint-plugin-unused-imports';
import boundaries from 'eslint-plugin-boundaries';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        project: './tsconfig.json',
      },
      globals: {
        ...globals.browser,
        __TAURI__: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react,
      'react-hooks': reactHooks,
      import: importPlugin,
      'unused-imports': unusedImports,
      boundaries,
      'jsx-a11y': jsxA11y,
    },
    settings: {
      react: { version: 'detect' },
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
      },
      'boundaries/elements': [
        { type: 'app', pattern: 'src/app/**' },
        { type: 'feature', pattern: 'src/features/*/**', capture: ['feature'] },
        { type: 'shared', pattern: 'src/shared/**' },
      ],
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Allow conventional underscore-prefix for intentionally unused vars
      // (e.g. `catch (_e) { /* ignore */ }`).
      'no-unused-vars': ['error', {
        args: 'none',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Empty `catch {}` is OK — intentional ignore.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'import/no-cycle': 'error',
      'import/no-self-import': 'error',
      'unused-imports/no-unused-imports': 'error',
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['hifi/**', '../../hifi/**'], message: 'hifi/ is removed in Phase 1; use src/ paths.' }],
      }],
      // Screen-level files are allowed up to 1500 lines (screens own deep state +
      // many handlers + JSX). Phase 5 may decompose further by extracting state
      // hooks. Library and component files should stay much smaller — but the
      // rule applies uniformly; per-file overrides aren't worth the complexity.
      'max-lines': ['warn', { max: 1500, skipBlankLines: true, skipComments: true }],
      // jsx-a11y recommended set, as warnings for now (Phase 7 Step 4 baseline).
      // Move individual rules to 'error' once they're at zero violations.
      'jsx-a11y/alt-text': 'warn',
      'jsx-a11y/anchor-has-content': 'warn',
      'jsx-a11y/anchor-is-valid': 'warn',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-proptypes': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/aria-unsupported-elements': 'error',
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/heading-has-content': 'warn',
      'jsx-a11y/iframe-has-title': 'warn',
      'jsx-a11y/img-redundant-alt': 'warn',
      'jsx-a11y/interactive-supports-focus': 'warn',
      'jsx-a11y/label-has-associated-control': 'warn',
      'jsx-a11y/no-access-key': 'warn',
      'jsx-a11y/no-autofocus': 'warn',
      'jsx-a11y/no-distracting-elements': 'warn',
      'jsx-a11y/no-noninteractive-element-interactions': 'off',  // too noisy without ARIA story
      'jsx-a11y/no-noninteractive-tabindex': 'warn',
      'jsx-a11y/no-redundant-roles': 'warn',
      'jsx-a11y/no-static-element-interactions': 'off',  // common pattern in this codebase
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/role-supports-aria-props': 'error',
      'jsx-a11y/scope': 'warn',
      'jsx-a11y/tabindex-no-positive': 'warn',
      // boundaries: error from Phase 2 Step 12 onward — enforces feature isolation
      'boundaries/element-types': ['error', {
        default: 'allow',
        rules: [
          { from: 'shared', disallow: ['app', 'feature'] },
          { from: 'app', allow: ['feature', 'shared'] },
          // Same-feature imports OK; cross-feature imports blocked via capture match.
          { from: 'feature', allow: ['shared', ['feature', { feature: '${from.feature}' }]] },
        ],
      }],
    },
  },
  {
    files: ['tests/**/*.js', 'tests/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.commonjs },
    },
    rules: {
      'max-lines': 'off',
      // Tests use _e / _ for unused catch args; CJS uses require/module.
      'no-unused-vars': ['error', {
        args: 'none',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Node scripts and tool configs. Includes Playwright config (CJS) and Vite configs.
    files: ['scripts/**/*.mjs', 'scripts/**/*.js', 'playwright.config.js', 'vite.config.ts', 'vitest.config.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.commonjs },
    },
    rules: {
      'no-unused-vars': ['error', {
        args: 'none',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    ignores: ['web-dist/**', 'web/.next/**', 'dist/**', 'node_modules/**', 'src-tauri/**', 'tools/amc-pipeline/**', 'hifi/**', '.worktrees/**', '.claude-stash/**'],
  },
];
