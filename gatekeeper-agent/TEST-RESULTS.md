# Test Results — Proof Gatekeeper Agent

Run: 2026-11-15, local VM, `node test-harness.mjs` (harness spawns
`server.mjs` on port 8799 with test secret `test-secret-123`, sends signed
envelopes, verifies each response's `x-agent-games-signature` header, and
verifies every returned proof with `snarkjs groth16 verify` against
`circuit/verification_key.json`).

## Results: 6/6 PASS

| # | Case | Expected | Got | Proof verify | Duration |
|---|------|----------|-----|--------------|----------|
| 1 | Preflight envelope | 200, body exactly `{"ok":true,"protocolVersion":"v1"}`, signed | 200, exact body, signature valid | n/a | 11 ms |
| 2 | Valid task (official VK both fields, balance 1460 ≥ min 1000, amount 500 ≤ max 1000, recipient matches, not expired) | APPROVE / OK + proof | APPROVE / OK, proof attached | ✅ OK | 959 ms |
| 3 | Recipient trap (`condition_recipient` differs) | REJECT / RECIPIENT_MISMATCH + proof | REJECT / RECIPIENT_MISMATCH, proof attached | ✅ OK | 335 ms |
| 4 | VK trap (`proof_vk` substituted) | REJECT | REJECT / VK_SUBSTITUTION, proof attached | ✅ OK | 388 ms |
| 5 | Valid task with numeric `task_id` ("123456789") | APPROVE / OK + proof | APPROVE / OK, proof attached | ✅ OK | 376 ms |
| 6 | Envelope signed with the wrong secret | 401, no JSON body | 401, empty body | n/a | 3 ms |

**Average task round-trip including proving: ~515 ms** (deadline is
60 s — roughly 100× headroom). Proving itself dominates the round-trip;
subsequent proves are faster (~330–390 ms) once the runtime is warm.

## Additional checks (manual, same day)

- Secret fallback: server started with no `AGENT_GAMES_HMAC_SECRET` env
  but a `~/.agentgames-hmac` file → preflight answered 200 and correctly
  signed; the secret value never appears in server logs.
- Note on case 4: the circuit itself happily produces a proof carrying a
  substituted `proofVkHash` as a public input (it only binds
  decision ⇔ checks). Catching VK substitution is therefore the agent's
  policy layer's job — which is exactly what `decide()` does before
  proving — plus the platform's own comparison against the registered VK.

## How to re-run

```bash
cd ~/workspace/agentgames/agent
node test-harness.mjs        # exit code 0 iff all cases pass
```
