import React, { useState } from 'react';
import { Pane } from '../components/Pane';
import { Row } from '../components/Row';
import { Field } from '../components/Field';
import { Toggle } from '../components/Toggle';
import { useRuntimeActions } from '../lib/hooks';
import { normalizeEmbedBackfillBatch, normalizeEmbedBackfillDelayMs } from '../lib/utils';
import { EMBED_BACKFILL_BATCH_OPTS, EMBED_BACKFILL_DELAY_OPTS } from '../lib/defaults';
import { SettingsHydrationContext } from '../types';

export function PaneLLM() {
  const { run, toast } = useRuntimeActions();
  const { sections, refreshSections } = React.useContext(SettingsHydrationContext);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [keyProvider, setKeyProvider] = useState<string | null>(null);
  const [keyPreview, setKeyPreview] = useState<string | null>(null);
  const [backfillLimit, setBackfillLimit] = useState(40);
  const [backfillDelayMs, setBackfillDelayMs] = useState(0);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{ index: number; total: number } | null>(null);
  const [memorySemanticDefault, setMemorySemanticDefault] = useState(true);

  React.useEffect(() => {
    // Native progress is bridged to a DOM CustomEvent by ipc-client.
    const onProgress = (ev: any) => {
      const p = (ev && ev.detail) || {};
      const index = Number(p.index);
      const total = Number(p.total);
      if (Number.isFinite(index) && Number.isFinite(total)) {
        setBackfillProgress({ index, total });
      }
    };
    window.addEventListener('shogun-memory-embed-backfill-progress', onProgress);
    return () => {
      window.removeEventListener('shogun-memory-embed-backfill-progress', onProgress);
    };
  }, []);

  const refreshKeyStatus = React.useCallback(async () => {
    const r = await run('llm.api_key_status', {}, { silentError: true });
    if (r.ok && r.data && typeof r.data.configured === 'boolean') {
      setKeyConfigured(r.data.configured);
      setKeyProvider(typeof r.data.provider === 'string' ? r.data.provider : null);
      setKeyPreview(typeof r.data.keyPreview === 'string' ? r.data.keyPreview : null);
    }
  }, [run]);

  React.useEffect(() => {
    void refreshKeyStatus();
  }, [refreshKeyStatus]);

  const persistEmbedBackfillPrefs = React.useCallback(
    async (patch: any) => {
      const r = await run('settings.save', { section: 'llm', ...patch }, { silentError: true });
      if (r.ok && refreshSections) await refreshSections();
    },
    [run, refreshSections],
  );

  React.useEffect(() => {
    const l = sections.llm;
    if (!l || typeof l !== 'object') return;
    if (l.baseUrl != null) setBaseUrl(String(l.baseUrl));
    if (l.model != null) setModel(String(l.model));
    if (l.embeddingModel != null) setEmbeddingModel(String(l.embeddingModel));
    if (l.maxTokens != null) setMaxTokens(String(l.maxTokens));
    if (l.embedBackfillBatch != null) setBackfillLimit(normalizeEmbedBackfillBatch(l.embedBackfillBatch, EMBED_BACKFILL_BATCH_OPTS));
    if (l.embedBackfillDelayMs != null) setBackfillDelayMs(normalizeEmbedBackfillDelayMs(l.embedBackfillDelayMs, EMBED_BACKFILL_DELAY_OPTS));
  }, [sections]);

  React.useEffect(() => {
    const m = sections.memory;
    if (m && typeof m === 'object' && typeof m.semanticRerank === 'boolean') {
      setMemorySemanticDefault(m.semanticRerank);
    }
  }, [sections]);

  return (
    <Pane
      title="Model & API"
      jp="モデル"
      subtitle="OpenAI-compatible chat/completions and /v1/embeddings (Memory semantic search). Endpoint and models are saved locally; the API key stays in the macOS Keychain."
    >
      <div className="s-card" style={{ padding: 20, marginBottom: 16 }}>
        <Field label="Base URL" hint="HTTPS only (localhost HTTP is accepted for local gateways). If the path has no /v1, it is appended automatically.">
          <input
            className="s-input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            autoComplete="off"
          />
        </Field>
        <Field label="Chat model" hint="Passed as the model field in chat/completions requests.">
          <input
            className="s-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Embedding model"
          hint="Used for /v1/embeddings (Memory ingest + semantic re-rank). Same API key and base URL."
        >
          <input
            className="s-input"
            value={embeddingModel}
            onChange={(e) => setEmbeddingModel(e.target.value)}
            placeholder="text-embedding-3-small"
            autoComplete="off"
          />
        </Field>
        <Field label="Max output tokens" hint="Upper bound for completion tokens (default in app: 2048).">
          <input
            className="s-input"
            type="number"
            min={1}
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            placeholder="2048"
          />
        </Field>
        <div className="row" style={{ marginTop: 4 }}>
          <span className="s-field-hint">Saved to settings JSON (not the secret).</span>
          <span className="spacer" />
          <button
            className="btn btn-sm btn-secondary"
            type="button"
            onClick={async () => {
              const mt = parseInt(String(maxTokens).trim(), 10);
              if (!Number.isFinite(mt) || mt < 1) {
                toast('Max output tokens must be a positive number', 'error');
                return;
              }
              const r = await run(
                'settings.save',
                {
                  section: 'llm',
                  baseUrl: baseUrl.trim(),
                  model: model.trim(),
                  embeddingModel: embeddingModel.trim() || 'text-embedding-3-small',
                  maxTokens: mt,
                  embedBackfillBatch: backfillLimit,
                  embedBackfillDelayMs: backfillDelayMs,
                },
                { successMessage: 'LLM endpoint settings saved' },
              );
              if (r.ok && refreshSections) await refreshSections();
            }}
          >
            Save endpoint
          </button>
        </div>
      </div>

      <div className="s-card" style={{ padding: 20 }}>
        <Field
          label="API key"
          hint="Stored in the login keychain (service ai.shogun.desktop). Never written to settings files."
        >
          <input
            className="s-input"
            type="password"
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            placeholder={keyConfigured ? '•••••••• (replace by typing a new key)' : 'sk-…'}
            autoComplete="off"
          />
          {keyConfigured && keyProvider && (
            <div className="s-field-hint" style={{ marginTop: 6, fontSize: 11 }}>
              Provider: {
                keyProvider === 'openai' ? 'OpenAI' :
                keyProvider === 'anthropic' ? 'Anthropic (Claude)' :
                keyProvider === 'gemini' ? 'Google Gemini' :
                'Custom / Local'
              }{keyPreview ? ` — ${keyPreview}` : ''}
            </div>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <span className="s-field-hint" style={{ marginTop: 0 }}>
              Keychain: {keyConfigured ? 'configured' : 'not set'}
            </span>
            <span className="spacer" />
            <button
              className="btn btn-sm btn-ghost"
              type="button"
              disabled={!keyConfigured}
              onClick={async () => {
                const r = await run('llm.clear_api_key', {}, { successMessage: 'API key removed from Keychain' });
                if (r.ok) {
                  setApiKeyDraft('');
                  await refreshKeyStatus();
                }
              }}
            >
              Remove
            </button>
            <button
              className="btn btn-sm btn-secondary"
              type="button"
              onClick={async () => {
                const k = apiKeyDraft.trim();
                if (!k) {
                  toast('Enter an API key to save', 'error');
                  return;
                }
                const r = await run('llm.save_api_key', { apiKey: k }, { successMessage: 'API key saved to Keychain' });
                if (r.ok) {
                  setApiKeyDraft('');
                  await refreshKeyStatus();
                }
              }}
            >
              Save key
            </button>
          </div>
        </Field>
      </div>

      <div className="s-card" style={{ padding: 20 }}>
        <Field
          label="Memory embeddings"
          hint="Writes missing vectors for indexed memories (skips capture_sampler / capture_ax noise). Uses /v1/embeddings and your key. Large batches can take a while; add a pause between rows if the API rate-limits. Batch and pause are saved to settings when you change them (and with Save endpoint). Transient API errors retry with exponential backoff; only the first error message is kept for the summary toast."
        >
          <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
              <span>Batch</span>
              <select
                className="s-select"
                style={{ minWidth: 72 }}
                value={String(backfillLimit)}
                disabled={backfillBusy}
                onChange={async (e) => {
                  const n = normalizeEmbedBackfillBatch(e.target.value, EMBED_BACKFILL_BATCH_OPTS);
                  setBackfillLimit(n);
                  await persistEmbedBackfillPrefs({ embedBackfillBatch: n });
                }}
              >
                {EMBED_BACKFILL_BATCH_OPTS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
              <span>Pause</span>
              <select
                className="s-select"
                style={{ minWidth: 88 }}
                value={String(backfillDelayMs)}
                disabled={backfillBusy}
                onChange={async (e) => {
                  const ms = normalizeEmbedBackfillDelayMs(e.target.value, EMBED_BACKFILL_DELAY_OPTS);
                  setBackfillDelayMs(ms);
                  await persistEmbedBackfillPrefs({ embedBackfillDelayMs: ms });
                }}
              >
                <option value={0}>Off</option>
                <option value={250}>250 ms</option>
                <option value={500}>500 ms</option>
                <option value={1000}>1 s</option>
              </select>
            </label>
            {backfillBusy ? (
              <span className="t-mono" style={{ fontSize: 11, color: 'var(--gold)' }}>
                {backfillProgress
                  ? `${backfillProgress.index} / ${backfillProgress.total}`
                  : `0 / ${backfillLimit}`}
              </span>
            ) : null}
            {backfillBusy ? (
              <button
                className="btn btn-sm btn-ghost"
                type="button"
                onClick={() =>
                  void run('memory.embed_backfill_cancel', {}, { silentError: true })
                }
              >
                Cancel
              </button>
            ) : null}
          </div>
          <button
            className="btn btn-sm btn-secondary"
            type="button"
            disabled={!keyConfigured || backfillBusy}
            onClick={async () => {
              setBackfillBusy(true);
              setBackfillProgress({ index: 0, total: backfillLimit });
              try {
                const r = await run(
                  'memory.embed_backfill',
                  { limit: backfillLimit, delayMs: backfillDelayMs },
                  { silentError: true },
                );
                if (!r.ok) {
                  toast(r.error?.message || 'Backfill failed', 'error');
                  return;
                }
                const cancelled = r.data && r.data.cancelled === true;
                if (cancelled) {
                  toast('Backfill cancelled', 'info');
                  return;
                }
                const em = r.data && typeof r.data.embedded === 'number' ? r.data.embedded : 0;
                const fl = r.data && typeof r.data.failed === 'number' ? r.data.failed : 0;
                const rem = r.data && typeof r.data.remaining === 'number' ? r.data.remaining : null;
                const fe = r.data && typeof r.data.firstError === 'string' ? r.data.firstError : '';
                let msg = `Embedded ${em} · failed ${fl}`;
                if (rem != null && rem > 0) msg += ` · ~${rem} still missing`;
                toast(msg, fl ? 'warn' : 'success');
                if (fl > 0 && fe) toast(fe.length > 200 ? `${fe.slice(0, 200)}…` : fe, 'warn');
              } finally {
                setBackfillBusy(false);
                setBackfillProgress(null);
              }
            }}
          >
            Backfill missing vectors
          </button>
        </Field>
      </div>

      <div className="s-card" style={{ padding: 20, marginTop: 16 }}>
        <Row
          title="Memory: semantic search default"
          desc="When enabled, Memory searches that include query text ask the embeddings API once per search to re-rank lexical hits (same setting as the checkbox on the Memory timeline). Stored under settings → memory."
          last
        >
          <Toggle
            on={memorySemanticDefault}
            onClick={() => {
              const next = !memorySemanticDefault;
              setMemorySemanticDefault(next);
              void run(
                'settings.save',
                { section: 'memory', semanticRerank: next },
                { successMessage: 'Memory search preference saved' },
              );
            }}
          />
        </Row>
      </div>
    </Pane>
  );
}
