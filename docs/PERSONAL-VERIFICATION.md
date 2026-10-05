# Personal fork verification

## Version 2.15.8 — wait and auto-continue

The conversation detail action now hands the same saved session to an interactive native CLI with invocation-only automatic waiting enabled. It requires a trusted open project, supported CLI version and explicit confirmation. Native argv avoids shell quoting, default permissions remain active, duplicate clicks focus the existing terminal, and terminal persistence is disabled to prevent prompt replay after reload. See [feature details](AUTO-CONTINUE-2.15.8.md).

- Final full suite: **4,057 passed / 19 failed** (4,076 tests, 302 files). Failed identities match all 19 known upstream Windows failures from 2.15.7 exactly; no new failures and no missing baseline failures. See [validation](VALIDATION-2.15.8.json).
- Sixty-two added regressions cover protocol/UI, host cancellation/trust/project routing, native version discovery, literal arguments, terminal lifecycle and restored process mapping.
- Two unrelated parser fixture failures reproduced independently; clearing caches between recreated test folders fixed the test isolation issue. Production parser code is unchanged.
- TypeScript, configured Biome and extension/webview/CSS builds passed. This machine's native CLI reports 2.1.288, above the required 2.1.234.
- Tests use isolated fixtures and mocked terminal launches. No real Claude requests, credentials, account switches or live quota resets were exercised.

## Version 2.15.7 — account preservation and terminal login

