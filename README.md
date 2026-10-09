# Claude Code Manager Personal

A personal fork of [Claude Code Manager](https://github.com/vishalguptax/claude-code-manager), based on **2.15.1**, commit `c9a8181c8d2ef5ba25199517c2bde6ff04ef9531`. This fork is **2.15.9**, extension ID `local-personal.claude-manager-personal`. It is not an official Anthropic extension or a release by the upstream maintainer.

It keeps the upstream session browser, account picker, usage display, MCP configuration and other tools. The changes focus on saving two accounts and switching manually between them.

## Wait and auto-continue

Open a conversation in Manager and choose **Wait and auto-continue**. Close the existing Claude chat or CLI for that conversation, then confirm. Manager opens the **same saved conversation in a terminal**, with one continuation request and automatic waiting enabled for that launch only. If usage is already available, work starts immediately.

Requires the native Claude Code CLI **2.1.234 or later** and an eligible Claude subscription session. Keep VS Code and the terminal open, and the computer awake. Reloading or closing VS Code ends this waiting terminal; enable it again afterward. Normal permission prompts can still pause work. Press **Ctrl+C** to cancel a wait, or close the terminal to stop. If waiting is not offered automatically, check **/rate-limit-options** in that terminal.

This does not send into Anthropic's graphical chat panel or change global settings. Managed policy can prevent automatic waiting; API billing has no subscription-reset wait. Long sleep may require Enter, and Claude limits consecutive automatic waits. See [feature and verification details](docs/AUTO-CONTINUE-2.15.8.md).

## Saved account switch logs

After reloading VS Code, account switches automatically save local diagnostic steps. Open **Ctrl+Shift+P → Claude Code Manager: Show Account Switch Log** to see retained attempts, cancellation, recovery, and reload outcomes. The viewer opens a snapshot you can save or copy. Logs contain no account labels, emails, tokens, credential contents or chat text, and are never uploaded automatically. Up to eight 256 KiB files are retained on a best-effort basis. They cannot recover errors from before this upgrade. See [details](docs/ACCOUNT-LOGS-2.15.9.md).

## Changes

- Version 2.15.9 adds persistent account switch diagnostics and a log viewer, and avoids a fallible metadata read after a committed switch.

- Version 2.15.8 adds per-conversation **Wait and auto-continue**, native CLI version checks, literal launch arguments and duplicate-terminal protection.

- Version 2.15.7 protects unsaved accounts before switching, fixes native saving without an open Manager panel, and shows unreadable saved accounts instead of hiding them. See [the account preservation fixes](docs/ACCOUNT-PRESERVATION-2.15.7.md).

- Version 2.15.6 adds fresh credential reads during account changes, a heartbeat that survives blocking operations, protected imports and MCP mutations, and fixes for restored terminals, sibling worktrees and multi-root branch selection. See [the review fixes](docs/REVIEW-FIXES-2.15.6.md).

- Each saved account is one AES-256-GCM encrypted snapshot containing identity, OAuth credentials and display metadata. Replacing it is atomic. The random key is held by VS Code SecretStorage; ciphertext is bound to its profile and filename.
- Encrypted profiles use this extension's own VS Code storage. The original plaintext profile folder is neither imported nor changed automatically.
- Missing keys and unreadable snapshots fail closed. A failed outgoing-account save aborts switching and opening a new login. Writes acquire Claude credential/configuration locks. An encrypted recovery record is saved before live files change; failed rollback preserves recovery data.
- Automatic updates require matching identity and token continuity. If both opaque tokens changed, manual update/switch asks you to confirm the same account. The confirmation is bound to the exact live credentials and saved snapshot, so changes while the dialog is open abort the action. No additional network API is called.
- Vault initialization waits briefly for another window to finish instead of failing immediately.
- Terminal actions open Claude and offer **Copy input**. Paste after Claude's prompt is ready. No prompt or slash command is typed on a timer.
- Working directories use the terminal API, without interpolated `cd` commands. Profile identifiers and linked profile folders are checked.
- Switching offers **Reload window**. The extension refuses to activate alongside the original Manager and is disabled in untrusted and virtual workspaces.

## Install

Download the installer from the [download page](https://buicongnguyen.github.io/claude_extension/) or [GitHub Releases](https://github.com/buicongnguyen/claude_extension/releases). Source: [buicongnguyen/claude_extension](https://github.com/buicongnguyen/claude_extension).


1. Disable or uninstall the original **Claude Code Manager** (`vishalguptax.claude-manager`). Both versions share command/view IDs.
2. Keep Anthropic's official **Claude Code** extension enabled.
3. Run **Extensions: Install from VSIX…** in VS Code.
4. Select the downloaded `claude-manager-personal-2.15.9.vsix` and reload the window. The source copy is in `site/downloads/`; a local build writes to `dist/`.

This installer is distributed through GitHub and GitHub Pages, not the Marketplace. Building does not install it or change your accounts. On another machine, sign in to Claude and save each account again. Account snapshots, vault keys and local settings are not bundled or synchronized.

To verify the installer in PowerShell, use `Get-FileHash .\claude-manager-personal-2.15.9.vsix -Algorithm SHA256` and compare with [SHA256SUMS](site/downloads/SHA256SUMS).

## Your two-account workflow

1. Sign in to account 1 using Claude's normal browser login. Run **Claude Code Manager: Switch Account**, save the current account and label it **Account 1**.
2. Finish active Claude work and close existing Claude terminals/chat tabs. Select **Log in as a new account**. Choose **Copy input**, wait for Claude's prompt, paste `/login`, and sign in to account 2.
3. Save it as **Account 2**.
4. To change accounts, stop active Claude work, close its terminals/chat tabs and select the other saved account. If Manager asks to confirm changed tokens, continue only when you know the current login belongs to that saved account. Local account labels can lag behind a login; cancel if uncertain. Then choose **Reload window**.
5. Reopen Claude and check `/status` or `/usage` to confirm the selected account. If a window reload does not update the login, fully quit and reopen VS Code.

This is manual switching. It does not automatically move a running request when quota is exhausted. It swaps the default local Claude login; existing PowerShell sessions can retain the old login until restarted. API keys, provider settings and other credential overrides can take precedence over a saved subscription login.

## Continue after a usage reset

The Play button now means **Continue task**. It opens the same saved conversation in a terminal with an initial request to continue the interrupted task. It does not change accounts. Wait until usage is available again, close the old Claude chat or exit its CLI for that session, then confirm **Old session closed — continue**. Claude loads the history and submits the continuation; no timed typing or permission-bypass flag is used.

To stay in your existing Claude chat, send **Continue from where you stopped** there. You do not need to close it or change accounts for this manual approach.

**Open conversation** only opens saved history in your configured destination. It does not submit a request. The official extension's [open URI](https://code.claude.com/docs/en/vs-code#launch-a-vs-code-tab-from-other-tools) can prefill a draft but cannot submit it, and its inspected 2.1.289 command ignores prompts for an already open panel. Manager therefore uses the documented [CLI resume-with-prompt invocation](https://code.claude.com/docs/en/cli-reference) for Continue task.

Continue task requires a working standalone `claude` command. If your terminal reports that it is missing, install the CLI before retrying. Claude can still pause for its normal permissions or other input. A real server usage-limit transition has not been tested during this review.

For interactive CLI sessions, current Claude Code also supports [automatic continuation after reset](https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset), beginning with version 2.1.234. That wait belongs to the open session and does not restart merely because you reopen its history. Manager does not change your automatic-continuation setting.

After switching accounts, **Resume after account switch** remains a separate action: close the old client, switch and reload, reopen its history, check `/status`, and submit the continuation yourself. See [the post-reset review](docs/POST-RESET-REVIEW.md) and [earlier recovery review](docs/RESUME-REVIEW.md).

## Storage and limits

Snapshots are in `accounts` inside this extension's `ExtensionContext.globalStorageUri`, normally `%APPDATA%\Code\User\globalStorage\local-personal.claude-manager-personal\accounts` on standard Windows VS Code. New snapshots encrypt labels, emails and display metadata too. Version 2.15.2 encrypted multi-file profiles remain readable and upgrade to the single-file format on update; their old encrypted files and plaintext display metadata are retained, but no longer used once `profile.enc` exists. The extension does not deliberately synchronize the key or snapshots.

Switching restores the selected credentials into **Claude's normal live credential store**. On Windows, that active store remains file-based with user-profile access controls. Encrypted saved copies do not protect against malware running as you or a compromised extension host.

Keep the matching VS Code secret storage: losing its key makes saved snapshots unreadable. Restore the matching storage or sign in again and create a fresh vault. A crash during first initialization can leave an `.initializing` marker; close VS Code before removing only that marker and retrying.

This build targets local desktop use with Claude's default configuration directory. Custom `CLAUDE_CONFIG_DIR`, remote hosts and real subscription quota transitions have not been validated. Token refresh elsewhere may make a saved login stale and require another browser login. Claude's credential-file format and locking behavior are implementation details, not a promised third-party account-switching API.

An interrupted switch is checked on activation and before another switch. Recovery finishes a known committed state or restores the previous state. It preserves recovery data and stops account writes if a later, unrelated login is detected. The recovery backup is `~/.claude.json.manager-personal.bak`; the encrypted journal is `.switch-recovery.enc` inside the vault. Do not delete recovery files to bypass an error.

The fork reads tokens to save/switch accounts. Its changes add no telemetry or token-upload client. Existing browser links and Claude itself can access the network. This is a focused security improvement, not a complete audit of upstream code or dependencies.

## Build and verify

Requires Node.js 20+ and VS Code 1.90+.

```powershell
npx --yes pnpm@11.10.0 install --frozen-lockfile --ignore-scripts
npm run typecheck
npm test
npm run package:personal
```

Tests use synthetic accounts and an isolated home directory. See [fix and second-review notes](docs/REVIEW-FIXES.md) and [verification notes](docs/PERSONAL-VERIFICATION.md), including known upstream Windows test failures and the latest documentation check.

The original README is preserved in [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md); its storage and automatic terminal-input descriptions do not apply to this fork. Original work is by Vishal Gupta and contributors, under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
