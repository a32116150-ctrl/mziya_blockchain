# Mziya Deployment Guide

---

## Build

```sh
npm run build
```

Runs `vite build web` — outputs to `web/dist/`. The build produces:

```
web/dist/
├── index.html
├── assets/
│   ├── index-[hash].js
│   ├── index-[hash].css
│   └── ...other chunks
├── manifest.json
└── sw.js
```

Vite handles:
- ES module bundling with code splitting
- CSS extraction from inline `<style>` blocks
- Asset hashing for cache busting
- `manifest.json` and `sw.js` are copied as-is (in `public/`)

---

## Deploy to Web

### Option 1: Static Host (Netlify / Vercel / Cloudflare Pages)

```sh
npm run build
npx netlify deploy --prod --dir web/dist
```

**Note**: The service worker (`sw.js`) must be served from the root (`/`), and the `manifest.json` must be at `/manifest.json`. Both are in `web/` and will be at the root of the deploy output.

Set these headers to ensure PWA works:

```apache
# _headers (Netlify) or custom headers in Cloudflare
/sw.js
  Service-Worker-Allowed: /
  Cache-Control: no-cache

/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

### Option 2: GitHub Pages

```sh
npm run build
npx gh-pages -d web/dist
```

**Important**: The app uses a service worker with `scope: '/'` — deploy to a custom domain, not `username.github.io/repo` (service worker scope issues).

### Option 3: Nginx / Apache Self-Host

```sh
npm run build
cp -r web/dist/* /var/www/mziya/
```

Minimal nginx config:

```nginx
server {
  listen 443 ssl;
  server_name mziya.example.com;
  root /var/www/mziya;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }

  location /sw.js {
    add_header Service-Worker-Allowed /;
    add_header Cache-Control no-cache;
  }
}
```

---

## Desktop App (macOS/Windows/Linux)

### Using PWA Builder

```sh
npx @pwabuilder/cli -w web/dist -l -p mziya
```

This generates platform-specific wrappers. Or use the **PWABuilder** website: upload `web/dist` → download packages.

### Manual Electron Wrapper

```sh
npm install --save-dev electron
```

Create `electron.js`:

```js
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 400, height: 700 });
  win.loadFile('web/dist/index.html');
});
```

---

## Bootstrap Node Hosting

The bootstrap node is a lightweight WebSocket relay + DHT server that helps peers discover each other. It has no special authority.

**Perpetually free options:**
- **Oracle Cloud Always Free** — 2 AMD micro instances, 1GB RAM, public IP. Best option. Needs credit card for signup (never charged).
- **Self-host** — Raspberry Pi / old laptop at home with tailscale funnel or dynamic DNS.
- **Cheap VPS** — RackNerd ~$15/yr.

> Note: Fly.io was tested but its trial expires after 7 days — not perpetually free. The `fly.toml` and `Dockerfile` remain in the repo for reference.

## Bootstrap Node (Headless Linux / Raspberry Pi)

**Requires Node.js v22+** (libp2p's `it-queue` uses `Promise.withResolvers`).

```sh
npm run bootstrap
```

This runs `node bootstrap-node/index.js`, which starts an libp2p node with:

| Feature | Detail |
|---------|--------|
| WebSocket listener | `/ip4/0.0.0.0/tcp/{PORT}/ws` |
| Circuit relay | Up to 1000 reservations |
| DHT server | Full routing table |
| mDNS | Local peer discovery |

### Run as systemd Service

Create `/etc/systemd/system/mziya-bootstrap.service`:

```ini
[Unit]
Description=Mziya Bootstrap Node
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/mziya
ExecStart=/usr/bin/node bootstrap-node/index.js
Restart=always
Environment="BOOTSTRAP_PEERS=/dns4/my-node.example.com/tcp/443/wss/p2p/PEER_ID"

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now mziya-bootstrap
```

The bootstrap node will log its PeerId and multiaddrs. Share these with other users so they can set `BOOTSTRAP_PEERS`.

---

## Command-Line Miner Node (Headless Linux / VPS)

You can run a full Mziya miner node directly in the terminal without a browser window. Since the core ledger (`core/`) and P2P networking (`network/`) are built as isomorphic JavaScript modules, they run natively in Node.js.

We have provided a `cli-miner.js` script in the root directory.

### How to Run:

1. **Prerequisites**: Ensure you have Node.js version >= 20.0.0 installed.
2. **Execute Script**:
   ```sh
   node cli-miner.js
   ```

### Wallet Menu:
- **Create new wallet** — generates a fresh Ed25519 keypair with BIP39 12-word mnemonic
- **Import from seed phrase** — restores a wallet from a 12-word mnemonic phrase
- **Import from private key** — restores a wallet from a raw Ed25519 private key hex
- **Auto-detect existing** — on subsequent runs, the CLI detects `wallet.json` and offers to reuse it or switch

### Node Features:
- **State Persistence**: Persists blockchain blocks dynamically into `blockchain-state.json` and session state into `mining-sessions.json` so you do not lose progress.
- **P2P Synced**: Connects to GossipSub P2P network, automatically registers/discovers local peers (mDNS) and WAN peers (via `BOOTSTRAP_PEERS`), and performs blockchain synchronization.
- **Autonomous Mining Loop**: Starts a 24h cycle, prints live progress updates in the terminal, claims rewards automatically once complete, and restarts the next cycle.
- **Live Status Bar**: Real-time display of mining rate, MZY earned, wallet balance, peers, chain height, and session countdown.

---

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `BOOTSTRAP_PEERS` | Comma-separated multiaddrs of known bootstrap peers | empty |
| `HOST` | WebSocket listen address (Node.js only) | `0.0.0.0` |
| `PORT` | WebSocket listen port (Node.js only) | `0` (random) |

Example:

```sh
BOOTSTRAP_PEERS="/dns4/node1.example.com/tcp/443/wss/p2p/12D3...PeerId1,/dns4/node2.example.com/tcp/443/wss/p2p/12D3...PeerId2" npm run dev
```

---

## Production Checklist

- [ ] HTTPS enabled (required for WebRTC in browsers)
- [ ] Service worker registered and caching assets
- [ ] `manifest.json` served with correct icons and `start_url`
- [ ] At least 1 bootstrap node online (or use mDNS on LAN)
- [ ] TURN server configured for restrictive NATs
- [ ] RPC/API endpoints secured if exposed publicly
- [ ] Regular backups of wallet mnemonics (user responsibility)
- [ ] `vite build` passes with no warnings

---

## Troubleshooting

### WebRTC doesn't connect

Check browser console for ICE errors. Try:
1. Both peers on same WiFi (mDNS should work)
2. Set `BOOTSTRAP_PEERS` to a known public node
3. Open port 4001 (or your WS port) on the bootstrap node's firewall

### Build fails

```sh
npx vite build web --debug
```

Most common issues:
- Missing dependency: `npm install`
- Import aliases: Vite resolves `@/` to `src/` — check vite.config.js
- Node.js modules in browser code: ensure `peer.js` guards Node-only imports with `isBrowser` checks

### Service worker not activating

1. Open DevTools → Application → Service Workers
2. Check the scope is `/` (not `/subpath/`)
3. Click "Update on reload" to bypass waiting

### Memory/performance

- The AI model trains on CPU via WebGL (TF.js backend). On low-end phones, training may take 30–60 seconds.
- The chain is stored entirely in memory + localStorage. For long-running nodes, implement pruning (keep only last N blocks).
