# Agent Games — Proof Gatekeeper Agent

A minimal, self-contained Node.js agent for the Agent Games
(zkVerify) **Proof Gatekeeper** event. It receives HMAC-signed tasks
from the platform, decides APPROVE/REJECT with deterministic policy
checks, and answers with a real Groth16 proof of its decision generated
from the official gatekeeper circuit — no language model in the loop.

## Run

```bash
cd ~/workspace/agentgames/agent
npm install            # snarkjs 0.7.6 (already vendored in node_modules here)

# secret: env var, or a file at ~/.agentgames-hmac (one line, trimmed)
export AGENT_GAMES_HMAC_SECRET=<one-time secret from registration/rotation>
export PORT=8791       # default 8791

node server.mjs        # POST /agent ; GET / -> "ok" health check
```

See `.env.example`. The secret is read from the environment or
`~/.agentgames-hmac` only, and is never written to logs.

## Protocol implemented

- **Auth:** every POST body is verified *before* JSON parsing:
  `x-agent-games-signature` must equal hex(HMAC-SHA256(raw body, secret)),
  compared with `crypto.timingSafeEqual`. Failure → `401`, no JSON body.
- **Responses** are JSON and carry the same signature header over the raw
  response body.
- **Preflight** (`agent-games.preflight.v1`) → `200`
  `{"ok":true,"protocolVersion":"v1"}` exactly.
- **Task** (`agent-games.proof-gatekeeper.v1`) →
  `{"decision":"APPROVE"|"REJECT","reason_code":"...","proof":{...},"public_signals":[...]}`
  well within the 60 s deadline (observed ~0.3–1.0 s including proving).

## Decision policy (deterministic, first failure wins)

APPROVE only if **all** hold, else REJECT with the shown reason code:

| Check | Reason code |
|---|---|
| `registered_vk` == `proof_vk` == official VK `0x6b79c6…d77b0` | `VK_SUBSTITUTION` |
| `public_balance` ≥ `minimum` (BigInt) | `INSUFFICIENT_BALANCE` |
| `amount` ≤ `max_transfer` (BigInt) | `AMOUNT_EXCEEDS_MAX` |
| `recipient` == `condition_recipient` (case-insensitive) | `RECIPIENT_MISMATCH` |
| `current_block` < `expiry_block` | `EXPIRED` |

All-pass → `APPROVE` / `OK`.

A proof is generated for **both** outcomes (decision 1 and 0) and
attached whenever proving succeeds. If proving throws or exceeds a 50 s
soft cap, the server fails closed: signed `REJECT` /
`INTERNAL_ERROR` with no proof — never a crash, never a hang. Proof
generation is serialized through a queue so concurrent tasks cannot
interfere.

## Circuit

`circuit/` holds copies of the official artifacts
(`gatekeeper.wasm`, `gatekeeper_final.zkey`, `verification_key.json`).
Inputs are the circuit's 13 signals; hashes/addresses are passed as hex
strings and numbers as decimal strings (encoding proven in
`../circuit/RESULTS.md`). `salt` is 31 fresh random bytes per task.

### mapTaskId — documented guess

The circuit's `taskId` signal is a field element while the platform's
`task_id` is an opaque string (`gk_...`). `mapTaskId()` in `server.mjs`
maps: numeric string → the number mod BN254 prime; any other string →
`BigInt(sha256(task_id)) mod BN254 prime` (sha256 from `node:crypto`,
chosen over keccak256 to keep the server dependency-free; deterministic
either way). **This mapping is a guess to confirm against practice-round
traffic**; if the platform expects another derivation, only that one
function changes — `taskId` plays no role in the policy checks.

## Tests

```bash
node test-harness.mjs   # spawns the server with a test secret, 6 cases
```

Covers preflight, a valid task, recipient and VK traps, a numeric
task_id, and a bad-signature rejection — verifying response signatures
and Groth16 proofs end-to-end. Latest run: **6/6 PASS**, see
`TEST-RESULTS.md`.

## Layout

```
server.mjs            the agent (node:http only, no framework)
test-harness.mjs      self-contained end-to-end tests
circuit/              official gatekeeper artifacts (copies)
.env.example          AGENT_GAMES_HMAC_SECRET= / PORT=8791
TEST-RESULTS.md       latest harness run
```

Deployment and platform registration are handled separately; this
directory is the complete, runnable agent.
