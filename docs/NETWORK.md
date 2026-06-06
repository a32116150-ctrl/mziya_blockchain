# Mziya P2P Networking

> File: `network/peer.js`

---

## Architecture

Mziya uses **libp2p** (`v1.9.x`) as its networking stack. Every node is a first-class peer — there is no client/server distinction. The network has **no hardcoded bootstrap servers**; peers discover each other organically via:

| Discovery Method | Scope | Mechanism |
|-----------------|-------|-----------|
| mDNS | Local WiFi | `@libp2p/mdns`, service name `mziya-p2p` |
| Kademlia DHT | Global (routed) | `@libp2p/kad-dht`, protocol `/mziya/kad/1.0.0` |
| PEX (Peer Exchange) | GossipSub | Periodic address announcements on `mziya/pex/v1` |

### Dual-Mode Transport

| Environment | Transports | Listens on |
|-------------|-----------|------------|
| **Browser** (mobile/desktop PWA) | WebRTC + WebSockets (client) + Circuit Relay | Nothing (outbound only) |
| **Node.js** (Linux/RPi/desktop) | WebSockets (server) + Circuit Relay | `/ip4/0.0.0.0/tcp/0/ws` |

---

## Node Factory (`createMziyaNode`)

```js
async function createMziyaNode(options = {}) {
  const isBrowser = typeof window !== 'undefined';

  // Transports
  const transports = [];
  if (isBrowser) {
    transports.push(webRTC({
      rtcConfiguration: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      },
    }));
  }
  transports.push(webSockets());
  transports.push(circuitRelayTransport());

  // Discovery
  const discovery = [mdns({ serviceName: 'mziya-p2p', interval: 5000 })];

  // Services
  const services = {
    identify: identify(),
    dht: kadDHT({ protocol: '/mziya/kad/1.0.0', clientMode: isBrowser }),
    pubsub: gossipsub({ /* ... */ }),
  };

  // Node.js listens on WebSockets
  const addresses = {};
  if (!isBrowser) addresses.listen = ['/ip4/0.0.0.0/tcp/0/ws'];

  return createLibp2p({
    addresses, transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: discovery,
    services,
  });
}
```

### STUN Configuration

Browser nodes use Google's public STUN servers for WebRTC NAT traversal:
- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`

No TURN server is required — WebRTC typically works behind NAT with STUN alone for peer-to-peer connections on the same network or with symmetric NAT hole-punching.

---

## MziyaP2P Class

```js
class MziyaP2P {
  node: libp2p              // The underlying libp2p instance
  blockchain: Blockchain    // Reference to chain for sync & block handling
  mempool: Mempool          // Reference to mempool for tx handling
  peers: Set<peerId>        // Currently connected peers
  isRunning: Boolean
}
```

### Topics (GossipSub)

| Topic | Prefix | Payload |
|-------|--------|---------|
| `mziya/tx/v1` | `TOPICS.TRANSACTION` | `Transaction.toJSON()` |
| `mziya/block/v1` | `TOPICS.BLOCK` | `Block.toJSON()` |
| `mziya/mining/v1` | `TOPICS.MINING` | `{ address, sessionId, timestamp, rate }` |
| `mziya/consensus/v1` | `TOPICS.CONSENSUS` | `Vote.toJSON()` |
| `mziya/sync/v1` | `TOPICS.SYNC` | Sync request/response |
| `mziya/pex/v1` | `TOPICS.PEX` | `{ peerId, addrs, timestamp }` |

### Lifecycle

```
start(options)
  ├─ createMziyaNode()          → underlying libp2p node
  ├─ Register peer:connect / peer:disconnect listeners
  ├─ Subscribe to all 6 GossipSub topics
  ├─ Add message handler (routes by topic)
  ├─ node.start()
  ├─ _startPEX()                → announce addresses every 5 minutes
  └─ Return { peerId, multiaddrs }

stop()
  ├─ Clear PEX timer
  ├─ Clear discovery timeout
  └─ node.stop()
```

### Security

| Protection | Mechanism |
|------------|-----------|
| Connection encryption | Noise protocol (mandatory for all peers) |
| Stream multiplexing | Yamux (multiple streams per connection) |
| Per-peer rate limiting | Sliding window: 20 msg/s max per peer |
| Message size limit | 1 MB max per GossipSub message |
| Pending blocks cap | 100 blocks max with 5-minute TTL |
| Vote signing | Ed25519 via optional `signer` callback |
| Peer identity | Ed25519 libp2p PeerId |

### Rate Limiting

Every incoming message is checked against a per-peer sliding window:

```
_checkRateLimit(peerId):
  now = Date.now()
  bucket = _rateBuckets[peerId]
  remove timestamps older than now - 1000ms
  if bucket.length >= 20: drop message
  else: add now to bucket, process message
