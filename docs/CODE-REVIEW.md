# Personal fork: code and account-switching logic review

Reviewed the uncommitted personal 2.15.2 fork based on upstream 2.15.1 (`c9a8181c8d2ef5ba25199517c2bde6ff04ef9531`). The review concentrated on the fork diff, encrypted profile storage, account identity matching, live credential switching, watchers, terminal input, and activation. It is not a complete audit of every upstream feature or dependency.

**Historical review of 2.15.2. These five findings were addressed in 2.15.3; see [fixes and second review](REVIEW-FIXES.md). The descriptions and line references below document the original defects.** Encryption and the safer terminal-input flow do not resolve the account identity and transaction bugs below. Production code and the existing VSIX were not changed during this review.

## Findings

### 1. P1 — Automatic sync can overwrite Account 1 with Account 2's tokens

Locations: `src/features/account/profiles.ts:717-725`, identity fallback at `376-385`, pair read at `177-190`; watcher at `src/features/sessions/watchers.ts:163-194`.

Trigger: Account 1 is saved, and a login writes Account 2's opaque credentials before updating `.claude.json`. If that intermediate state lasts long enough for the 200 ms watcher debounce, `getActiveProfileSlug()` falls back to the still-old config identity. `syncActiveProfile()` then overwrites Account 1 with Account 2's credentials. Reading the same credential hash twice only establishes that the credentials did not change during the read; it does not establish that the config and token belong to the same account.

Reproduction: save synthetic Alice, write only synthetic Bob's tokens, run the watcher sync, then finish the identity update and sync again. Account 1 now contains Bob's access and refresh tokens. The second sync does not repair it because the corrupted slot now exactly matches the live credentials hash. This loses the saved Alice login and can leave the picker showing the wrong account.

Fix direction: do not overwrite a slot using an unverified association between opaque tokens and config identity. Handle login transitions explicitly and verify the account association before committing an automatic refresh. An extra delay alone is not a correctness guarantee.

Origin: inherited identity/sync logic retained by the fork. The intermediate file ordering is documented in the existing source; the reproduction simulates that ordering and does not measure a live Claude login.

### 2. P2 — A stale Update snapshot button can replace a different account

Locations: `src/features/sessions/accountSwitcher.ts:77-90`, `158`, `210-212`; `src/features/account/profiles.ts:629-650`.

The picker computes the active account once when opened. Its Update button is correctly limited to that initial active row, but the click handler never revalidates the account. If a terminal or another window logs into Account 2 while the picker is open, clicking Account 1's existing Update button passes Account 1's slug to `updateProfile()`. That function accepts any existing slot and writes the current live account without checking identity or asking to replace a different account.

Reproduction: save Alice, change the live login to Bob, then invoke the same `updateProfile("account-1")` operation as the stale button. It returns success and replaces Account 1. The review reproduction exercises the handler's underlying operation; the frozen picker state was verified in source, not in a live VS Code window.

Fix direction: validate the stable saved account identity against the current identity at commit time, and reject stale picker actions. Keep intentional account replacement separate from token refresh.

Origin: inherited behavior retained by the fork.

### 3. P2 — Failed rollback deletes the remaining recovery backup

Location: `src/features/account/profiles.ts:885-898`.

After the new config has been installed, a credential-write failure triggers config restoration from `.claude.json.bak`. If that restoration also fails, the exception is swallowed and the backup is deleted anyway. The function reports a generic credential failure while leaving the new identity paired with the previous account's tokens and removing the direct recovery copy.

Reproduction: inject a failure when renaming the live credentials and another when copying the config backup back. Switching Alice from Bob returns failure, the live config says Alice, the live credentials still contain Bob, and the `.bak` file is gone.

Fix direction: preserve the backup unless rollback succeeds; report incomplete rollback distinctly and require recovery before further switching. Startup recovery is also needed to support the existing crash-safety claim, since a process can stop between the separate config and credential writes.

Origin: inherited rollback logic retained by the fork. The test injects two filesystem failures; it does not claim this occurs on every failed switch.

### 4. P2 — An encrypted snapshot update is not a transaction

Location: `src/features/account/profiles.ts:648-677`; individual atomic replacement at `src/features/account/profileVault.ts:102-116`.

The identity file, credentials file, and metadata are committed separately. Atomic replacement of each encrypted file does not make the whole snapshot atomic. If the second write fails, `updateProfile()` reports failure after it has already replaced the identity snapshot. The saved slot contains mixed versions, and there is no rollback or committed-generation marker to distinguish that partial update from a complete one.

Reproduction: update Alice's email and refresh her synthetic tokens, then fail only the encrypted credentials rename. The method returns failure, but the saved identity has changed while the old credentials remain. This particular test demonstrates a partial update within one account; it does not independently demonstrate a cross-account mix-up.

Fix direction: store identity and credentials together in one authenticated envelope, or write a complete new generation and atomically commit a pointer to it. Include metadata consistency in the design.

Origin: the upstream multi-file update design remains nontransactional after the fork's encryption adaptation.

### 5. P2 — Ordinary multi-window startup contention aborts activation

Locations: `src/features/account/profileVault.ts:30-37`; `src/extension/extension.ts:73-79`.

The exclusive `.initializing` marker is held across asynchronous SecretStorage reads/writes. A second window opening the same vault immediately throws on `EEXIST`, even when the first initializer is healthy and about to finish. Activation rethrows the error, so the second window loses the entire Manager extension until retry/reload. The lock is taken on every activation, even with an existing key.

Reproduction: pause one initializer's SecretStorage read, start a second initializer against the same directory, and release the first. The results are one fulfillment and one rejection. This is an isolated initializer contention test, not an Electron multi-window test.

Fix direction: retry live initialization contention asynchronously with a bounded timeout, then reread the stored key. Preserve fail-closed handling for missing keys and genuinely abandoned initialization; do not blindly delete another initializer's marker.

Origin: introduced by the personal fork's vault initializer.

## Verification and limits

- `npm run typecheck`: passed.
- Nine existing focused suites: 146 tests passed. See [existing test output](review/existing-tests.log).
- Five additional safety assertions: all five failed at the expected assertions, reproducing the findings. See [regression test source](../src/features/account/__tests__/accountSafety.test.ts) and [test output](review/test-results.log).
- These review tests have now been promoted into the normal `src/**/*.test.*` collection. From the repository root, reproduce them with `npx vitest run --config docs/review/vitest.config.ts --reporter=verbose`. The original run failed; the maintained regression suite now passes.
- The new tests use temporary directories, synthetic tokens, and an in-memory SecretStorage substitute. They do not read or alter real account credentials. No extension was installed or activated and no actual quota/account transition was attempted.
- The full upstream suite was not rerun during this review. Earlier baseline verification, including known Windows failures, remains documented in `PERSONAL-VERIFICATION.md`.

The earlier passing tests covered normal switching, encryption, tampering and lock refusal, but omitted these identity transitions and failure paths. Passing type checks and normal-path tests is insufficient evidence that this package preserves two real accounts reliably.
