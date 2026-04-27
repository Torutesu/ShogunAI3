#!/usr/bin/env node
// Local Google OAuth helper for SHOGUN AI (dev).
// Obtains access + refresh tokens for Gmail + Calendar read-only scopes
// and prints `invoke` commands to paste into Tauri DevTools.
//
// Usage:
//   node scripts/oauth-google.mjs
//   node scripts/oauth-google.mjs --show-secrets
//   node scripts/oauth-google.mjs --timeout-ms=120000
//   node scripts/oauth-google.mjs --help
//
// Reads CLIENT_ID / CLIENT_SECRET from scripts/.env.google-oauth.
// See scripts/.env.google-oauth.example for the format.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '.env.google-oauth');
const PORT = 8723;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const DEFAULT_TIMEOUT_MS = 180000;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

function parseArgs(argv) {
  const opts = {
    showSecrets: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (const arg of argv) {
    if (arg === '--show-secrets') {
      opts.showSecrets = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(`
Usage:
  node scripts/oauth-google.mjs [--show-secrets] [--timeout-ms=180000]

Options:
  --show-secrets      平文トークン/クライアントシークレットを表示（デフォルトはマスク）
  --timeout-ms=<ms>   OAuth待機・トークン交換のタイムアウト (既定: ${DEFAULT_TIMEOUT_MS}ms)
  --help, -h          このヘルプを表示
`);
      process.exit(0);
    }
    if (arg.startsWith('--timeout-ms=')) {
      const raw = arg.slice('--timeout-ms='.length);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`\n✗ --timeout-ms は正の数値で指定してください: ${raw}\n`);
        process.exit(1);
      }
      opts.timeoutMs = parsed;
      continue;
    }
    console.error(`\n✗ 不明な引数: ${arg}\n`);
    process.exit(1);
  }
  return opts;
}

function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    console.error(`\n✗ ${ENV_PATH} が存在しません。`);
    console.error(`  scripts/.env.google-oauth.example をコピーして値を埋めてください:`);
    console.error(`  cp scripts/.env.google-oauth.example scripts/.env.google-oauth\n`);
    process.exit(1);
  }
  const out = {};
  for (const raw of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  if (!out.CLIENT_ID || !out.CLIENT_SECRET) {
    console.error(`\n✗ CLIENT_ID または CLIENT_SECRET が ${ENV_PATH} に設定されていません。\n`);
    process.exit(1);
  }
  return { clientId: out.CLIENT_ID, clientSecret: out.CLIENT_SECRET };
}

function buildAuthUrl({ clientId, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['/d', '/s', '/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    // fall through — user can manually open the printed URL
  }
}

async function exchangeCode({ code, clientId, clientSecret, timeoutMs }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`token exchange timeout (${timeoutMs}ms)`)), timeoutMs);
  let resp;
  try {
    resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ac.signal,
    });
  } catch (e) {
    if (ac.signal.aborted) {
      throw new Error(`Token exchange timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Token exchange failed [${resp.status}]: ${text}`);
  }
  return JSON.parse(text);
}

function htmlPage(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:80px auto;padding:24px;color:#222}
h1{font-size:20px}.ok{color:#0a7a2a}.err{color:#b00020}code{background:#f4f4f4;padding:2px 6px;border-radius:4px}
</style></head><body>${body}</body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildInvokePayload(tokens, { clientId, clientSecret }) {
  const payload = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    oauthClientId: clientId,
    oauthClientSecret: clientSecret,
  };
  if (typeof tokens.expires_in === 'number') {
    payload.expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;
  }
  if (typeof tokens.scope === 'string' && tokens.scope.trim()) {
    payload.scopes = tokens.scope.split(/\s+/).filter(Boolean);
  }
  return payload;
}

function maskSecret(value) {
  if (!value) return value;
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

function redactPayload(payload) {
  return {
    ...payload,
    accessToken: maskSecret(payload.accessToken),
    refreshToken: maskSecret(payload.refreshToken),
    oauthClientSecret: maskSecret(payload.oauthClientSecret),
  };
}

function printInvokeCommands(tokens, cfg, opts) {
  const base = buildInvokePayload(tokens, cfg);
  const providers = ['gmail', 'google_calendar'];
  console.log('\n========================================');
  console.log('✓ トークン取得成功');
  console.log('========================================');
  if (tokens.scope) console.log(`\nscopes: ${tokens.scope}`);
  if (tokens.expires_in) console.log(`expires_in: ${tokens.expires_in}s`);
  console.log(`refresh_token: ${tokens.refresh_token ? '✓ 取得済み' : '✗ 取得失敗'}`);
  if (!tokens.refresh_token) {
    console.log('\n⚠ refresh_token が返っていません。Google Cloud Console の OAuth 画面で「access_type=offline, prompt=consent」が有効か確認してください。');
  }
  console.log('\n----------------------------------------');
  console.log('DevTools に貼り付けるコマンド (2 本ずつ実行):');
  if (!opts.showSecrets) {
    console.log('※ 現在は secrets をマスク表示しています。実投入時は --show-secrets を付けて再実行してください。');
  }
  console.log('----------------------------------------\n');
  for (const provider of providers) {
    const full = { provider, ...base };
    const printable = opts.showSecrets ? full : redactPayload(full);
    console.log(`// ${provider}`);
    console.log(`await window.__TAURI_INTERNALS__.invoke('app_integration_import_credentials', {`);
    console.log(`  payload: ${JSON.stringify(printable, null, 2).replace(/\n/g, '\n  ')}`);
    console.log(`});`);
    console.log(`await window.__TAURI_INTERNALS__.invoke('app_integration_credentials_status', { payload: { provider: '${provider}' } });`);
    console.log('');
  }
  console.log('----------------------------------------');
  console.log('期待される status 応答: { configured: true, tokenRefreshReady: true, provider: "..." }');
  console.log('----------------------------------------\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadEnv();
  const state = randomBytes(16).toString('hex');
  const authUrl = buildAuthUrl({ clientId: cfg.clientId, state });

  console.log(`\n▸ ローカルサーバを ${REDIRECT_URI} で起動します...`);
  console.log(`▸ ブラウザで Google の consent 画面を開きます。`);
  console.log(`   手動で開く場合は次の URL: \n   ${authUrl}\n`);

  const result = await new Promise((resolve, reject) => {
    let settled = false;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');
      const err = url.searchParams.get('error');
      try {
        if (err) throw new Error(`OAuth error: ${err}`);
        if (!code) throw new Error('missing authorization code');
        if (gotState !== state) throw new Error('state mismatch (CSRF?)');
        const tokens = await exchangeCode({ code, ...cfg, timeoutMs: opts.timeoutMs });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlPage('Success', `<h1 class="ok">✓ 認証完了</h1><p>ターミナルに戻ってログを確認してください。このタブは閉じて OK です。</p>`));
        server.close();
        if (!settled) {
          settled = true;
          resolve(tokens);
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          htmlPage(
            'Error',
            `<h1 class="err">✗ エラー</h1><p><code>${escapeHtml(String(e.message || e))}</code></p>`,
          ),
        );
        server.close();
        if (!settled) {
          settled = true;
          reject(e);
        }
      }
    });
    const timeout = setTimeout(() => {
      server.close();
      if (!settled) {
        settled = true;
        reject(new Error(`OAuth callback timed out after ${opts.timeoutMs}ms`));
      }
    }, opts.timeoutMs);
    server.on('close', () => clearTimeout(timeout));
    server.on('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    server.listen(PORT, () => openBrowser(authUrl));
  });

  printInvokeCommands(result, cfg, opts);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message || e}\n`);
  process.exit(1);
});
