# Saved account switch logs — version 2.15.9

After installing the VSIX, run **Developer: Reload Window** once to activate the upgrade. Logging starts automatically on activation; it cannot reconstruct older unlogged attempts.

## Open or share a log

1. Try the account switch as usual. Close old Claude clients first and verify the selected account afterward.
2. Press **Ctrl+Shift+P** and run **Claude Code Manager: Show Account Switch Log**. Failed switches also offer **Open switch log**.
3. The editor contains a snapshot of retained log records. Copy it or use Save As if you want to share it. Nothing is uploaded automatically.

Logs belong to the VS Code installation or remote extension host running Manager. Another PC has its own logs. They are stored under the extension's global storage logs directory, separate from encrypted profiles; a typical local Windows path is %APPDATA%/Code/User/globalStorage/local-personal.claude-manager-personal/logs.

## Recorded information

Each record has a UTC timestamp, extension version, random operation ID, action, event name, and optional fixed stage/reason/error code. No account labels, identifiers, hashes, emails, credential contents, tokens, paths, error messages, stacks or chat text are recorded. Unknown fields and values are discarded at runtime. The viewer revalidates stored records before displaying them.

The accepted switch handler records confirmations, cancellation, saving the outgoing login, backend refusal, transaction steps, recovery, and reload choice. Startup recovery is logged too. A single operation ID connects async confirmation and backend steps. Selecting the already-active account can update only its saved snapshot.

**operation_completed / local_operation_succeeded** means local processing succeeded. Backend verification with reason **committed** distinguishes a verified live swap; reason **restored** means rollback verified the old login. Cleanup or lock failures can follow a commit, so inspect the preceding stages. None of these events proves remote token validity or that an existing Claude client restarted. Reload or panel failures are recorded separately from the successful local operation.

The log does not capture all Claude output or all Manager actions. Closing the account picker before selecting an account does not start a switch log. New browser sign-ins and standalone snapshot edits are not audited by this feature.

## Storage and failure handling

Each extension-host activation writes a separate file, rotated before 256 KiB. Retention targets at most eight files (about 2 MiB) across activations and windows. Files use restrictive modes where supported; normal Windows user-directory permissions apply. Sharing violations or disk errors can prevent cleanup or recording. Logging then stops without affecting credentials, and the viewer reports recording as unavailable. Old records can rotate out.

Records are appended synchronously before a requested window reload. This is a diagnostic log, not a transactional database or a guarantee against power-loss data loss. The implementation never follows log-file symlinks in the viewer. Malformed or unreadable records produce a generic notice.

## Verification

Synthetic tests cover privacy filtering, history across reinitialization, rotation, concurrent operations, IO failures, cancellation, switch/recovery stages, detached event errors and success before reload. Real user credentials are not read or changed by tests. See [automated validation](https://github.com/buicongnguyen/claude_extension/blob/main/docs/VALIDATION-2.15.9.json).
