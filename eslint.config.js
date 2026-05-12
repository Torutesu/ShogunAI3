import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import importPlugin from 'eslint-plugin-import';
import unusedImports from 'eslint-plugin-unused-imports';
import boundaries from 'eslint-plugin-boundaries';
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
      // boundaries: error from Phase 2 Step 12 onward — enforces feature isolation
      'boundaries/element-types': ['error', {
        default: 'allow',
        rules: [
          { from: 'shared', disallow: ['app', 'feature'] },
          { from: 'app', allow: ['feature', 'shared'] },
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
    ignores: ['web-dist/**', 'dist/**', 'node_modules/**', 'src-tauri/**', 'tools/amc-pipeline/**', 'hifi/**'],
  },
];
