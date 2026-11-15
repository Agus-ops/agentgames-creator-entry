// Agent Games — Proof Gatekeeper agent server.
// Pure node:http, no framework. Receives HMAC-signed envelopes from the
// platform, answers preflight checks, and for gatekeeper tasks makes a
// deterministic APPROVE/REJECT decision plus a real Groth16 proof of that
// decision using the official gatekeeper circuit.
//
// Protocol (from the platform's official /build guide — do not improvise):
//   - Requests: POST /agent with header x-agent-games-signature =
//     hex(HMAC-SHA256(rawBody, AGENT_GAMES_HMAC_SECRET)).
//   - Responses: JSON body + the same signature header over the raw
//     response body.
//   - Preflight body {"type":"agent-games.preflight.v1", ...} must be
//     answered 200 with exactly {"ok":true,"protocolVersion":"v1"}.
//   - Task body {"type":"agent-games.proof-gatekeeper.v1", ...} must be
//     answered with {"decision","reason_code","proof","public_signals"}
//     within a hard 60s deadline.

import { createServer } from "node:http";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const { groth16 } = createRequire(import.meta.url)("snarkjs");

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(HERE, "circuit", "gatekeeper.wasm");
const ZKEY_PATH = join(HERE, "circuit", "gatekeeper_final.zkey");

// The one registered verification-key hash for the gatekeeper circuit,
// published by the platform. Any task whose registered_vk / proof_vk does
// not match this is a substitution attempt.
const OFFICIAL_VK =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

// BN254 scalar-field prime. Circuit inputs are field elements; hashes are
// reduced modulo this prime (the witness calculator also reduces, but we
// reduce explicitly so the values we log are the values in the proof).
const BN254_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ---------------------------------------------------------------------------
// Secret: env first, then ~/.agentgames-hmac. Never logged, never echoed.
// ---------------------------------------------------------------------------
function loadSecret() {
  const fromEnv = process.env.AGENT_GAMES_HMAC_SECRET;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const fromFile = readFileSync(join(homedir(), ".agentgames-hmac"), "utf8").trim();
    if (fromFile) return fromFile;
  } catch {
    /* file absent — fall through */
  }
  return null;
}

