# Large-history performance fixes — version 2.15.10

The reported machine had repeated extension-host restarts, out-of-memory crash dumps, and CPU profiles identifying Manager's synchronous transcript decoder/history scanner. The largest saved transcript was 471 MiB; the corpus was about 3.7 GiB. These observations establish Manager's stalls and the host's memory crashes, but do not prove Manager caused every failed allocation among all installed extensions.

## Default: account-focused mode

The new default is account switching with Profile and Quota. History scanning, background search indexing, detailed usage aggregation, native CLI model scanning, session-process polling and session-tap synchronization are skipped. Only account/settings/credential and local-quota watchers are registered. The Account tab opens automatically and detailed usage charts are hidden. Saving profiles, switching, reload choices and switch logs keep working.

The setting **Claude Manager: Account Focused Mode** defaults to true. Disable it and reload VS Code to restore full history features. Detailed usage remains expensive in full mode; account-focused mode is recommended for this large-history machine.

## Full-mode parser safeguards

- All interactive session listing, targeted refresh, detail preview, Markdown copying, indexing and transcript searching run in one background worker with a separate V8 heap limited to 256 MiB (plus a 16 MiB young generation). This limit is not a whole-process/native-memory ceiling.
- Worker errors, exits and 60-second request timeouts reject pending work and terminate that worker. There is no fallback that performs the failed scan in the extension host. A later request can create a new worker. Pending work is bounded to eight jobs; repeated pending full refresh/index jobs coalesce.
- UTF-8 line decoding accumulates bounded fragments and joins once per line, avoiding repeated concatenation/splitting of a growing partial record. JSONL records over 1 MiB are skipped through their newline. Search byte offsets include skipped bytes, so later messages remain searchable.
- Preview parsing iterates records instead of retaining the transcript. It keeps the first/latest 50 usable messages or at most 200 query matches, while counting all usable records/matches and aggregating their usage. Text and thinking previews are limited to 32 KiB each, with at most 100 tool rows per message. A visible notice explains limited previews.
- The full-text index is limited to 32M characters across sessions. Oldest entries can be evicted; search results cover retained index entries and their streamed tails. Session-list prompt/search text sent to the host has a shared 4M-character budget per response, alongside smaller per-field caps. Full-text search remains available for retained indexed sessions.
- A conversation containing only oversized records remains visible with a preview-unavailable label. Source transcripts are never truncated, rewritten or deleted. Open the conversation in Claude or export its original JSONL for complete content.

## Install

Install the new VSIX, then run **Developer: Reload Window** once. Version 2.15.9 remains loaded in an existing extension host until that reload. Do not enable the original upstream Manager alongside this fork.

## Verification

The test suite uses synthetic accounts and temporary homes. The repeatable stress script is scripts/verify-session-worker.cjs and must run after npm run build. It creates a synthetic transcript, starts the real worker through the production client, checks listing/detail/search after an oversized record, measures main-process responsiveness and heap use, then removes its own temporary directory. It does not inspect the user's conversations or credentials.

A final synthetic stress run with a 512 MiB oversized record completed listing, preview, indexing and search in 337 ms. Main-process maximum heartbeat gap was 24 ms, its heap was 6 MiB, and measured peak process RSS (including the worker) was 97 MiB. These measurements use an isolated Node process, not the running VS Code host.

Full results and the exact known Windows failure identities are in [validation](https://github.com/buicongnguyen/claude_extension/blob/main/docs/VALIDATION-2.15.10.json). Real VS Code stability after activation still needs observation; the change cannot guarantee that another extension will never run out of memory.
