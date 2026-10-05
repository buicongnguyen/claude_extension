# Wait and auto-continue — 2.15.8

The new conversation-detail action resumes the same saved session in an interactive terminal and submits one fixed continuation request. A per-invocation setting enables Claude's native usage-limit waiting. When usage is already available, the request starts immediately.

## Use

1. Install this VSIX and reload VS Code. Install the native Claude Code CLI, version 2.1.234 or newer, on this machine.
2. Open the conversation in Manager, choose **Wait and auto-continue**, close its old Claude chat or CLI, and confirm.
3. Keep VS Code and the waiting terminal open and the computer awake. Check the terminal for sign-in, trust or permission prompts. Use **/rate-limit-options** if Claude offers a manual wait instead.
4. Press **Ctrl+C** to cancel a wait. Closing the terminal stops that client. Reopening the conversation does not restore an expired/cancelled wait; enable it again explicitly.

The action hands the conversation to a terminal. It does not control Anthropic's graphical chat input. It does not switch accounts, enable extra usage, purchase tokens or modify global settings.

## Design and limits

- The host looks up the selected session, verifies workspace trust and its folder, and retains existing branch/worktree routing. A confirmation explains immediate execution and unattended continuation.
- Native CLI discovery checks the user install and absolute PATH entries. The same resolved native executable is version-checked and launched with an argument array, not a PowerShell/cmd command string. npm command shims are deliberately unsupported by this launcher.
- The launch uses --resume, invocation-only --settings with autoContinueAtUsageLimit: true, and --permission-mode default. Existing permissions and managed policy remain effective. No keystroke timer or Manager quota scheduler is involved.
- The waiting terminal opts out of VS Code terminal persistence: reload or restart ends it, preventing the initial prompt from being replayed automatically. Enable it again explicitly after reload.
- The user controls cancellation in the CLI. A repeated click focuses the existing terminal; it does not submit another turn. This is a per-session opt-in, not a persistent schedule.
- Claude subscription eligibility is determined by Claude. API-key billing, some model-specific limits, remote/background modes, policy restrictions and resets over 24 hours may not automatically wait. A long sleep can require Enter, and Claude stops after its documented consecutive-wait limit.

## Official references checked 2026-10-06

- [Interactive usage-limit waiting](https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset)
- [CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags)
- [Setting reference](https://code.claude.com/docs/en/settings-reference#autocontinueatusagelimit)
- [VS Code native terminal options](https://code.visualstudio.com/api/references/vscode-api#TerminalOptions)

## Validation

Tests use mocked VS Code terminals, synthetic CLI responses and isolated fixtures. No real conversation continuation or usage-reset transition is triggered by development tests. See [the validation summary](VALIDATION-2.15.8.json) for final automated results.