const SECRET = loadSecret();
if (!SECRET) {
  console.error(
    "FATAL: no HMAC secret. Set AGENT_GAMES_HMAC_SECRET or write it to ~/.agentgames-hmac"
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8791);

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------
function hmacHex(rawBody) {
  return createHmac("sha256", SECRET).update(rawBody).digest("hex");
}

function signatureValid(rawBody, headerValue) {
  if (typeof headerValue !== "string" || !headerValue) return false;
  const expected = Buffer.from(hmacHex(rawBody), "utf8");
  const given = Buffer.from(headerValue.trim().toLowerCase(), "utf8");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

function sendSigned(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "x-agent-games-signature": hmacHex(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// mapTaskId — DOCUMENTED GUESS, to be confirmed from practice rounds.
// The circuit's taskId signal is a field element, but the platform's
// task_id is an opaque string ("gk_..."). Mapping used here:
//   - numeric string  -> the number itself, reduced mod BN254 prime;
//   - any other string -> BigInt(sha256(task_id)) mod BN254 prime.
// sha256 from node:crypto is used (instead of keccak256) so this server is
// fully self-contained; the mapping is deterministic either way. If the
// platform turns out to expect a different derivation, ONLY this function
// needs to change — the decision logic is unaffected because taskId does
// not participate in any policy check.
// ---------------------------------------------------------------------------
function mapTaskId(taskId) {
  const s = String(taskId ?? "");
  if (/^\d+$/.test(s)) return (BigInt(s) % BN254_PRIME).toString();
  const digest = createHash("sha256").update(s, "utf8").digest("hex");
  return (BigInt("0x" + digest) % BN254_PRIME).toString();
}

function randomSalt() {
  // 31 random bytes -> always below the BN254 prime, never zero-padded oddly.
  return BigInt("0x" + randomBytes(31).toString("hex")).toString();
}

// ---------------------------------------------------------------------------
// Deterministic decision policy. Returns { approve, reasonCode }.
// Check order matters: the first failing check names the reason.
// ---------------------------------------------------------------------------
function decide(input) {
  const vkOk =
    String(input.registered_vk).toLowerCase() === OFFICIAL_VK &&
    String(input.proof_vk).toLowerCase() === OFFICIAL_VK;
  if (!vkOk) return { approve: false, reasonCode: "VK_SUBSTITUTION" };

  if (BigInt(String(input.public_balance)) < BigInt(String(input.minimum)))
    return { approve: false, reasonCode: "INSUFFICIENT_BALANCE" };

  if (BigInt(String(input.amount)) > BigInt(String(input.max_transfer)))
    return { approve: false, reasonCode: "AMOUNT_EXCEEDS_MAX" };

  if (
    String(input.recipient).toLowerCase() !==
    String(input.condition_recipient).toLowerCase()
  )
    return { approve: false, reasonCode: "RECIPIENT_MISMATCH" };

  if (!(BigInt(String(input.current_block)) < BigInt(String(input.expiry_block))))
    return { approve: false, reasonCode: "EXPIRED" };

  return { approve: true, reasonCode: "OK" };
}

function circuitInput(input, approve, taskId) {
  // Proven encoding (see ../circuit/RESULTS.md): hashes/addresses as hex
  // strings, numbers as decimal strings; the witness calculator reduces
  // mod the BN254 prime automatically.
  return {
    registeredVkHash: String(input.registered_vk),
    proofVkHash: String(input.proof_vk),
    minimum: String(input.minimum),
    publicBalance: String(input.public_balance),
    expiryBlock: String(input.expiry_block),
    currentBlock: String(input.current_block),
    recipient: String(input.recipient),
    conditionRecipient: String(input.condition_recipient),
    amount: String(input.amount),
    maxTransfer: String(input.max_transfer),
    decision: approve ? "1" : "0",
    taskId: mapTaskId(taskId),
    salt: randomSalt(),
  };
}

// ---------------------------------------------------------------------------
// Proving queue: fullProve is CPU-heavy; serialize so concurrent tasks can
// never corrupt each other or blow the deadline in a pile-up.
// ---------------------------------------------------------------------------
let proveChain = Promise.resolve();
function proveSerialized(inputObj) {
  const run = proveChain.then(() =>
    groth16.fullProve(inputObj, WASM_PATH, ZKEY_PATH)
  );
  // Keep the chain alive even when one prove rejects.
  proveChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

// Soft guard so a pathological prove can never eat the whole 60s deadline.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("prove_timeout")), ms)
    ),
  ]);
}

async function handleTask(res, envelope) {
  const started = Date.now();
  const taskId = envelope.task_id ?? "";
  const input = envelope.input ?? {};
  let decision = "REJECT";
  let reasonCode = "INTERNAL_ERROR";
  let proof = null;
  let publicSignals = null;

  try {
    const verdict = decide(input);
    decision = verdict.approve ? "APPROVE" : "REJECT";
    reasonCode = verdict.reasonCode;

    const { proof: p, publicSignals: ps } = await withTimeout(
      proveSerialized(circuitInput(input, verdict.approve, taskId)),
      50_000
    );
    proof = p;
    publicSignals = ps;
  } catch (err) {
    // Fail closed: a signed REJECT with no proof beats a crash, a hang, or
    // an unsigned answer. (An invalid/absent proof costs the same as this
    // fallback; a wrong APPROVE would cost far more.)
    decision = "REJECT";
    reasonCode = "INTERNAL_ERROR";
    proof = null;
    publicSignals = null;
    console.error(
      `[task ${taskId}] proving failed, failing closed: ${err?.message ?? err}`
    );
  }

  const payload = { decision, reason_code: reasonCode };
  if (proof) {
    payload.proof = proof;
    payload.public_signals = publicSignals;
  }
  console.log(
    `[task ${taskId}] ${decision} ${reasonCode} proof=${proof ? "yes" : "no"} ${Date.now() - started}ms`
  );
  sendSigned(res, 200, payload);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method !== "POST" || req.url !== "/agent") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("error", () => {
    if (!res.headersSent) res.writeHead(400).end();
  });
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);

    // Verify BEFORE parsing. Bad signature -> 401, no JSON body.
    if (!signatureValid(raw, req.headers["x-agent-games-signature"])) {
      res.writeHead(401).end();
      return;
    }

    let envelope;
    try {
      envelope = JSON.parse(raw.toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }

    try {
      if (envelope?.type === "agent-games.preflight.v1") {
        sendSigned(res, 200, { ok: true, protocolVersion: "v1" });
        return;
      }
      if (envelope?.type === "agent-games.proof-gatekeeper.v1") {
        await handleTask(res, envelope);
        return;
      }
      // Unknown (but validly signed) envelope type: signed 400 so the
      // caller can tell us apart from a dead endpoint.
      sendSigned(res, 400, { ok: false, error: "unknown_type" });
    } catch (err) {
      console.error(`handler error: ${err?.message ?? err}`);
      if (!res.headersSent) {
        try {
          sendSigned(res, 200, {
            decision: "REJECT",
            reason_code: "INTERNAL_ERROR",
          });
        } catch {
          res.writeHead(500).end();
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`agent-games gatekeeper agent listening on :${PORT} (POST /agent)`);
});
