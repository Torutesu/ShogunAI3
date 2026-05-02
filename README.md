<p align="center">
  <img src="hifi/assets/mark.svg" alt="SHOGUN AI" width="96" />
</p>

<h1 align="center">SHOGUN AI</h1>

<p align="center"><em>Capture, recall, and act on your work — privately, on your Mac.</em></p>

<p align="center">
  <img src="screenshots/user-menu.png" alt="SHOGUN AI — Home view" width="900" />
  <br />
  <sub><em>Demo data; names are fictional.</em></sub>
</p>

## What it does

- **Local-first memory graph (KIOKU)** — Notes, meetings, chats, and integrations are unified into a structured memory layer that lives on your machine.
- **Morning Brief** — Each day starts with a synthesized recap of what happened across your tools, with the open threads surfaced.
- **MCP-native** — Connects to Model Context Protocol servers so your memory is reachable from any MCP-aware client (Claude Desktop, etc.).
- **Hardened by default** — API keys live in the macOS Keychain, builds are signed and notarized. Telemetry, when enabled, is documented in [PRIVACY.md](PRIVACY.md).

## How it works

SHOGUN AI is a Tauri v2 application: a Rust native layer with a React-based Hi-Fi UI in a system WebView. All memory data is stored locally under the macOS application support directory. The only outbound network calls are to the LLM API (configured by the user) and to integrations the user has explicitly enabled (Gmail, Google Calendar, Linear, etc.).

The product is built around **KIOKU**, a multi-layer memory graph that normalizes notes, meeting transcripts, chats, and integration data into a shared schema. The Morning Brief pipeline (`hifi/amc-pipeline/`) walks that graph daily to produce a recap of the previous day and surface unresolved threads. Builds that enable Clerk include sign-in handled by Clerk; see [PRIVACY.md](PRIVACY.md) for details.

## Status

**Private beta.** SHOGUN AI is not generally available. Sales and support contacts are provided directly with each customer engagement; this repository is not a distribution or support channel. Subscription, referral, and billing UI shown in the application are previews and are not connected to a live payment processor (see [Terms of Service](docs/TERMS_OF_SERVICE_EN.md) §I).

## For licensed customers

If you have received a build, see **[End-user setup (Japanese)](docs/END_USER_SETUP.md)** for first-run instructions, API key configuration, and known limitations. The privacy summary is in **[PRIVACY.md](PRIVACY.md)**.

## For developers

Detailed guides live in the `docs/` and `hifi/` trees:

- UI / IPC / actions: [`hifi/README.md`](hifi/README.md), [`hifi/action-map.md`](hifi/action-map.md)
- Morning Brief pipeline: [`hifi/amc-pipeline/README.md`](hifi/amc-pipeline/README.md)
- macOS distribution, signing, notarization: [`docs/macos-release.md`](docs/macos-release.md)
- KIOKU memory architecture: [`docs/memory-architecture/target-design.md`](docs/memory-architecture/target-design.md)
- MCP / Claude Desktop integration: [`docs/mcp-claude-desktop-setup.md`](docs/mcp-claude-desktop-setup.md)

### Common commands (repository root)

```bash
npm ci
npm run check:actions
npm run check:ipc-mock
npm run check:rust
npm run build:web-dist
npm run test:e2e
npm run build:desktop
```

## License & Privacy

The source code and binaries are **proprietary**; redistribution, modification, and reverse engineering are restricted to what is granted in the [LICENSE](LICENSE) file or a separately negotiated agreement. Third-party libraries are governed by their respective licenses.

See **[PRIVACY.md](PRIVACY.md)** for what data is stored locally and which network calls are made, and the **[Terms of Service](docs/TERMS_OF_SERVICE_EN.md)** for product terms.
