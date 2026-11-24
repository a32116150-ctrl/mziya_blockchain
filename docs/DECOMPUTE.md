# Mziya Decentralized Compute (DeCompute)

> **Note:** the current consensus rules for mining claims, fees, staking and DeCompute payouts are in [ECONOMY.md](ECONOMY.md). Where this page disagrees, ECONOMY.md is correct.

> ML training market on top of the Mziya blockchain.
> Users earn MZY by donating CPU/GPU cycles. Companies pay MZY for distributed training.

---

## The Problem Today

The "Train" button trains a useless toy model on synthetic noise. It's Proof-of-Computation disguised as AI — no real value.

## The Vision

Replace that placeholder with a **decentralized compute market**. Every device that mines MZY can also contribute real compute power for ML training. Companies submit models, users train them on-device, the blockchain verifies the work and handles payment.

The once-per-day limit creates genuine compute scarcity — companies compete for access.

---

## Architecture

### Roles

| Role | Who | What they do |
|------|-----|-------------|
| **Model Provider** | Company / Dev | Deploys a TF.js model + training spec, pays MZY into escrow |
| **Trainer** | Any miner/node | Presses "Train", runs model on-device CPU/GPU, submits weights |
| **Verifier** | Any peer | Checks submitted weights against public test set, flags cheaters |
| **Chain** | Mziya blockchain | Holds escrow, processes TRAINING txs, pays out verified work |

### Lifecycle of a Training Job

```
1. Model Provider deposits MZY into escrow for N training slots
2. Trainers see available models in the "DeCompute" panel
3. Trainer presses "Train" → device trains model for ~10 seconds
4. Trainer submits weights + validation accuracy on-chain
5. Verifier peers cross-check accuracy claims against the public test set
6. After challenge window closes → payment released from escrow
7. Model Provider can withdraw unused escrow
```

### What the Trainer's Device Actually Does

Only CPU/GPU compute is used — **no user data**. The model receives:

```text
Model Provider:
  ├─ Model architecture (TF.js JSON)
  └─ Validation dataset seed instructions

Trainer Device (Main Thread):
  ├─ User taps "Train"
  └─ Dispatches job to background WebWorker (`ai-worker.js`) to prevent UI freeze

Trainer Device (WebWorker):
  ├─ Generates synthetic dataset deterministically seeded by `latestBlock.hash`
  ├─ Trains on the provided dataset using local CPU/GPU
  ├─ Extracts final weights
  ├─ Runs inference on the validation set to get accuracy
  └─ Returns { weights, accuracy } to main thread, which submits it on-chain
```

The provider chooses the dataset. It can be:
- **Synthetic**: generated from a known seed (reproducible by verifiers)
- **Public dataset**: referenced by hash, stored on IPFS / Arweave
- **Federated-style**: each trainer gets a unique split (requires per-trainer verification)

---

## On-Chain Transactions

### New Transaction Types

| Type | Description | Payload |
|------|-------------|---------|
| `MODEL_DEPLOY` | Company registers a training job | `{ modelId, modelConfig, datasetHash, testSetHash, rewardPerTrain, maxSlots, deadline }` |
| `TRAINING_SUBMIT` | Trainer submits trained weights | `{ modelId, weights, accuracy, modelConfig used }` |
| `TRAINING_VERIFY` | Verifier challenges a submission | `{ submissionTx, computedAccuracy, invalid: bool }` |
| `MODEL_WITHDRAW` | Company reclaims unused escrow | `{ modelId }` |

### MODEL_DEPLOY

```json
{
  "type": "MODEL_DEPLOY",
  "from": "MZcompany...",
  "amount": 5000,
  "data": {
    "modelId": "mnist-classifier-v1",
    "modelConfig": {
      "layers": [
        { "type": "dense", "units": 128, "activation": "relu", "inputShape": [784] },
        { "type": "dense", "units": 10, "activation": "softmax" }
      ],
      "compile": { "optimizer": "adam", "loss": "categoricalCrossentropy" },
      "epochs": 5,
      "batchSize": 32
    },
    "datasetHash": "sha3_256_of_training_data",
    "testSetHash": "sha3_256_of_validation_data",
    "rewardPerTrain": 10,
    "maxSlots": 1000,
    "deadline": 1893456000000
  }
}
```

The `amount` is deposited into escrow: `amount >= maxSlots * rewardPerTrain`.

### TRAINING_SUBMIT

