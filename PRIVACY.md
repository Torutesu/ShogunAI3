# SHOGUN AI (desktop v1) — privacy summary

Last updated: 2026-04-18. This is a project summary, not legal advice.

## Where data lives

- **Application data**: JSON files under the OS application data directory (resolved via the Rust `directories` crate), including the memory index, app settings, and optional diagnostic reports.
- **LLM API key (macOS)**: Stored in the login **Keychain** (service `ai.shogun.desktop`). Keys are not written into settings JSON.

## Network

- **LLM**: HTTPS requests are made from Rust to the user-configured OpenAI-compatible endpoint for chat and Morning Brief generation. Payloads may include user text and snippets loaded from local memory.
- **Third-party integrations**: v1 does not perform live OAuth or production connections to external providers; related UI is a preview.

## On-device processing

Memory search/ingest/delete, settings read/write, and destructive data deletion complete on the user's machine.

## Contact

Add a public contact channel here when available.
