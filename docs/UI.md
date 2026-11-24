# Mziya UI Architecture

> File: `web/index.html` · `web/css/theme.css` · `web/js/vendor.js` · `web/js/app.js` · `web/js/wallet.js` · `web/js/mining.js`

---

## Stack

- **Build**: Vite (ES modules, HMR, static build to `web/dist/`)
- **Runtime**: Vanilla JS (no React/Vue/Svelte)
- **State**: In-memory global state (`STATE` object in app.js) + localStorage/IndexedDB for persistence
- **Styling**: "Aurora" design system in `web/css/theme.css`: dark, frosted-glass cards, violet→cyan holographic accents, animated aurora background, mining "reactor" orb with a progress ring. Fonts: Space Grotesk (display), Inter (body), JetBrains Mono (data). Legacy variable names (`--surface-*`, `--yellow`, `--gold`…) are kept as aliases.
- **Bundled assets** (`web/js/vendor.js`): Lucide icons (only the ones used), fonts and the QR-code library are installed from npm and bundled by Vite, so the PWA works offline. No CDN scripts on the main page.
- **Layout**: floating glass dock on phones; fixed sidebar from 900px wide. Copilot opens from the top-bar ✦ button on phones and a floating button on desktop.
- **PWA**: Service worker (`sw.js`), Web App Manifest (`manifest.json`), 512×512 icon

---

## Mount Points (`index.html`)

The HTML shell contains these `id` elements that JS populates:

| ID | Purpose |
|----|---------|
| `app` | Root container — all views render here |
| `modal-container` | Lock screen / confirmation modals |
| `notification-container` | Toast messages |
| `lock-screen` | Password/passkey unlock overlay |

---

## Views & Routing (`app.js`)

The SPA has these views, switched by `navigateTo(viewName)`:

| View | File | Description |
|------|------|-------------|
| `welcome` | app.js | Onboarding: Create / Import / Watch-Only wallet |
| `wallet` | wallet.js | Balance, receive, transaction history, AI DePIN panel |
| `mining` | mining.js | Session start/confirm/claim, PoI bonus, rate/progress |
| `send` | send.js | Send form with MAX button, local Ed25519 signing, P2P broadcast |
| `explorer` | explorer.js | Block list with detail view (custom event navigation refresh) |
| `settings` | app.js | Backup mnemonic, wallet delete, lock, network info |

Navigation is adaptive:
- **Mobile (<820px)**: Bottom tab bar with Wallet / Mining / Settings icons
- **Desktop (≥820px)**: Left sidebar (220px) with vertical nav items (icon beside label). Topbar stays full-width with logo. Content offset with `max-width: 1100px`.

---

## Global State (`STATE`)

```js
STATE = {
  wallet: null,           // Wallet instance from wallet.js
  blockchain: null,       // Blockchain instance
  p2p: null,              // MziyaP2P instance
  currentView: 'welcome',
  peers: Set,             // Connected peer IDs
  latestBlock: null,      // Chain tip
  totalSupply: 0,
  aiModelLoaded: false,
  modelState: {},         // Global aggregated AI weights
  poiBonusPct: 0,         // Current PoI bonus percentage
}
```

---

## Copilot Modal

The AI copilot (`#modal-copilot`) is a bottom-sheet modal with:

| Component | Description |
|-----------|-------------|
| Header | Copilot icon + title + X close button |
| Chat history | `#copilot-chat-history` — scrollable container (min 180px, max 380px) with chat bubbles |
| Suggestion chips | Pre-filled query buttons ("What is my balance?", "How does PoI work?", "Send 10 MZY to...") |
| Input row | Text input + send button, submits on Enter or click |

Chat bubbles are built with `appendChatBubble()` — bot messages on left, user messages on right, with colored icon avatars. The floating copilot button (`#btn-floating-copilot`) uses `--yellow` / `--violet` gradient with `--gold-glow` shadow.

---

## Lock Screen

