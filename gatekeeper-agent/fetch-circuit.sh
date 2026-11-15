#!/bin/sh
# Download the official Proof Gatekeeper circuit artifacts (platform-owned).
mkdir -p circuit
curl -sL -o circuit/gatekeeper.wasm https://agentgames.zkverify.io/circuits/gatekeeper.wasm
curl -sL -o circuit/gatekeeper_final.zkey https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey
# Expected SHA-256:
# gatekeeper.wasm       be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f
# gatekeeper_final.zkey adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d
sha256sum circuit/gatekeeper.wasm circuit/gatekeeper_final.zkey
npx snarkjs@0.7.6 zkey export verificationkey circuit/gatekeeper_final.zkey circuit/verification_key.json