Saved-account disappearance and native CLI launch paths received another code and logic review. See [ACCOUNT-PRESERVATION-2.15.7.md](ACCOUNT-PRESERVATION-2.15.7.md) and [the validation summary](https://github.com/buicongnguyen/claude_extension/blob/main/docs/VALIDATION-2.15.7.json).

- Final full suite: **3,995 passed / 19 failed** (4,014 tests, 300 files), exactly the same 19 known upstream Windows failures as version 2.15.6. There are no new failures and no missing baseline failures.
- Thirty-nine new regression cases cover outgoing-account preservation, identity conflicts, inaccessible config, encrypted listing diagnostics, native saving without a panel, picker freshness, and standalone CLI terminal environment handling.
- TypeScript, configured Biome (131 files), extension/webview/CSS builds and VSIX packaging passed. Saved-account encryption and key format remain unchanged.
- On the reported machine, the existing standalone CLI at ~/.local/bin/claude.exe reports version 2.1.288. Its missing user PATH entry was corrected without reinstalling Claude. Manager terminal environment handling is separately tested with synthetic filesystem and PATH inputs.
- No real account switch, SecretStorage key read, browser login, Claude request or usage-reset transition was performed.

## Version 2.15.6 — code and logic review fixes

The twelve confirmed review issues and related regression findings are repaired. See [REVIEW-FIXES-2.15.6.md](REVIEW-FIXES-2.15.6.md) for the changes and [the validation summary](https://github.com/buicongnguyen/claude_extension/blob/main/docs/VALIDATION-2.15.6.json) for the failing file/test identities.

- Final complete suite: **3,956 passed / 19 failed, 3,975 tests across 298 files**. A comparison of file and test names matches all 19 failures from the 2.15.5/upstream Windows baseline, with no new or missing failed identities. No tests were skipped to achieve this result.
- Command: `npx vitest run --maxWorkers=2 --testTimeout=15000 --reporter=json`. The timeout allowance accommodates large Windows filesystem fixtures; the new lock and process integration cases keep their explicit bounds.
- TypeScript, configured Biome (131 files), extension/webview/CSS builds and version 2.15.6 VSIX packaging/inspection passed. Installer runtime bundles match the verified build; private stores, account snapshots, tests and source maps are excluded.
- Regression checks cover real temporary lock contenders and competing config writers, Windows junctions, a native Windows fake-CLI-to-hook subprocess chain, and mocked credential/Keychain and Linux/macOS process metadata.
- Combined checks caught outdated atomic-write filesystem mocks and additional terminal lifecycle cases; their fixes are included in the final suite. Independent source review also checked account transactions, worker ownership/release, imports/MCP writes and terminal process generations.
- No real Claude credentials, conversations or requests were used; the installer was not activated. Live server quota resets, real account transitions and real macOS Keychain interaction remain unverified.


## Version 2.15.5 — actual task continuation after reset

The user's clarified case was a stopped task on the same account after its reset. Play formerly only opened history. It now requests explicit continuation in a terminal, while Open conversation retains history-only behavior. See [the post-reset review](POST-RESET-REVIEW.md).

- **274 focused checks passed across 13 files.**
- Full suite: **3,854 passed / 19 failed across 293 files**, with exactly the same failed file/test identities as 2.15.4 and the upstream Windows baseline; no new failures.
- TypeScript, configured Biome, builds and version 2.15.5 VSIX packaging/inspection passed.
- Package: `dist/claude-manager-personal-2.15.5.vsix`. Evidence: `docs/review/full-post-reset-tests.json`, `full-post-reset-tests.log`, `post-reset-baseline-comparison.json` and `package-post-reset.log`.
- No real Claude request was sent, no real credentials or conversations were read, and the new installer was not activated. A real quota-reset transition remains untested.


## Version 2.15.4 — Resume recovery review

See [the Resume review](RESUME-REVIEW.md) for the current changes and limits. New recovery opens the same history in a fresh terminal after the user closes the exhausted client and switches accounts. Ordinary Resume remains a history/open action. Failed handoffs, live-chat View routing, stale terminal tracking, cancelled queued launches and Windows branch checkout were repaired.

- **235 focused tests passed across 11 files.**
- **3,837 passed / 19 failed across 293 files** in the complete suite. Comparison confirms exactly the same failing file/test identities as 2.15.3 and the original Windows baseline; no new failures.
- TypeScript, configured Biome, builds and version 2.15.4 VSIX packaging/inspection passed.
- Package: `dist/claude-manager-personal-2.15.4.vsix`. Test evidence: `docs/review/full-resume-tests.json`, `full-resume-tests.log`, `resume-baseline-comparison.json` and `package-resume.log`.
- The new package was not installed or activated. Tests use isolated synthetic data; real usage-limit transitions and account-switch authentication were not exercised.

The sections below preserve earlier verification history.

## Version 2.15.3 — review fixes and second pass

The five account-safety findings in the 2.15.2 review are fixed; see [implementation and second-review notes](REVIEW-FIXES.md). Full opaque-token replacement now requires explicit same-account confirmation rather than trusting cached identity. Confirmations are bound to the exact live and saved state. Snapshots commit identity, credentials and metadata together, live switches retain encrypted recovery data until consistency is verified, and vault startup retries temporary contention. Opening a new login also preserves the outgoing account first.

Final validation for 2.15.3:

- **179 focused checks passed across 13 files**, including the five original reproductions and 13 additional safety/UI cases.
- **3,802 passed / 19 failed across 293 files** in the final full suite. A programmatic comparison of file and test names confirms these are exactly the same 19 failures as unchanged upstream, across the same six files. No new failing test identities.
- TypeScript checking, the configured Biome check, extension/webview/CSS builds and local VSIX packaging passed.
- Package: `dist/claude-manager-personal-2.15.3.vsix`. The final package manifest and bundled safety logic were inspected. The package contains no tests, review logs, saved account files, source maps or node_modules.
- Evidence is retained in the source repository under `docs/review/`: `fix-tests.log`, `full-fix-tests.json`, `baseline-comparison.json`, and `package-fix.log`. The final archive inspection is in `dist/package-inspection.json`.

The extension was not installed or activated. No real account credentials were accessed. Tests use synthetic credentials and isolated home directories. Real browser login, server token refresh, quota transitions, custom config directories and remote hosts remain untested.

The sections below preserve the original 2.15.2 documentation check and baseline history.


Date: 2026-09-30. Upstream base: 2.15.1 / c9a8181c8d2ef5ba25199517c2bde6ff04ef9531.

## Current compatibility evidence

- [Claude authentication documentation](https://code.claude.com/docs/en/authentication#credential-management), checked 2026-09-30, still places Windows logins in `%USERPROFILE%\.claude\.credentials.json`. `CLAUDE_CONFIG_DIR` changes the store location. The fork retains the default-store approach rather than moving the live login into its encrypted vault.
- [VS Code SecretStorage documentation](https://code.visualstudio.com/api/extension-capabilities/common-capabilities#data-storage) describes encrypted, non-synchronized storage using Electron safeStorage on desktop. The fork keeps its vault key there.
- [Another account switcher's own documentation](https://github.com/KrzysztofZander/claude-account-switcher) describes replacing the live credential file and reloading VS Code. This corroborates the approach; it is not an Anthropic support guarantee or a live test of this fork.
- [Anthropic issue 84267](https://github.com/anthropics/claude-code/issues/84267), reported 2026-08-05 against macOS extension 2.1.221/222, describes custom-config login trouble and a CLI-login/full-restart workaround. It does not establish a current Windows failure; custom config directories remain outside this fork's tested scope.
- [Anthropic issue 56339](https://github.com/anthropics/claude-code/issues/56339), reported 2026-05-05 against macOS 2.1.116, describes concurrent token refresh races. This motivates closing active sessions and coordinating credential writes, not a claim that every later release has that same bug.
- [Current upstream release](https://github.com/vishalguptax/claude-code-manager/releases/tag/2.15.1) was published 2026-09-19 and was still the latest release returned by GitHub on 2026-09-30.
- Claude Code's [authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence) means API keys, cloud providers and other overrides can bypass the saved subscription login. Verify the selected account in `/status` or `/usage` after switching.

Conclusion: current documentation and implementations support the design for default local credentials. There is no official promise that a third-party snapshot swap will remain compatible across Claude updates. Actual browser login, live token refresh and consumption of the two accounts' subscription allowances have not been exercised.

## Validation approach

The test harness isolates the home directory so tests and activation background jobs do not target real account files. Dedicated tests use synthetic access/refresh tokens in temporary directories. The real encryption and profile-switching code is exercised together; VS Code SecretStorage itself is represented by a fake secret store.

Coverage includes ciphertext on disk, restoring with the original key, fresh nonces, tampering, cross-profile substitution, plaintext refusal, unavailable storage, lost keys, initialization contention, two-account switching, outgoing-token refresh, corrupted targets, path traversal, credential-lock contention, and terminal input ordering without shell integration.

The original upstream profile tests additionally exercise the existing account logic with a transparent storage adapter; they are supplemented, not replaced, by real encrypted-storage tests.

## Baseline Windows failures

The full unchanged upstream suite, using the same isolated-home harness and dependency versions, produced **3,765 passed / 19 failed** across 288 files. The first complete fork run before the final locking regression produced **3,783 passed / the same 19 failed** across 291 files. The failing test identities match exactly.

The 19 baseline failures are in checkpoint parsing/message handlers, memory parsing/deletion, managed-settings path handling, and worktree recreation. Several assume POSIX path separators or permissions. They were not hidden or marked skipped. This fork is not presented as having a completely passing upstream suite on Windows.

For 2.15.2, final targeted tests: **146 passed across 9 files**. Final full suite: **3,784 passed / 19 failed across 291 files**, with exactly the same 19 failure names as the unchanged upstream baseline. TypeScript checking, extension/webview/CSS build, and the repository's configured Biome check pass. Three pre-existing import/format diagnostics were corrected without changing feature behavior. Packaging is performed locally, without installing the extension or publishing it.

## Live validation still needed

After installing the VSIX, sign in and save both accounts, stop active Claude work, switch to account 1, reload and inspect Claude's account identity. Repeat for account 2, then back to account 1. A successful model request under each selected identity verifies the live service side that local synthetic tests cannot establish. Do not rely only on the Manager's own active-account label.