```

Rate buckets are never garbage collected but remain bounded by active peer count.

### Pending Blocks

Non-finalized blocks received via GossipSub are stored with:

```
MAX_PENDING_BLOCKS = 100    // Hard cap (evict oldest if exceeded)
PENDING_BLOCK_TTL  = 300s   // Discard blocks older than 5 minutes
```

### Message Routing

All incoming GossipSub messages are parsed, size-checked, rate-limited, and routed by topic:

```
_handleMessage(message)
  ├─ TOPICS.TRANSACTION → _handleIncomingTransaction
  │    ├─ Transaction.fromJSON()
  │    ├─ mempool.add(tx)
  │    └─ onTransaction callback
  ├─ TOPICS.BLOCK → _handleIncomingBlock
  │    ├─ Block.fromJSON()
  │    ├─ If consensus engine exists:
  │    │    ├─ If finalized: addBlock directly
  │    │    └─ Else: push to pendingBlocks, broadcast Vote if validator
  │    └─ Else: addBlock directly
  ├─ TOPICS.SYNC → _handleSyncMessage
  │    ├─ SYNC_REQUEST: if we have a longer chain, respond with blocks
  │    └─ SYNC_RESPONSE: if incoming chain is longer, mergeBlocks()
  ├─ TOPICS.CONSENSUS → _handleVote
  │    ├─ Forward to blockchain.receiveVote()
  │    └─ If finalized: move from pendingBlocks to chain
  ├─ TOPICS.MINING → _handleMiningActivity
  │    └─ Forward to 'activity' handler
  └─ TOPICS.PEX → _handlePEXMessage
       └─ Forward to 'pex' handler
```

### Consensus Voting

When a validator node receives a new block, it casts an Ed25519-signed vote:

```
_handleIncomingBlock(block):
  if consensus engine exists:
    if not finalized:
      add to pendingBlocks (with cap + TTL)
      if signer exists AND validatorSet.isValidator(signer.address):
        votePayload = { blockHash, validatorAddress: signer.address, timestamp }
        signature = signer.sign(votePayload)
        broadcastVote(new Vote({ ...votePayload, signature }))
```

The `signer` is an optional object passed to `MziyaP2P` constructor:
```js
{ address: 'MZ4a...', sign: (payload) => ed25519_hex_signature }
```

Browser nodes (light clients) do not configure a signer and never vote. Only Node.js validators with access to the private key participate in consensus.

### PEX (Peer Exchange)

Every 5 minutes (and 2 seconds after startup), each peer publishes its known multiaddrs to the `mziya/pex/v1` topic:

```js
_announceAddresses():
  if peers.size === 0: return
  publish({ peerId, addrs: getMultiaddrs(), timestamp })
```

This allows peers to discover each other's reachable addresses even without DHT or mDNS.

### Chain Sync

On first connection, the node requests sync:

```js
requestChainSync(fromHeight = 0, count = 100):
  publish({
    type: 'SYNC_REQUEST',
    ourHeight, ourLatestHash,
    fromHeight, count, timestamp
  })
```

Peers with a longer chain respond with `SYNC_RESPONSE` containing the requested block range. The receiving node calls `blockchain.mergeBlocks()` to replace its chain if the incoming one is longer and valid.

---

## Bootstrap Node (Optional)

> File: `bootstrap-node/index.js`

An optional Node.js process that provides a WebSocket listening endpoint and circuit relay server:

```
node bootstrap-node/index.js
```

| Feature | Details |
|---------|---------|
| WebSocket listener | `/ip4/{HOST}/tcp/{PORT}/ws` (default `0.0.0.0:4001`) |
| Circuit relay | Up to 1000 reservations, 5-minute cleanup interval |
| DHT server | Full DHT server mode (not client) |
| Security | Noise encryption + Yamux multiplexing |
| Health check | HTTP server on port 8080 (exposes `/health` JSON endpoint) |

This node has **zero special power** — it only helps new peers find the network. Anyone can run one. Setting `BOOTSTRAP_PEERS` env var makes it discoverable:

```sh
BOOTSTRAP_PEERS="/dns4/my-node.example.com/tcp/443/wss/p2p/12D3KooW...PeerId" npm run dev
```

---

## Security

- All connections are encrypted with **Noise** protocol (`@chainsafe/libp2p-noise`)
- Streams are multiplexed with **Yamux** (`@chainsafe/libp2p-yamux`)
- Each libp2p peer has a unique **PeerId** (Ed25519 keypair)
- Messages are authenticated via Ed25519 signatures at the application layer
- No central server or bootstrap node has any authority
