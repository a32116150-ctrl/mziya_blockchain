import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { kadDHT } from '@libp2p/kad-dht';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import http from 'http';

const PORT = process.env.PORT || 4001;
const HOST = process.env.HOST || '0.0.0.0';
const HEALTH_PORT = process.env.HEALTH_PORT || 8080;

const MZIYA_TOPICS = [
  'mziya/tx/v1',
  'mziya/block/v1',
  'mziya/mining/v1',
  'mziya/consensus/v1',
  'mziya/sync/v1',
  'mziya/pex/v1',
];

async function startBootstrapNode() {
  const node = await createLibp2p({
    addresses: {
      listen: [
        `/ip4/${HOST}/tcp/${PORT}/ws`,
      ],
    },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      dht: kadDHT({
        protocol: '/mziya/kad/1.0.0',
        clientMode: false,
      }),
      relay: circuitRelayServer({
        reservations: {
          maxReservations: 1000,
          reservationClearInterval: 300_000,
        }
      }),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        heartbeatInterval: 1_000,
      }),
    },
  });

  await node.start();

  // Subscribe to Mziya GossipSub topics to relay messages between peers
  for (const topic of MZIYA_TOPICS) {
    node.services.pubsub.subscribe(topic);
  }

  const peerId = node.peerId.toString();
  const addrs = node.getMultiaddrs().map(ma => ma.toString());

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          MZIYA BOOTSTRAP NODE — RUNNING                  ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  PeerID: ${peerId.slice(0, 52)}`);
  console.log(`║  ${peerId.length > 52 ? peerId.slice(52) : ''.padEnd(52)}`);
  console.log('║                                                          ║');
  console.log('║  Multiaddrs:                                             ║');
  addrs.forEach(addr => {
    console.log(`║    ${addr.padEnd(54)} ║`);
  });
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  To connect, set this env var:                           ║');
  console.log(`║  BOOTSTRAP_PEERS="${addrs.map(a => a + '/p2p/' + peerId).join(',')}"`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Relaying Mziya topics via GossipSub for peer discovery.  ║');
  console.log('║  This node has ZERO special power — it only relays      ║');
  console.log('║  blocks, txs, and votes between peers.                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('\n');

  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      const peersCount = node.getPeers().length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'OK',
        peerId,
        peersCount,
        uptime: process.uptime(),
        addrs,
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[Bootstrap] HTTP Health Check server running on http://0.0.0.0:${HEALTH_PORT}/health`);
  });

  node.addEventListener('peer:connect', (evt) => {
    const count = node.getPeers().length;
    process.stdout.write(`\r  Connected peers: ${count}    `);
  });

  node.addEventListener('peer:disconnect', () => {
    const count = node.getPeers().length;
    process.stdout.write(`\r  Connected peers: ${count}    `);
  });

  const shutdown = async () => {
    console.log('\n\n[Bootstrap] Shutting down...');
    healthServer.close();
    await node.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startBootstrapNode().catch(err => {
  console.error('[Bootstrap] Fatal error:', err);
  process.exit(1);
});
