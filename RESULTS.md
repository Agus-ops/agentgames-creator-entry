# Agent Games — Reproduksi Lokal Groth16 Proof (Circuit Gatekeeper)

Tanggal: 2026-11-15 · Lingkungan: Node v24.22.1, snarkjs 0.7.6 (lokal, `./node_modules/.bin/snarkjs`)
Sepenuhnya lokal — tidak ada pengiriman/submisi ke mana pun.

## File circuit resmi (diunduh dari agentgames.zkverify.io/circuits/)

| File | Ukuran (byte) | SHA-256 |
|---|---|---|
| gatekeeper.wasm | 1.755.820 | `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f` |
| gatekeeper_final.zkey | 309.750 | `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d` |

Verification key hasil ekspor: protocol `groth16`, curve `bn128` (BN254), `nPublic` 13 (12 input publik + 1 output publik).

## Perintah yang dijalankan

```bash
curl -sS -O https://agentgames.zkverify.io/circuits/gatekeeper.wasm \
           -O https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey
npm init -y && npm i snarkjs@0.7.6
snarkjs zkey export verificationkey gatekeeper_final.zkey verification_key.json
snarkjs groth16 fullProve input.json gatekeeper.wasm gatekeeper_final.zkey proof.json public.json
snarkjs groth16 verify verification_key.json public.json proof.json
# uji negatif:
snarkjs groth16 fullProve input-neg-a.json gatekeeper.wasm gatekeeper_final.zkey /tmp/proof-a.json /tmp/public-a.json
snarkjs groth16 fullProve input-neg-b.json gatekeeper.wasm gatekeeper_final.zkey /tmp/proof-b.json /tmp/public-b.json
snarkjs groth16 fullProve input-neg-c.json gatekeeper.wasm gatekeeper_final.zkey proof-reject.json public-reject.json
snarkjs groth16 verify verification_key.json public-reject.json proof-reject.json
```

## Encoding yang berhasil

- **Percobaan pertama langsung berhasil** — tidak perlu variasi encoding lain.
- Field hash (`registeredVkHash`, `proofVkHash`) dan alamat (`recipient`, `conditionRecipient`) ditulis sebagai **string hex `0x…`**; angka lain sebagai string desimal.
- Witness calculator menerima nilai hash 256-bit dan **mereduksinya modulo prima BN254** secara otomatis: `0x6b79…77b0 mod p = 4836144126773920907502496244340012141761656471453348073975163706578152814510` — nilai inilah yang muncul di `public.json`.
- Alamat burner muncul sebagai desimal `1204462396147742928188986846728496280043626693021`; alamat `0x…dEaD` sebagai `57005`.

## Skenario valid (input.json)

```
registeredVkHash = proofVkHash = 0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0
minimum = 1500 · publicBalance = 2731 · amount = 647 · maxTransfer = 950
expiryBlock = 9120000 · currentBlock = 9115000
recipient = conditionRecipient = 0xD2F9f6381Fb5f00c2fC606553592dB28309c019d
decision = 1 · taskId = 15112026
salt (privat, acak 200-bit) = 910132909437004252927647386859958197969064672228849299921767
```

Hasil: **fullProve sukses (exit 0), verify `[INFO] snarkJS: OK!`**
Ukuran `proof.json` = **803 byte** · `verification_key.json` = 5.117 byte · `public.json` = 431 byte.

Isi `public.json` (13 sinyal publik; posisi 2–13 = 12 input publik sesuai urutan deklarasi, posisi 1 = output publik circuit — nilainya identik di skenario valid & reject):

```json
[
 "20254948702734811083219717765722906159558853855274341609139041744898780509057",
 "4836144126773920907502496244340012141761656471453348073975163706578152814510",
 "4836144126773920907502496244340012141761656471453348073975163706578152814510",
 "1500",
 "2731",
 "9120000",
 "9115000",
 "1204462396147742928188986846728496280043626693021",
 "1204462396147742928188986846728496280043626693021",
 "647",
 "950",
 "1",
 "15112026"
]
```

## Matriks uji negatif

| Uji | Perubahan dari skenario valid | Harapan | Hasil aktual | Exit | Keterangan |
|---|---|---|---|---|---|
| (a) | `decision=1`, `recipient=0x000000000000000000000000000000000000dEaD` (≠ conditionRecipient) | GAGAL | **GAGAL** ✓ | 1 | `Assert Failed. Error in template GatekeeperEvaluation_79 line: 102` |
| (b) | Semua valid, `decision=0` | GAGAL | **GAGAL** ✓ | 1 | `Assert Failed. Error in template GatekeeperEvaluation_79 line: 102` |
| (c) | `decision=0` DAN `recipient=0x…dEaD` (≠ conditionRecipient) | BERHASIL + verify OK | **BERHASIL + verify OK** ✓ | 0 / 0 | Disimpan sebagai `proof-reject.json` (804 byte) + `public-reject.json`; verify: `[INFO] snarkJS: OK!` |

Ketiga uji negatif berperilaku persis seperti yang diharapkan: circuit hanya menerima (approve + recipient cocok) atau (reject + recipient tidak cocok); kombinasi approve-dengan-recipient-salah dan reject-dengan-recipient-benar ditolak di level constraint (assert saat witness calculation, sebelum proof dibuat).

## Artefak di direktori ini

`gatekeeper.wasm`, `gatekeeper_final.zkey`, `verification_key.json`, `input.json`, `proof.json`, `public.json`, `input-neg-a.json`, `input-neg-b.json`, `input-neg-c.json`, `proof-reject.json`, `public-reject.json`, `salt.txt`, log uji negatif (`neg-a.log`, `neg-b.log`, `neg-c.log`).
