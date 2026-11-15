// Test harness for the Proof Gatekeeper agent server.
// Spawns server.mjs locally with a test secret, sends signed envelopes,
// and checks: (1) the response's x-agent-games-signature header, and
// (2) for tasks, that any returned Groth16 proof verifies against
// circuit/verification_key.json with snarkjs.
// Prints PASS/FAIL per case and exits non-zero on any failure.

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const { groth16 } = createRequire(import.meta.url)("snarkjs");
const HERE = dirname(fileURLToPath(import.meta.url));

const TEST_SECRET = process.env.TEST_HMAC_SECRET || "test-secret-123";
const PORT = Number(process.env.TEST_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;

const OFFICIAL_VK =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const RECIPIENT = "0xD2F9f6381Fb5f00c2fC606553592dB28309c019d";

const vk = JSON.parse(
  readFileSync(join(HERE, "circuit", "verification_key.json"), "utf8")
);

function sign(raw, secret = TEST_SECRET) {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

async function postSigned(obj, { secret = TEST_SECRET } = {}) {
  const raw = JSON.stringify(obj);
  const started = Date.now();
  const res = await fetch(`${BASE}/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-games-signature": sign(raw, secret),
    },
    body: raw,
    signal: AbortSignal.timeout(55_000),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    signature: res.headers.get("x-agent-games-signature"),
    ms: Date.now() - started,
  };
}

function responseSignatureOk(r) {
  return (
    typeof r.signature === "string" &&
    r.signature.toLowerCase() === sign(r.text).toLowerCase()
  );
}

async function proofOk(body) {
  if (!body?.proof || !body?.public_signals) return null; // no proof attached
  try {
    return await groth16.verify(vk, body.public_signals, body.proof);
  } catch {
    return false;
  }
}

function taskEnvelope(overrides = {}, inputOverrides = {}) {
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: "gk_test_1",
    mode: "competition",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    input: {
      registered_vk: OFFICIAL_VK,
      proof_vk: OFFICIAL_VK,
      minimum: "1000",
      public_balance: "1460",
      expiry_block: 8430000,
      current_block: 8420000,
      recipient: RECIPIENT,
      condition_recipient: RECIPIENT,
      amount: "500",
      max_transfer: "1000",
      proof_tx:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      ...inputOverrides,
    },
    ...overrides,
  };
}

const results = [];
function report(name, pass, detail, ms) {
  results.push({ name, pass, detail, ms });
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${ms != null ? `  (${ms}ms)` : ""} — ${detail}`
  );
}

async function waitForServer(proc) {
  for (let i = 0; i < 50; i++) {
    if (proc.exitCode !== null) throw new Error("server exited early");
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not come up");
}

const server = spawn("node", ["server.mjs"], {
  cwd: HERE,
  env: { ...process.env, PORT: String(PORT), AGENT_GAMES_HMAC_SECRET: TEST_SECRET },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[server-err] ${d}`));

try {
  await waitForServer(server);

  // Case 1 — preflight.
  {
    const r = await postSigned({
      type: "agent-games.preflight.v1",
      agent_id: "agt_test",
      issued_at: new Date().toISOString(),
      nonce: "nonce-1",
    });
    let body = null;
    try { body = JSON.parse(r.text); } catch { /* stays null */ }
    const pass =
      r.status === 200 &&
      body?.ok === true &&
      body?.protocolVersion === "v1" &&
      Object.keys(body ?? {}).length === 2 &&
      responseSignatureOk(r);
    report("preflight", pass, `status=${r.status} body=${r.text} sig=${responseSignatureOk(r)}`, r.ms);
  }

  // Case 2 — valid task -> APPROVE + verifiable proof.
  {
    const r = await postSigned(taskEnvelope({ task_id: "gk_valid_1" }));
    const body = JSON.parse(r.text);
    const pv = await proofOk(body);
    const pass =
      r.status === 200 &&
      body.decision === "APPROVE" &&
      body.reason_code === "OK" &&
      pv === true &&
      responseSignatureOk(r);
    report("task valid -> APPROVE + proof", pass, `decision=${body.decision} reason=${body.reason_code} proofVerify=${pv} sig=${responseSignatureOk(r)}`, r.ms);
  }

  // Case 3 — recipient trap -> REJECT + verifiable proof.
  {
    const r = await postSigned(
      taskEnvelope(
        { task_id: "gk_trap_recipient" },
        { condition_recipient: "0x000000000000000000000000000000000000dEaD" }
      )
    );
    const body = JSON.parse(r.text);
    const pv = await proofOk(body);
    const pass =
      r.status === 200 &&
      body.decision === "REJECT" &&
      body.reason_code === "RECIPIENT_MISMATCH" &&
      pv === true &&
      responseSignatureOk(r);
    report("task recipient trap -> REJECT + proof", pass, `decision=${body.decision} reason=${body.reason_code} proofVerify=${pv} sig=${responseSignatureOk(r)}`, r.ms);
  }

  // Case 4 — VK trap -> REJECT (proof optional: the circuit may refuse a
  // witness for a substituted VK, in which case the server fails closed).
  {
    const r = await postSigned(
      taskEnvelope(
        { task_id: "gk_trap_vk" },
        { proof_vk: "0x0000000000000000000000000000000000000000000000000000000000000001" }
      )
    );
    const body = JSON.parse(r.text);
    const pv = await proofOk(body);
    const pass =
      r.status === 200 &&
      body.decision === "REJECT" &&
      pv !== false &&
      responseSignatureOk(r);
    report("task vk trap -> REJECT", pass, `decision=${body.decision} reason=${body.reason_code} proofVerify=${pv} sig=${responseSignatureOk(r)}`, r.ms);
  }

  // Case 5 — numeric task_id (exercises the numeric branch of mapTaskId).
  {
    const r = await postSigned(taskEnvelope({ task_id: "123456789" }));
    const body = JSON.parse(r.text);
    const pv = await proofOk(body);
    const pass =
      r.status === 200 &&
      body.decision === "APPROVE" &&
      pv === true &&
      responseSignatureOk(r);
    report("task numeric task_id -> APPROVE + proof", pass, `decision=${body.decision} reason=${body.reason_code} proofVerify=${pv} sig=${responseSignatureOk(r)}`, r.ms);
  }

  // Case 6 — bad signature -> 401, no JSON body.
  {
    const r = await postSigned(
      { type: "agent-games.preflight.v1", agent_id: "agt_test", issued_at: new Date().toISOString(), nonce: "n" },
      { secret: "wrong-secret" }
    );
    let isJson = true;
    try { JSON.parse(r.text); } catch { isJson = false; }
    const pass = r.status === 401 && !isJson;
    report("bad signature -> 401", pass, `status=${r.status} jsonBody=${isJson}`, r.ms);
  }
} finally {
  server.kill("SIGTERM");
}

const failed = results.filter((r) => !r.pass);
const taskMs = results.filter((r) => r.ms != null && r.name.startsWith("task")).map((r) => r.ms);
const avg = taskMs.length ? Math.round(taskMs.reduce((a, b) => a + b, 0) / taskMs.length) : null;
console.log(
  `\n${results.length - failed.length}/${results.length} PASS` +
    (avg != null ? ` — avg task round-trip (incl. proving): ${avg}ms` : "")
);
process.exit(failed.length ? 1 : 0);
