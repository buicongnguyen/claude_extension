# Account safety fixes and second review — 2.15.3

All five findings from the 2.15.2 review have been addressed. The review's original failing test output is retained in `review/test-results.log`; maintained regression tests now run in the normal test suite.

## Changes

1. **Wrong-account automatic overwrite:** cached config identity no longer authorizes replacing credentials by itself. Automatic updates require matching identity and a matching access or refresh token from the saved login. A replacement of both opaque tokens is left untouched until the user explicitly confirms the same account. This applies to manual refresh, switching, and opening a new login. No OAuth profile request or other network client was added.
2. **Stale picker updates:** update checks stable account identity at commit time. An explicit confirmation includes hashes of the exact live credentials, live config and saved snapshot. Changes while confirmation is open invalidate it. The login action rereads the current account instead of relying on the picker's original state.
3. **Lost recovery backup:** before changing live files, switching writes an encrypted recovery journal containing the prior login and intended result. Failed rollback retains the journal and backup. Startup and the next switch recover a known interrupted state under the same locks. They preserve an already committed new login, and refuse to overwrite an unrelated subsequent login.
4. **Partial snapshot updates:** identity, credentials and metadata are now in one encrypted `profile.enc` file, committed by atomic replacement. Old encrypted snapshots remain readable and upgrade on successful update. Damaged new-format files never fall back to stale legacy tokens. Save, update, delete and switch mutations use the same credential/config locks.
5. **Concurrent vault initialization:** initialization retries an existing marker asynchronously for up to three seconds, then rereads SecretStorage. It never steals another initializer's marker or silently regenerates a missing key for an existing vault.

The second review also caught a necessary extension of finding 1: opening `/login` must preserve the outgoing account's rotated tokens first. Three picker-level tests verify ordering, cancellation, and an account change in another window.

## Deliberate behavior change

If both tokens changed, Manager cannot determine from local files alone whether that was a refresh or a different login. It now asks **Confirm same account** before replacing a saved login. The prompt explicitly says that the displayed account name can be stale. Cancel when uncertain and finish login before saving a new account. This is a user-confirmed account binding, not server-side identity verification. A [reported Claude identity mismatch](https://github.com/anthropics/claude-code/issues/81231) reinforces why merely waiting longer or trusting another cached label is insufficient.

Automatic full-token replacement is intentionally no longer supported. This preserves the previous saved account during the ambiguous login window without making new requests using subscription OAuth credentials.

## Verification

- The original five defect reproductions pass.
- Additional regression cases cover cancelled and stale confirmations, a changed saved generation, complete token rotation and a switch round trip, switching to an already active account, recovery after reopening the vault, interrupted commit cleanup, refusal to overwrite a later login, orphan backup preservation, legacy migration and corruption refusal.
- The focused account/activation/terminal/watcher checks passed 176 tests across 12 files. The subsequent three picker-level tests also passed: **179 focused checks across 13 files**.
- TypeScript checking and the configured Biome check passed. Biome's existing configuration covers a limited subset of the repository; it is not a full security audit.
- Final full suite: **3,802 passed / 19 failed across 293 files**. File/name comparison confirms exactly the same 19 baseline Windows failures, with no new failures. Builds and version 2.15.3 VSIX packaging passed; results are also recorded in `PERSONAL-VERIFICATION.md`.

Tests use synthetic credentials, isolated home directories and an in-memory SecretStorage substitute. The extension was not installed or activated, and real account credentials were not read. Live browser authentication, real token refresh, remote hosts, custom config directories and actual subscription quota transitions remain untested. The fixes improve local account preservation; they do not turn Claude's private credential format into a supported third-party API.

## Recovery files

The encrypted journal is `accounts/.switch-recovery.enc` inside the extension's storage. The live configuration backup is `~/.claude.json.manager-personal.bak`. Backup cleanup happens only after a verified consistent result. If recovery reports that a separate login changed the files, stop and restore the desired account deliberately; do not delete recovery files merely to dismiss the error. Power-loss durability and third-party processes that ignore the locks are outside the synthetic test guarantees.
