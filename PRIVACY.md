# SHOGUN AI (desktop) — privacy summary

Last updated: 2026-07-15. This is a project summary, not legal advice.

## Terms of use

- **Japanese:** [Terms of Service (beta)](docs/TERMS_OF_SERVICE.md)
- **English:** [Terms of Service (beta, English)](docs/TERMS_OF_SERVICE_EN.md)

## Where data lives

- **Application data**: JSON files under the OS application data directory (resolved via the Rust `directories` crate), including the memory index, app settings, and optional diagnostic reports.
- **LLM API key (macOS)**: Stored in the login **Keychain** (service `ai.shogun.desktop`). Keys are not written into settings JSON.

## Network

All outbound traffic below is HTTPS. Except where noted as opt-in, the app makes
no network request until a feature that needs one is used.

- **Optional usage statistics (opt-in at the consent screen, uncheckable
  anytime)**: If enabled, the app reports **aggregate usage only** — app opens
  and which screens were visited — under an anonymous random device id. The
  event vocabulary is a hard allowlist in code
  (`src/shared/lib/product-telemetry.ts`); captured screen text, memory
  content, titles, queries, and file paths have **no code path** into it. No
  autocapture, no session recording, no email or account id. Builds without an
  analytics key send nothing regardless of the toggle. There is no
  crash-reporting SDK.

- **LLM (BYOK)**: Requests go from Rust to the LLM provider you configure
  (OpenAI-, Anthropic-, or Gemini-compatible). Hosts are restricted to an
  allowlist (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`,
  plus `localhost` and any host you add). Used for chat, Morning Brief, drafting,
  and KIOKU memory extraction/summarization. **Payloads may include your text and
  snippets from local memory, and — when memory extraction is enabled — captured
  on-screen text.** Your API key is your own.
- **Embeddings (BYOK)**: Memory item text is sent to your configured
  OpenAI-compatible `/v1/embeddings` endpoint to build the local search index.
- **Meeting transcription (Deepgram)**: If you use meeting capture, meeting/system
  **audio is sent to Deepgram** (`api.deepgram.com`) for speech-to-text using your
  Deepgram key. Audio leaves your machine for this feature.
- **Integrations (read-only)**: When you connect a provider, the app performs
  OAuth and reads your data into local memory. Providers include Gmail, Google
  Calendar, Google Drive, Slack, Notion, GitHub, Linear, Zoom, Outlook, and Figma.
  Scopes are read-only. Some providers shown in the UI are previews and not yet
  wired to live connections.
- **Cloud Memory Mirror (opt-in, off by default)**: If enabled, memory items are
  **end-to-end encrypted on-device** (XChaCha20-Poly1305 with a key derived from
  your passphrase; the server never sees your content or embeddings) and synced to
  the mirror server URL you configure. **Metadata sent in the clear** for sync
  bookkeeping: item kind, provenance, and a minute-precision timestamp.
- **Billing / account (Clerk)**: If billing is enabled for your build, the app
  asks the web service for your entitlement status using a Clerk session token;
  sign-in and account UI are provided by Clerk. Clerk's and the payment
  processor's privacy policies apply to data they process.
- **App updates**: If configured, the updater checks the release endpoint baked
  into the build.

## On-device processing

Memory search/ingest/delete, settings read/write, capture filtering (secure
fields, excluded apps/sites, payment/incognito/time-block rules), and destructive
data deletion complete on your machine. Captured screen text and window titles are
**accessibility text only — no screenshots or screen-pixel capture**.

## Secrets storage

LLM, OAuth/connector, Clerk, Deepgram, and Cloud Mirror keys are stored in the
macOS **Keychain**. A settings backup export never contains these keys.

## Contact

- **Licensed customers:** use the **support email or URL provided with your purchase** (not a public source-code repository).
