# Same-account task continuation after usage reset — 2.15.5

The user clarified that usage had already reset on the same account. Clicking Manager's Play button opened the previous conversation, but it stayed stopped. The 2.15.4 account-switch recovery did not address this specific behavior.

## Confirmed cause

Ordinary Resume invoked `claude --resume <id>` or opened the official extension's conversation with no continuation prompt. That restores history but does not submit a request. A regression reproduced the missing request before the fix: expected resume plus initial continuation, received bare resume.

Static review of installed official extension 2.1.285 found no registered submit/retry/continue command. Its existing-panel open path reveals the panel and ignores a supplied prompt; new-panel/sidebar prompts are drafts. Anthropic's [VS Code URI guide](https://code.claude.com/docs/en/vs-code#launch-a-vs-code-tab-from-other-tools) also describes prefill rather than submission. Passing a prompt to this interface cannot fix the reported existing-chat case.

## Changes

- Row Play and detail **Continue task** send an explicit continuation flag through the validated protocol and host dispatcher.
- After the user confirms the previous client is closed, Continue task launches `claude --resume <same-id> "Continue the interrupted task from where you stopped. Check existing progress before repeating any actions."`. The [CLI reference](https://code.claude.com/docs/en/cli-reference) documents resuming with an initial prompt. Claude receives it after loading history; Manager never types it into a terminal on a readiness guess.
- **Open conversation** remains a history-only action using the existing destination preference. Live View and account-switch recovery remain separate.
- Continuation requires the correct project and an available worktree. The fixed prompt uses shell-safe ASCII text; session ID validation and argument-based Git checkout are retained. Checkout failure stops the launch. A shared pending guard prevents duplicate dialogs across continuation and account recovery. Conflicting protocol flags are rejected.
- Manager does not switch accounts or alter Claude's native auto-continue setting for this action. It adds no runtime network client or permission-bypass flags.

## Verification

- **274 focused tests passed across 13 files**, including the actual list Play click, detail actions, exact protocol/host routing, the submitted CLI prompt, cancellation, duplicate clicks, project/worktree restrictions and existing recovery paths.
- Full suite: **3,854 passed / 19 failed across 293 files**. Failing file/test identities exactly match 2.15.4 and the original Windows baseline; no new failures.
- TypeScript, configured Biome, builds and 2.15.5 VSIX packaging/inspection passed. An independent code/logic review found no blocker in the new continuation path.
- Evidence: `review/full-post-reset-tests.json`, `review/full-post-reset-tests.log`, `review/post-reset-baseline-comparison.json` and `review/package-post-reset.log`.

Tests are synthetic and isolated. No real credentials or conversations were read, no real Claude request was sent, and the new installer was not activated. Live server quota reset and continuation remain untested. Continue task uses the standalone CLI and its resolved login/configuration; environment/provider overrides can differ from the official chat. Normal permissions or other Claude input can still pause the task.

## Existing-chat workaround

After usage resets, send **Continue from where you stopped** in the existing Claude chat. For interactive CLI sessions, [native automatic continue](https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset) requires v2.1.234+ and keeping the waiting session open. Ending or cancelling the wait, exiting, or resuming another conversation can stop that wait; reopening history alone does not restore it.
