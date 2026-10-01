# Review fixes for 2.15.6

This personal release addresses the twelve issues confirmed in the October 2026 code and logic review. It preserves manual account switching and explicit task continuation.

| Reviewed issue | Change | Regression evidence |
| --- | --- | --- |
| PowerShell injection through MCP names | Authentication and logout validate names at the host boundary; shell metacharacters and leading option markers are rejected. | Rejected malicious and option-like names; valid login/logout commands remain usable. |
| Unreadable credentials treated as absent | Mutation and recovery use a three-state credential result and stop on unknown/transient reads. | Denied Keychain and unreadable authoritative-file fixtures preserve live credentials and journals. |
| Cached macOS credentials saved during switching | Account mutations bypass the UI cache after acquiring locks. | Rotated credentials are read afresh; stale confirmations abort. |
| Blocking work stops heartbeat; old holder removes new lock | A separate Node worker maintains directory freshness during blocking I/O and acquisition waits. Release checks the owned filesystem generation and awaits worker shutdown. | A real independent process cannot reclaim a blocking writer; replacement directories survive; repeated multi-lock acknowledgements succeed. Minified production code also passed a real-process check. |
| Brain MCP merge clobbers a concurrent account | The complete merge reads and writes under the Claude config lock. | A competing process's newer identity and unrelated server remain intact. |
| Broken live config erased by import | Only a genuinely missing config may be initialized. Invalid or unreadable config causes a refusal. | Malformed JSON and non-object/config-shape fixtures remain unchanged in preview/import. |
| Brain archive can write arbitrary files | Export, preview and import share the same portable settings/skills/commands/agents/memory allowlist. | Credential, repository-hook, traversal, alternate-stream and Windows alias paths are rejected. |
| Junctions redirect archive writes outside the destination | Existing roots, ancestors and targets are checked for links/junctions and invalid file types. | Real Windows junction fixtures are excluded from import, preview and export. |
| Play rejects a sibling worktree offered by the UI | Same-repository sibling checkouts are accepted and launched in their own terminal working directory. | A sibling worktree receives the saved session and continuation request; unrelated projects remain guarded. |
| Restored terminal stays marked active after ending | Execution-end handling removes restored bindings even when the start event was missed, with generation protection. | Restored endings re-enable continuation; old events cannot clear newer executions. |
| Hook PID does not identify the terminal shell | The hook resolves process ancestry, records the Claude PID separately, and matches terminal ancestors. The watcher checks Claude liveness and periodically removes stale advisory bindings. | Windows/macOS/Linux ancestry fixtures, hook subprocess integration and watcher liveness/PID-reuse cases. |
| Branch selected from the wrong repository | Branch lookup selects the repository containing the actual working directory. | Multi-root and nested-repository fixtures choose the matching repository. |

Related fixes: new global MCP additions use canonical `~/.claude.json`; global add/update/delete share the config lock and preserve malformed config. Atomic writes use random exclusively created sibling temporary files and owned descriptors, preserving existing file permissions.

Process discovery also recognizes native executables in the runtime home's Claude version store; version-based binary names have been [reported in Anthropic's tracker](https://github.com/anthropics/claude-code/issues/87199). Linux process timestamps use the documented [start-time field and clock-tick conversion](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html), rather than directory modification time. Lifecycle checks use execution and process identity so delayed events or temporary registry failures cannot permanently suppress a distinct live session.

## Validation

Validation results are recorded in [PERSONAL-VERIFICATION.md](PERSONAL-VERIFICATION.md). Tests use synthetic accounts and temporary isolated home directories. No real account credentials or real Claude requests were used.

The suite retains the documented upstream Windows failures. The review does not establish a live server quota-reset transition or real macOS Keychain interaction. Credential file formats and directory locks remain Claude implementation details.

## Installation

Download `claude-manager-personal-2.15.6.vsix` from [GitHub Pages](https://buicongnguyen.github.io/claude_extension/) or [GitHub Releases](https://github.com/buicongnguyen/claude_extension/releases/tag/v2.15.6). In VS Code choose **Extensions: Install from VSIX…**, select the file and reload the window. Keep only this Manager fork enabled; retain Anthropic's official Claude Code extension.

After an allowance reset, close the previous client for the conversation and select **Continue task**. This submits a continuation through the standalone Claude CLI. **Open conversation** opens history without submitting a request.
