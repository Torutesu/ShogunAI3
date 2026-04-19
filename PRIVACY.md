# SHOGUN AI (desktop v1) — privacy summary

Last updated: 2026-04-19. This is a project summary, not legal advice.

## Terms of use

- **Japanese:** [Terms of Service (beta)](docs/TERMS_OF_SERVICE.md)
- **English:** [Terms of Service (beta, English)](docs/TERMS_OF_SERVICE_EN.md)

## Where data lives

- **Application data**: JSON files under the OS application data directory (resolved via the Rust `directories` crate), including the memory index, app settings, and optional diagnostic reports.
- **LLM API key (macOS)**: Stored in the login **Keychain** (service `ai.shogun.desktop`). Keys are not written into settings JSON.

## Network

- **LLM**: HTTPS requests are made from Rust to the user-configured OpenAI-compatible endpoint for chat and Morning Brief generation. Payloads may include user text and snippets loaded from local memory.
- **Third-party integrations**: v1 does not perform live OAuth or production connections to external providers; related UI is a preview.
- **Clerk** (if enabled): Sign-in and account UI may be provided by **Clerk**; Clerk’s privacy policy applies to data processed by Clerk. See the Terms of Service section on Clerk.

## On-device processing

Memory search/ingest/delete, settings read/write, and destructive data deletion complete on the user's machine.

## Contact

- **Licensed customers:** use the **support email or URL provided with your purchase** (not a public source-code repository).
