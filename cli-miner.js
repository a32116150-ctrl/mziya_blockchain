import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Blockchain } from './core/blockchain.js';
import { MiningManager } from './core/mining.js';
import { MziyaP2P } from './network/peer.js';
import { createWallet, walletFromMnemonic, walletFromPrivateKey } from './core/wallet.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (query) => new Promise((resolve) => rl.question(query, resolve));

class FileStorage {
  constructor(filename) {
    this.filepath = path.resolve(process.cwd(), filename);
    this.data = {};
    if (fs.existsSync(this.filepath)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.filepath, 'utf8'));
      } catch (e) {
        this.data = {};
      }
    }
  }

  async get(key) {
    return this.data[key];
  }

  async set(key, val) {
    this.data[key] = val;
    this.save();
  }

  async delete(key) {
    delete this.data[key];
    this.save();
  }

  save() {
    try {
      fs.writeFileSync(this.filepath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('[Storage] Write failed:', e.message);
    }
  }
}

// Color constants for terminal output
const GOLD = '\x1b[38;5;220m';
const VIOLET = '\x1b[38;5;135m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const GRAY = '\x1b[90m';

const WALLET_PATH = path.resolve(process.cwd(), 'wallet.json');

function getProgressBar(percent, length = 15) {
  const filledLength = Math.min(length, Math.round(length * percent / 100));
  const emptyLength = Math.max(0, length - filledLength);
  const filled = '█'.repeat(filledLength);
  const empty = '░'.repeat(emptyLength);
  return `[${filled}${empty}]`;
}

async function walletMenu() {
  console.log(`\n${BOLD}── Wallet Setup ──${RESET}`);
  console.log(`  ${BOLD}[1]${RESET} Create new wallet`);
  console.log(`  ${BOLD}[2]${RESET} Import from 12-word seed phrase`);
  console.log(`  ${BOLD}[3]${RESET} Import from private key`);

  let wallet;
  let choice;

  while (!wallet) {
    choice = (await question(`  ${CYAN}?${RESET} Choose [${BOLD}1${RESET}]: `)).trim() || '1';

    if (choice === '1') {
      wallet = await createWallet();
    } else if (choice === '2') {
      const mnemonic = (await question(`  ${CYAN}✎${RESET} Enter your 12-word seed phrase: `)).trim().toLowerCase();
      try {
        wallet = await walletFromMnemonic(mnemonic);
      } catch (e) {
        console.log(`  ${RED}✕ Invalid mnemonic:${RESET} ${e.message}`);
      }
    } else if (choice === '3') {
      const privKey = (await question(`  ${CYAN}✎${RESET} Enter your private key (hex): `)).trim();
      try {
        wallet = walletFromPrivateKey(privKey);
      } catch (e) {
        console.log(`  ${RED}✕ Invalid private key:${RESET} ${e.message}`);
      }
    } else {
      console.log(`  ${RED}✕ Invalid choice${RESET}`);
    }
  }

  const walletSave = {
    address: wallet.address,
    publicKey: wallet.publicKey,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic || null,
    createdAt: Date.now()
  };
  fs.writeFileSync(WALLET_PATH, JSON.stringify(walletSave, null, 2));

  if (choice === '1') {
    console.log(`\n🆕 ${BOLD}New wallet created!${RESET}`);
    console.log(`  ${GREEN}${wallet.address}${RESET}`);
    console.log(`  ${RED}${BOLD}⚠️  Backup your wallet.json immediately! Keep it secret!${RESET}`);
    console.log(`  ${GRAY}12-word seed phrase (back this up):${RESET}`);
    console.log(`  ${GOLD}${wallet.mnemonic}${RESET}`);
  } else {
    console.log(`\n🔑 ${BOLD}Wallet imported successfully!${RESET}`);
    console.log(`  ${GREEN}${wallet.address}${RESET}`);
  }

  return wallet;
}

async function run() {
  // Clear screen and draw ASCII Art Banner
  console.clear();
  console.log(`${GOLD}${BOLD}`);
  console.log('  ███╗   ███╗███████╗██╗██╗   ██╗ █████╗ ');
  console.log('  ████╗ ████║╚══███╔╝██║╚██╗ ██╔╝██╔══██╗');
  console.log('  ██╔████╔██║  ███╔╝ ██║ ╚████╔╝ ███████║');
  console.log('  ██║╚██╔╝██║ ███╔╝  ██║  ╚██╔╝  ██╔══██║');
  console.log('  ██║ ╚═╝ ██║███████╗██║   ██║   ██║  ██║');
  console.log('  ╚═╝     ╚═╝╚══════╝╚═╝   ╚═╝   ╚═╝  ╚═╝');
  console.log(`${RESET}`);
  console.log(`  ${BOLD}⚡ Mziya Terminal Mining Node ${RESET}`);
  console.log(`  ${GRAY}Proof-of-Activity (PoA) Mining${RESET}`);
  console.log(`  ${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n`);

  // 1. Wallet setup menu
  let wallet;
  const existingWallet = fs.existsSync(WALLET_PATH) ? JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8')) : null;

  if (existingWallet) {
    console.log(`🔑 ${BOLD}Found existing wallet:${RESET} ${GREEN}${existingWallet.address}${RESET}\n`);
    console.log(`  ${BOLD}[1]${RESET} Use this wallet`);
    console.log(`  ${BOLD}[2]${RESET} Create / import a different wallet`);
    const choice = await question(`  ${CYAN}?${RESET} Choose [${BOLD}1${RESET}]: `);
    if (choice.trim() === '2') {
      wallet = await walletMenu();
    } else {
      wallet = existingWallet;
    }
  } else {
    wallet = await walletMenu();
  }

  console.log(`\n🔑 ${BOLD}Using Wallet:${RESET} ${GREEN}${wallet.address}${RESET}`);
  rl.close();

  // 2. Initialize Blockchain
  const chainStorage = new FileStorage('blockchain-state.json');
  let blockchain = new Blockchain().initialize();
  
  // Load existing chain from storage if present
  try {
    const stored = await chainStorage.get('chain');
    if (stored) {
      const chainData = JSON.parse(stored);
      if (chainData && chainData.length > 1) {
        blockchain = Blockchain.fromJSON(chainData);
        console.log(`📦 ${BOLD}Loaded Chain Height:${RESET} ${CYAN}${blockchain.length}${RESET}`);
      }
    }
  } catch (err) {
    console.warn(`${RED}[Chain] Load failed, starting fresh:${RESET}`, err.message);
  }

  // Helper to save chain
  const saveChain = async () => {
    try {
      await chainStorage.set('chain', JSON.stringify(blockchain.toJSON()));
    } catch (e) {
      console.warn(`${RED}[Chain] Save failed:${RESET}`, e.message);
    }
  };

  if (blockchain.length === 1) {
    await saveChain();
  }

  // 3. Initialize Mining Manager
  const miningStorage = new FileStorage('mining-sessions.json');
  const miningManager = new MiningManager(miningStorage);
  
  // Catch up existing session
  await miningManager.loadSession(wallet.address);
  miningManager.startTicking(60000);

  // 4. Start P2P
  console.log(`🌐 ${BOLD}Connecting to P2P network...${RESET}`);
  const p2p = new MziyaP2P(blockchain, blockchain.mempool);
  
  p2p.onPeerConnect = (peerId) => {
    console.log(`\n${GREEN}✔ [P2P] Peer connected:${RESET} ${peerId.slice(0, 12)}...`);
  };
  p2p.onPeerDisconnect = () => {
    console.log(`\n${RED}✘ [P2P] Peer disconnected.${RESET} Connected peers: ${p2p.peerCount}`);
  };
  p2p.onBlock = async () => {
    console.log(`\n${GREEN}✔ [P2P] Synced new block at height:${RESET} ${blockchain.length}`);
    await saveChain();
  };

  try {
    await p2p.start();
    console.log(`🌐 ${BOLD}P2P Node Running.${RESET} ID: ${CYAN}${p2p.peerId.toString().slice(0, 16)}...${RESET}`);
    await p2p.requestChainSync();
  } catch (err) {
    console.warn(`${RED}[P2P] Failed to start network, running in local mode:${RESET}`, err.message);
  }

  console.log(`\n${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`🚀 ${BOLD}Mining Cycle Status:${RESET}`);

  // 5. Mining cycle runner
  const checkMiningState = async () => {
    let session = miningManager.getSession(wallet.address);
    
    if (session && session.active && Date.now() < session.endTime) {
      // Session is actively running
    } else {
      const currentSession = miningManager.getSession(wallet.address);
      if (currentSession && !currentSession.active) {
        console.log(`\n🎁 ${BOLD}Mining session completed! Claiming reward...${RESET}`);
        const broadcastTx = p2p.isRunning ? (tx) => p2p.broadcastTransaction(tx) : undefined;
        const broadcastBlock = p2p.isRunning ? (b) => p2p.broadcastBlock(b) : undefined;

        const result = await miningManager.claimReward(
          wallet.address,
          blockchain,
          broadcastTx,
          broadcastBlock
        );

        if (result.error) {
          console.error(`${RED}✕ Claim failed:${RESET} ${result.error}`);
        } else {
          const newBalance = blockchain.utxo?.getBalance(wallet.address) || 0;
          console.log(`${GREEN}✓ Reward claimed!${RESET} ${GOLD}+${result.amount.toFixed(6)} MZY${RESET} → ${VIOLET}Wallet balance: ${newBalance.toFixed(6)} MZY${RESET}`);
          await saveChain();
        }
      }

      console.log(`🚀 ${BOLD}Starting new 24h mining session...${RESET}`);
      const startResult = await miningManager.startSession(wallet.address, {
        referrals: 0,
        isValidator: false
      });

      if (startResult.error) {
        console.error(`${RED}✕ Failed to start session:${RESET} ${startResult.error}`);
      } else {
        session = startResult.session;
        console.log(`⛏️  ${BOLD}Mining session started!${RESET} Rate: ${GOLD}${session.rate.toFixed(4)}${RESET} MZY/h`);
        if (p2p.isRunning) {
          await p2p.broadcastMiningActivity({
            address: wallet.address,
            sessionId: session.sessionId,
            timestamp: Date.now(),
            rate: session.rate
          });
        }
      }
    }
  };

  await checkMiningState();

  // Tick visual progress bar every second
  setInterval(async () => {
    const s = miningManager.getSession(wallet.address);
    if (s && s.active) {
      s.tick();
      const pct = s.progressPercent;
      const bar = getProgressBar(pct, 12);
      const peers = p2p.isRunning ? p2p.peerCount : 0;
      const height = blockchain.length;
      const balance = blockchain.utxo?.getBalance(wallet.address) || 0;
      process.stdout.write(`\r${GREEN}${BOLD}[Mining]${RESET} ${GOLD}${bar} ${Math.round(pct)}%${RESET} | Rate: ${GOLD}${s.rate.toFixed(4)}${RESET} MZY/h | Earned: ${GREEN}${s.earned.toFixed(6)}${RESET} MZY | ${VIOLET}Balance: ${balance.toFixed(6)}${RESET} MZY | Peers: ${CYAN}${peers}${RESET} | Height: ${CYAN}${height}${RESET} | Ends: ${VIOLET}${s.remainingHuman}${RESET}    `);
    } else {
      process.stdout.write(`\r${GRAY}[Mining] Checking cycle state...${RESET}                                                                      \n`);
      await checkMiningState();
    }
  }, 1000);
}

run().catch(console.error);
