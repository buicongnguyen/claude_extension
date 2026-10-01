# Resume after a usage limit — review and fixes, 2.15.4

Scope correction: the user later confirmed that Play reopened history but did not continue after the same account's reset. See [the 2.15.5 post-reset review](POST-RESET-REVIEW.md). The account-switch recovery below was insufficient for that specific case.

Reviewed on 2026-10-01 after the user reported that Manager's Resume button did not work after Claude's usage limit. Account switching itself is still manual.

## Findings and changes

1. **An existing official chat is reused.** Static inspection of the installed official Claude Code extension 2.1.285 confirmed that opening a known session reveals its existing panel. This cannot force fresh authentication or continue generation. The new **Resume after account switch** detail action explicitly requires closing the old client and switching accounts first, then starts `claude --resume <same-id>` in a fresh terminal. It asks the user to verify `/status` and submit a continuation request. Repeated clicks while confirmation is pending are coalesced; cancellation launches nothing.
2. **Failed chat handoffs were ignored.** Resume now checks the handoff result and offers a visible terminal fallback on rejection or refusal. Current-window handoffs prefer a capability-probed, awaitable official command; cross-window calls retain the URI fallback. These command interfaces are private and need rechecking after official-extension upgrades. URI acceptance alone does not prove that a chat appeared.
3. **View assumed every live client was a terminal.** A live official chat without a registered terminal now routes to the official chat. Tracked terminals retain precedence. Bulk restore uses the same View helper.
4. **Exited or failed commands stayed registered.** The registry now follows shell execution completion and clears only the matching terminal/execution binding. Old completion events preserve newer bindings. Stale SessionStart hook entries cannot revive a completed binding, including after unrelated shell commands. Genuine fresh Claude commands allow registration again. This depends on shell integration and observing the execution start; closing the terminal is the fallback when that evidence is unavailable.
5. **Queued launch outlived the terminal.** Closing a terminal while launch waits for shell integration now cancels the queued command and timer.
6. **Switch & Resume depended on incompatible shell syntax.** Git checkout now runs asynchronously with arguments, without shell interpolation. Claude starts separately only after checkout succeeds, supporting PowerShell 5.1 and cmd.exe. Invalid session IDs are rejected before shell interpolation.

## Verification

- Four failing reproductions were established before their fixes: ignored false handoff, rejected handoff, View of a live official chat, and a command sent after terminal close.
- **235 focused tests passed across 11 files**, including fresh recovery cancellation, history preservation, protocol/host/UI wiring, pending duplicate clicks, wrong-project handling, command completion/failure, stale hook suppression, replaced execution identity, quoted CLI paths and branch checkout success/failure.
- Full suite: **3,837 passed / 19 failed across 293 files**. File and test-name comparison found exactly the same 19 failures as 2.15.3 and its upstream Windows baseline; no new failures.
- TypeScript and the configured Biome check passed. Extension, webview and CSS builds and the 2.15.4 VSIX were generated and inspected.
- A separate final code/logic review found no remaining blocker in the changed recovery flow.

Evidence: `review/full-resume-tests.json`, `review/full-resume-tests.log`, `review/resume-baseline-comparison.json` and `review/package-resume.log`. Only the review document is included in the VSIX; test logs and fixtures are excluded.

## Practical limits

The new installer was not installed or activated during verification. Tests use synthetic accounts and isolated home directories. Real credentials and session contents were not accessed, and a real server usage-limit/account-switch transition remains untested. Existing environment/API/provider overrides can change which login Claude uses, so `/status` verification remains necessary. No token upload or new runtime network client was added.

Terminal recovery requires the standalone Claude Code CLI. The official [VS Code guide](https://code.claude.com/docs/en/vs-code) distinguishes the extension's bundled chat CLI from CLI installation for terminal use. A fresh process loads its login anew, but does not reset account quota, retry a request automatically, or establish that the selected account has remaining usage.