```json
{
  "type": "TRAINING_SUBMIT",
  "from": "MZtrainer...",
  "amount": 0,
  "data": {
    "modelId": "mnist-classifier-v1",
    "weights": [[0.123, -0.456, ...], [...]],
    "accuracy": 0.9345,
    "publicKey": "ed25519_pubkey"
  }
}
```

The trainer signs the submission with their wallet key. `weights` are the first layer's trained weights (fixed-size, verifiable).

### TRAINING_VERIFY

If a verifier detects fraud (accuracy claim doesn't match actual test set performance):

```json
{
  "type": "TRAINING_VERIFY",
  "from": "MZverifier...",
  "amount": 0,
  "data": {
    "submissionTx": "hash_of_training_submit_tx",
    "computedAccuracy": 0.5123,
    "invalid": true
  }
}
```

---

## Verification Model

### How Verification Works

1. **Trainer submits** `TRAINING_SUBMIT` with weights + claimed accuracy
2. **Challenge window opens** (e.g., 100 blocks ~ 100 minutes)
3. **Any peer can verify**: download the test set, load weights into a TF.js model, run `model.evaluate()`, compare reported accuracy
4. If `|reportedAccuracy - verifiedAccuracy| > 0.02` → honest mistake tolerance
5. If mismatch is larger → anyone submits `TRAINING_VERIFY { invalid: true }`
6. If verified valid → after window closes → escrow releases `rewardPerTrain` to trainer
7. If invalid → trainer gets nothing (escrow stays), verifier gets a reward

### Anti-Cheat Protections

| Attack | Defense |
|--------|---------|
| Submit random weights with fake accuracy | Verifiers check against test set; slashing |
| Submit same weights twice | Nonce check per model+trainer+day |
| Submit without training | Training = 10s of real CPU work; test set verification catches random weights |
| Collusion with verifier | Any peer can verify; incentive to catch fraud |
| Dataset replay | Unique per-model dataset; weight distribution must match expected |
| GPU vs CPU advantage | Irrelevant — verification only checks output accuracy, not training time |

### Trainer daily limit

Already enforced: one training session per device per model per day (via `mziya:lastAiTrainTime`). Multiple models = multiple buttons.

---

## Economic Model

### Compute-Based Rewards

Training reward is **proportional to actual compute contributed** — not a flat fee:

```
deviceScore = deviceSpeedFactor × accuracyFactor
totalScore  = Σ(deviceScore) for all trainers in this payment window
trainerReward = escrowPerWindow × (deviceScore / totalScore)
```

### deviceSpeedFactor

Each device runs a **once-per-wallet benchmark** (3-second TF.js inference speed test) stored in `localStorage` as `mziya:computeBenchmark`:

| Device | Typical speedFactor | Notes |
|--------|-------------------|-------|
| Phone (mid-range, CPU) | 0.5 | ARM CPU, no GPU |
| Phone (flagship, CPU) | 1.0 | Baseline — Apple A17 / Snapdragon 8 |
| Phone (with WebGL GPU) | 2.0–3.0 | TF.js WebGL backend |
| Laptop (CPU only) | 1.0–2.0 | Intel/AMD laptop CPU |
| Desktop (dedicated GPU) | 3.0–8.0 | NVIDIA/AMD via WebGL or Node.js |
| Raspberry Pi 4 | 0.4 | ARM Cortex-A72 |
| RPi 5 / VPS (2 vCPU) | 0.8–1.5 | Depends on performance |
| Server (16+ vCPU + GPU) | 10.0+ | Full dedicated compute |

### accuracyFactor

How well the device trained the model:

```
accuracyFactor = min(1.0, achievedAccuracy / maxExpectedAccuracy)
```

- `achievedAccuracy` = validation accuracy after training
- `maxExpectedAccuracy` = published by model provider
- If `accuracyFactor < 0.3` → submission rejected (likely cheating)

### Supply Side (Trainers)

- User presses "Train" once per day per model
- Device runs TF.js compute for a fixed duration (~10 seconds)
- User earns MZY proportional to device speed × training quality
- Benchmark runs once (cached), never re-entered

### Demand Side (Model Providers)

- Company deposits MZY into escrow with a total budget
- Sets `minAccuracy`, `maxExpectedAccuracy`, `budget`, `epochs`
- Higher budget = more trainers attracted (competitive market)
- Company gets real distributed training across heterogeneous hardware

### Network Fee

- Small tx fee on `TRAINING_SUBMIT` (burned like all fees)
- No protocol fee on escrow (MZY becomes the utility token, increasing demand)

### Investor Narrative

```
Problem:  ML training is centralized (AWS, GCP, Azure)
          Expensive ($5-50/hr for GPUs)
          Privacy concerns (data leaves your control)

Solution: Mziya DeCompute
          ✓ 10,000+ phones = supercomputer
          ✓ Data never leaves device
          ✓ Pay per training run, not per GPU hour
          ✓ Global distribution (any device, any country)

TAM:      Global cloud ML training market → $40B+ by 2030
Moat:     Existing P2P network + wallet base + once-per-day scarcity
Revenue:  Token demand from companies buying MZY to pay for training
```

---

## Company Integration Path

This is the most critical design question — how does a company actually put their model on Mziya?

### The Reality Check

Most companies train models in **Python (PyTorch / TensorFlow / JAX)** on GPU clusters. They don't write TF.js. The Mziya network runs on **phones and browsers** which can only execute TF.js (or ONNX via WebAssembly). There is a format gap.

Three integration paths, from easiest to most powerful:

### Path 1: TF.js Native (Phase 1)

**Best for:** Small models, prototyping, ML competitions, academia.

```
Company:
  1. Writes model in Keras/TF.js (or converts via tfjs-converter)
  2. Serializes architecture as JSON
  3. Creates MODEL_DEPLOY tx with model config + dataset hash
  4. Deposits MZY escrow

Limitations:
  - Must target TF.js API subset
  - No custom Python layers
  - Max model size ~5MB (practical for mobile)
  - Most real-world models (transformers, CNNs) CAN be converted
```

Conversion tools exist:
- `tensorflowjs_converter` — Keras → TF.js (works for most Sequential/Functional models)
- `onnx2tf` — ONNX → TF.js (partial support)
- Manual rewrite — small models can be rewritten in a few hours

### Path 2: ONNX Runtime (Phase 2)

**Best for:** Companies with existing ONNX models, broader model compatibility.

```
Company:
  1. Exports model to ONNX format (supported by PyTorch, TF, JAX)
  2. Uploads ONNX binary to IPFS
  3. MODEL_DEPLOY tx references ONNX model hash
  4. Devices run onnxruntime-web (WebAssembly) — no TF.js needed
  5. Training loop is the same (forward + backward pass)

Limitations:
  - ONNX runtime in browser is ~2x slower than TF.js
  - Not all operators supported in WebAssembly build
  - Works on desktop browsers; mobile support varies
  - Training (backward pass) support in ONNX is limited — inference-only is more realistic
  - Better suited for **fine-tuning** a pre-trained model than full training
```

### Path 3: Node.js Container (Phase 3)

**Best for:** Production ML teams, any framework, full flexibility.

```
Company:
  1. Packages training script in a Docker container
  2. Container receives dataset URL + reward address as env vars
  3. Uploads container image hash + resource requirements
  4. Runs on desktop/server nodes (Node.js, not browser)
  5. Device runs the container, outputs weights + accuracy
  6. Output verified on-chain

Benefits:
  - Any framework (PyTorch, TF, JAX, scikit-learn)
  - Any model architecture
  - Full GPU support (CUDA)
  - Same code as their existing training pipeline

Limitations:
  - Browser/mobile can't run containers (only desktop/server)
  - Security concerns (arbitrary code execution)
  - Requires Docker on the node
  - Verification is harder (must re-run container)
```

### What Companies Actually Want

A company considering Mziya DeCompute would use it for:

| Use Case | Path | Why Mziya Wins |
|----------|------|----------------|
| **Hyperparameter search** | 1 or 2 | Test 1000 configurations in parallel across devices in 1 day vs 10 on a single GPU |
| **Ensemble training** | 1 or 2 | Train 100 small models simultaneously; combine into ensemble |
| **Federated fine-tuning** | 2 | Fine-tune a base model on distributed data without data leaving devices |
| **Reinforcement learning** | 3 | Run many RL episodes in parallel on heterogeneous hardware |
| **Synthetic data training** | 1 | Generate synthetic data per device, train locally, aggregate weights |
| **Model distillation** | 1 | Train small student models from a large teacher model in parallel |

### Real-World Example

**Company**: FinTech startup building a fraud detection model.

```
1. They have a PyTorch model: 3-layer DNN (256 → 128 → 1)
2. They convert to TF.js using tensorflowjs_converter (10 minutes)
3. They generate 10,000 synthetic transaction samples
4. They upload dataset hash + model config + 5,000 MZY escrow
5. 500 phones train the model in one day
6. They get back 500 slightly-different trained weight sets
7. They ensemble the best 10 into their production model

Cost: 5,000 MZY (market rate) vs $2,000+ on AWS for equivalent compute
Time: 1 day vs 1 week (sequential GPU training)
Quality: 500 diverse weight sets → more robust ensemble
```

### The One-Page Pitch to a Company

> "You write your model in TF.js (or convert from Keras in 10 minutes). You deploy it to 10,000+ devices worldwide. Each device trains on its local CPU/GPU for 10 seconds and submits the weights. You pay per completed training run in MZY. No infrastructure to manage, no data privacy concerns, no GPU shortage."

---

## UI Changes

### Main Mining Page

A new **DeCompute** section below the existing AI DePIN panel, showing:

```
Available Models
┌──────────────────────────────────────┐
│ mnist-classifier-v1                  │
│ Pool: 1,250 / 10,000 MZY remaining   │
│ Your speedFactor: 1.0 (flagship)      │
│ Min accuracy: 50% — Expected: 90%    │
│ [Train Now]                          │
├──────────────────────────────────────┤
│ customer-churn-predictor-v2          │
│ Pool: 500 / 5,000 MZY remaining      │
│ Your speedFactor: 1.0 (flagship)      │
│ [Train] — available in 12h 30m       │
└──────────────────────────────────────┘
```

Each model is independent — training one doesn't affect cooldown on another. The once-per-day limit is per model.

### Wallet Page

New **Earnings** section:

```
Training Rewards
  Last training:      47 MZY (speedFactor 1.0 × accuracy 93%)
  This week:          312 MZY
  Lifetime:           1,247 MZY
  Device benchmark:   1.0 (flagship phone)
  Models available:   2
```

---

## Files

| File | Purpose |
|------|---------|
| `core/decompute.js` | Model registry, escrow logic, job lifecycle |
| `core/ai-verifier.js` | Simulated zkML deterministic tensor verification engine |
| `core/transaction.js` | `MODEL_DEPLOY`, `TRAINING_SUBMIT`, `TRAINING_VERIFY`, `MODEL_WITHDRAW` tx types |
| `core/blockchain.js` | Integrate escrow release, verification window |
| `web/js/decompute.js` | UI: available models, train button, earnings display |
| `web/js/ai-worker.js` | Background WebWorker executing TF.js training |
| `web/index.html` | DeCompute panel in mining/wallet views |

---

## Implementation Order

### Phase 1 (MVP — ~1 week)
1. Add 4 new transaction types to `core/transaction.js`
2. Create `core/decompute.js` — escrow, job registry, verification
3. Wire verification into `core/blockchain.js`
4. Simple `web/js/decompute.js` — show one hardcoded model, Train button, submit
5. Verify on two browser tabs

### Phase 2 (Usable)
1. Allow model providers to deploy via a simple form
2. Dataset hosting via IPFS or on-chain hash
3. Verification rewards (verifier gets small cut)
4. UI improvements (earnings history, per-model stats)

### Phase 3 (Production)
1. Multi-model parallel training on one device
2. GPU detection + heavier models for desktop/RPi
3. Model marketplace (discover + deploy)
4. Slashing for fraudulent submissions
5. Incentive-compatible challenge game

---

## Open Questions

1. **Dataset storage**: On-chain (limited) or IPFS/Arweave (requires external dependency)?
2. **Verification incentives**: How much does a verifier earn for catching fraud?
3. **Challenge window**: How many blocks? Too short = misses fraud. Too long = slow payout.
4. **Weight size**: Large models have large weight arrays. Options:
   - Submit only first/last layer weights (proxy for full training)
   - Submit a hash of all weights + accuracy claim (verifier downloads externally)
   - Submit compressed weight deltas (difference from initial weights)
5. **Model lifecycle**: What happens when company runs out of escrow mid-job? Pause or continue?
6. **Container security**: Path 3 (Docker) introduces arbitrary code execution risk. Sandboxing strategy?
7. **Benchmark accuracy**: How to prevent devices from reporting fake speedFactor? Options: run a standard model and time it on-chain verifiably, or trust but verify with statistical outliers flagged.
8. **Minimum payout**: Tiny training runs might earn fractions of a MZY. Minimum payout threshold to avoid spam?