The lock screen (`#lock-screen` with `z-index: 1000`) is a full-viewport overlay shown on first load and when the app regains focus after 5+ minutes of inactivity.

### Flow

```
app loads
 ├─ Check localStorage for saved wallet
 ├─ If found → show lock screen (password or passkey)
 ├─ If not found → show welcome view
```

### Unlock Methods

- **Password**: Prompted for PBKDF2-derived AES key → decrypt private key from `wallet.privateKeyEncrypted`
- **Passkey**: `navigator.credentials.get()` with WebAuthn — no password prompt
- **Watch-only**: No unlock needed — immediately redirected to wallet dashboard

---

## Wallet View (`wallet.js`)

### Components

- **Balance hero**: Large MZY balance + USD estimate (using CoinGecko mock or placeholder)
- **Send panel**: Recipient address + amount fields, sends `createTransfer()` via P2P
- **Receive panel**: QR code of the wallet address (using `qrcode.min.js` CDN)
- **Transaction history**: Scrolling list of recent transactions with type colors
- **AI DePIN panel**: Collapsible section with "Train Local AI Model" button (BONUS badge), terminal logs, global weights display

### Send Flow

```
User enters recipient + amount (or taps MAX)
  → "Send" button → unlockScreen(purpose) → prompt password
  → createTransfer({ from, to, amount, fee, nonce, privateKey })
  → app.blockchain.addPendingTransaction(tx)  — single source of truth
  → if p2p: publish to mziya/tx/v1
  → if no peers: forgeBlock() locally for demo
  → toast success
```

MAX button (`#btn-send-max`) auto-fills amount with `balance - 0.000001` fee. Uses `dispatchEvent(new Event('input'))` to trigger preview update.

---

## Mining View (`mining.js`)

### Components

- **Balance hero** (shared)
- **Mining session panel**: 
  - Tap orb (disabled, flat, and non-glowing when session is active to prevent double-clicks and show lock state)
  - Start button (when session is inactive)
  - Session stats: current rate (MZY/h), earned, progress bar, timer
- **Network strip**: Connected peers count, block height, supply
- **PoI bonus badge**: Full card with icon, label, and mono value (upgraded from tiny grey text). Shows `+X.XX% boost active` (green) or `+0.00% — tap Train to earn` (dim).
- **AI DePIN panel**: Collapsible section with:
  - "Train Local AI Model" button (24h cooldown — shows `Available in Xh Ym` when disabled)
  - Terminal-style log console (`#ai-logs`)
  - Global aggregated weights display

### AI Training Flow

```
User clicks "Train Local AI Model" → decompute.js
  → decrypt private key (password prompt)
  → dispatch job to background WebWorker (ai-worker.js)
  → WebWorker trains TF.js model on deterministically seeded dataset
  → WebWorker returns weights + accuracy
  → create AI_SUBMISSION Transaction
  → sign + mempool.add + broadcast
  → 30s delay → updatePoIBonusDisplay()
```

### AI Training Cooldown

Training is limited to once per day per device:

- Stored in `localStorage` key `mziya:lastAiTrainTime`
- Button shows countdown `Available in Xh Ym` when on cooldown
- Warning toast if clicked during cooldown
- Cooldown resets after 24 hours exactly
- `updateTrainButtonState()` runs every 5s via `refreshUI()`

### Session States

```
NO_SESSION → [Start Session] → ACTIVE (disabled & non-glowing) → EXPIRED → [Claim] → CLAIMED
```

---

## Explorer Page (`explorer.js`)

The explorer shows the latest 30 blocks with a drill-down detail view:

- **Block list**: `.block-item` cards with index `#N`, truncated hash, tx count, and relative time
- **Block detail**: `showBlockDetail(hash)` — shows index, hash, previous hash, merkle root, timestamp, miner, and full tx list with color-coded type badges (yellow=MINING, green=AI_SUBMISSION, gray=other)
- **Refresh**: On navigation via custom event `mziya:explorer-navigate`, plus every 10 seconds `setInterval`

