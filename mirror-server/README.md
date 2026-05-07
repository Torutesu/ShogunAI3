# SHOGUN Mirror Server

Self-hostable encrypted blob sync server for [SHOGUN AI](../).
Implements the Memory Mirror protocol (RFC Phase 2.1.1) — stores and serves
XChaCha20-Poly1305 encrypted blobs that only the client can decrypt.

## Quick-start

### 1. Build

```bash
cd mirror-server
cargo build --release
# Binary at: target/release/shogun-mirror-server
```

Or install globally:

```bash
cargo install --path mirror-server
```

### 2. Configure

```bash
cp mirror-server/mirror-server.example.toml mirror-server/mirror-server.toml
# Edit: registration_code, data_dir, optional TLS paths
```

Minimal config to get started:

```toml
[auth]
registration_code = "my-secret"

[storage]
data_dir = "/var/lib/shogun-mirror"
```

All settings can also be provided via environment variables with the prefix
`SHOGUN_MIRROR__` (double-underscore separator), e.g.:

```bash
export SHOGUN_MIRROR__AUTH__REGISTRATION_CODE=my-secret
export SHOGUN_MIRROR__STORAGE__DATA_DIR=/var/lib/shogun-mirror
```

### 3. Run

```bash
# Dev mode (listens on 127.0.0.1:8443):
./target/release/shogun-mirror-server

# Or with systemd:
# See: https://wiki.archlinux.org/title/systemd#Writing_unit_files
```

Verify it's running:

```bash
curl http://127.0.0.1:8443/v1/health
# {"ok":true,"version":"0.1.0","uptime_seconds":5}
```

### 4. Connect the Mac client

In SHOGUN AI on macOS:

1. Open `Settings → Cloud Mirror`
2. Set **Mirror server URL** to `https://your-server:8443` (or `http://127.0.0.1:8443` for local dev)
3. Enter the **registration code** from your config
4. Click **Enable Mirror** — the client registers and starts syncing

## Production setup (reverse proxy)

For production, put nginx/Caddy/Cloudflare in front and let them handle TLS:

```nginx
server {
    listen 443 ssl;
    server_name mirror.example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8443;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Then set `listen_addr = "127.0.0.1:8443"` in your config (private listen only).

## Direct TLS (LAN / homelab)

Set the `[tls]` section in `mirror-server.toml` to enable rustls direct mode:

```toml
[tls]
cert_path = "/path/to/cert.pem"
key_path  = "/path/to/key.pem"
```

## Monitoring

The Prometheus metrics endpoint is at `127.0.0.1:9090/metrics` (no auth; keep
it private/internal):

```bash
curl http://127.0.0.1:9090/metrics
```

Counters exposed:
- `shogun_mirror_blobs_uploaded_total`
- `shogun_mirror_blobs_fetched_total`
- `shogun_mirror_tombstones_total`
- `shogun_mirror_rate_limited_total`

## Architecture

The server is **dumb encrypted-blob storage** — it never decrypts user data.
All decryption happens on the Mac client using keys that never leave Apple Keychain.

- Protocol: [RFC Phase 2.1.1](../docs/superpowers/specs/2026-05-07-mirror-protocol-rfc.md)
- Design: [Phase 2.1.3 spec](../docs/superpowers/specs/2026-05-07-mirror-server-reference-design.md)
