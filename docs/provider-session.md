# Secure local provider session (historical; paid scope retired)

**Current status — 2026-10-23:** the approved migration created the Local retirement marker and carried the reviewed baseline into the remote ledger. This Local paid-test path now fails closed. The command below is retained as historical operator documentation; do not rerun it, remove the marker or reset the ledger. Use the [remote provider checkpoint](remote-provider-session.md) for the completed single attempt and cleanup outcome. Ordinary [local demo setup](local-development.md) is independent of this retired paid-test scope.

The user approved one temporary32-byte AES development key and an encrypted access-only WHEP DELETE cleanup copy in `CaptionDoorProviderSmoke20261022Runtime`, bound to the selected device/media with application validity≤60seconds. Cleanup is explicitly verified before controlled key disposal; physical removal can lag during an outage. The fixed root test scope, account256604024085/us-east-1, initial≤90seconds and $10ceiling remain unchanged. This is not new Ring-token, OAuth, IAM or deployment approval.

## Historical command in a fresh Mac Terminal

```sh
cd /Users/frank/mygit/CaptionDoor
corepack pnpm provider:session --start --approved-cleanup
```

1. Paste only an **existing approved Playground token** into `Paste EXISTING approved Ring Playground token (hidden; Enter to submit):`. Nothing is echoed. Never send it in chat. If unavailable or expired, cancel; the launcher does not create or refresh tokens.
2. Choose the number of an actually discovered authorized device. Only masked ID endings are displayed; no household/device names or provider profile are logged.
3. Type `START` at the final hidden prompt for one≤30second attempt. If there is no remote audio, no fixture or resident microphone is substituted. A LOCAL event plus observed Playground media remains mixed provenance, not a real doorbell webhook.

The launcher starts only its owned host web/worker and isolated DynamoDB Local setup. It fills missing fictional rows without resetting existing data or the fixed reservation ledger. Normal Compose remains demo/fixture. Secrets are passed only to backend process environments; browser children receive a sanitized environment. No plaintext token/key file, command argument, history entry, screenshot, trace, caption text or audio/video recording is produced. It does not promise secure erasure of JavaScript memory or provider copies.

A five-minute intake deadline bounds idle prompts. Ctrl-C requests cancellation; active paid capture remains bounded by the existing worker/media deadlines and cleanup follows. If `CLEANUP_PENDING_KEEP_TERMINAL_OPEN_KEY_RETAINED` appears, **keep the terminal open** and restore local database availability. The worker/key remain while strongly read physical content/media-copy absence is unconfirmed. Provider DELETE confirmation and provider expiry are reported separately. Forced OS termination can defeat process-memory retention; do not treat a forced exit as verified cleanup.

An atomic `output/provider-smoke/intake.lock` refuses overlapping launchers. After an interrupted OS process, inspect the stopped state and checkpoint before any manual lock removal; the launcher never automatically deletes a pre-existing lock or resets its ledger. Existing3410/3411 services or a foreign8410 database cause refusal. If OrbStack is stopped, open it normally and retry; no reset, purge or security change is required.

Sanitized outcomes, own visit/media IDs, cleanup evidence and cost-reservation metadata are written to a new `output/provider-smoke/<run-id>/` directory. These are ignored by Git. A provider PASS requires actual observed incoming audio and persisted AWS final captions; cleanup remains a separate observation. `--help` is zero-network; non-TTY execution refuses before secrets or services.

## Verification

On2026-10-23, TypeScript and544unit tests passed, including183fictional launcher/input/config/cleanup cases. Actual owned-PTY probes verified no echo and split bracketed-paste Ctrl-C tail draining. CLI help passed; non-interactive execution correctly refused. No real key/token/provider/service was used during this verification. The earlier draft type errors and paste-cancellation finding are fixed. The actual user-launched provider path is still unverified. Exact evidence: `output/provider-access-20261023/launcher-verification.json`.

## Separate remote path

The user requested remote DynamoDB to avoid OrbStack. The prepared `provider:session:remote` path and exact three-table/identity/storage approvals are in [remote-provider-session.md](remote-provider-session.md). Its independent AWS scope and separately approved root option do not relax this Local/root exception. No remote resources, grants, token copy, seed or paid stream have been created. A reviewed prior reservation receipt is required; no default zero is supplied. Once a separately approved migration writes `output/provider-smoke/local-scope-retired.json`, this Local launcher and its root reservation/permit paths fail closed. Do not remove that marker or reset either ledger to obtain new attempts.

The shared coordinator now registers preparation children, waits for the whole owned process group on cancellation/exit and labels AWS versus Local cleanup separately. A server-side credential-free media checkpoint records the exact owned media ID before WHEP, allowing failed negotiation to retain an exact cleanup key after visit state is cleared. No-provider-creation inference is permitted only after the checkpoint-aware owned web process has stopped; missing IDs alone remain insufficient. These changes need their own dated verification; the earlier 544-test checkpoint above does not establish their external behavior.