Back button targets `#block-list-section` (the section wrapper, not `#blocks-list`).

---

## Send Page (`send.js`)

- Form fields: recipient (`MZ...`), amount, password
- MAX button fills `balance - 0.000001` fee
- Password decrypts private key in memory, signs via `createTransfer()`, adds to blockchain via `addPendingTransaction()`
- Broadcasts via P2P if connected; falls back to `forgeBlock()` for local demo
- Status messages use class `send-status success` / `send-status error`

---

## Responsive Layout

Inline `@media (min-width: 820px)` in `<style>` inside `index.html` switches to a desktop layout:

| Element | Mobile (<820px) | Desktop (≥820px) |
|---------|----------------|-------------------|
| Navigation | Bottom tab bar | Left sidebar (fixed, 220px) |
| Nav items | Icon only | Icon + label, vertically stacked |
| Topbar | Narrow header | Full-width with logo |
| Content | Full-width cards | Offset, `max-width: 1100px` |
| `.tab-bar` | `position: fixed; bottom: 0` | `display: none` |
| `.sidebar` | Hidden | `display: flex` |

The `sidebar-nav` element toggles visibility via CSS — no JS window resize listener needed.

---

## Toast/Notification System

```js
function showToast(message, type = 'info', duration = 4000)
```

Types: `info` (blue), `success` (green), `error` (red), `warning` (yellow). Toasts auto-dismiss unless `duration = 0` (manual dismiss).

---

## P2P Connection Status

The bottom tab bar shows a small indicator:
- **Gray dot** — disconnected
- **Yellow dot** — discovering (mDNS/WebRTC lookup in progress, 30s timeout)
- **Green dot** — connected to 1+ peers
- **Blue dot** — connected + syncing chain

Discovery shows a status message: *"Discovering peers via local network and WebRTC…"* with a 30-second timeout. On timeout: *"No peers found yet. Ensure you are on the same WiFi as another Mziya node."*

---

## CSS Architecture

All styles are in `<style>` within `index.html` (single-file CSS). All CSS variables are defined in `:root`.

### Defined CSS Variables

| Variable | Value | Usage |
|----------|-------|-------|
| `--primary` | `#6C5CE7` | Primary accent |
| `--bg` | `#0d0d0d` | Page background |
| `--surface` | `#1a1a2e` | Default surface |
| `--gold` | `#F0B90B` | Accent gold |
| `--gold-dim` | `rgba(240,185,11,0.12)` | Gold background |
| `--gold-glow` | `rgba(240,185,11,0.25)` | Copilot button glow |
| `--violet` | `#7C5CFC` | Accent violet |
| `--violet-dim` | `rgba(124,92,252,0.12)` | Violet background |
| `--text-primary` | `#EAECEF` | Primary text |
| `--text-secondary` | `#848E9C` | Secondary text |
| `--border-bright` | `#474D57` | Bright borders |
| `--nav-height` | `64px` | Bottom nav height |
| `--black` | `#000000` | Pure black |

### Key Classes and Components

| Category | Classes |
|----------|---------|
| Layout | `.container`, `.hero`, `.panel`, `.tab-bar`, `.sidebar` |
| Session orb | `.mining-orb`, `.mining-orb.pulsing`, `.mining-orb.idle` |
| Block explorer | `.block-item`, `.block-index`, `.block-hash`, `.block-meta`, `.detail-kv`, `.detail-k`, `.detail-v` |
| Badges | `.badge`, `.badge-yellow`, `.badge-green`, `.badge-gray` |
| Tooltip | `.tooltip` with `::before` / `::after` pseudo-elements |
| Lock screen | `#lock-screen` fixed overlay with `backdrop-filter: blur(8px)` |
| Animations | `@keyframes pulse`, `@keyframes fadeIn` |
| Toast | `.toast` positioned fixed-top-center, slide-down entrance |
