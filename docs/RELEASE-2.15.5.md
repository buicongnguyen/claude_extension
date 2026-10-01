# Claude Code Manager Personal 2.15.5

This Apache-2.0 personal fork adds encrypted saved-account snapshots, manual switching safeguards and explicit task continuation after a usage reset. It is based on upstream Claude Code Manager 2.15.1.

## Install

1. Download the VSIX attached to this release.
2. Disable or uninstall the original Claude Code Manager; the two Managers share command and view IDs. Keep the official Anthropic Claude Code extension enabled.
3. In VS Code, run **Extensions: Install from VSIX…**, select the file and reload.
4. On a new machine, sign in and save your two accounts again. Saved accounts and keys are not included in this download.

Play / **Continue task** resumes the same history and sends a continuation prompt through the standalone Claude CLI after you confirm the old session is closed. **Open conversation** only opens history.

## Verification

274 focused checks passed; the full Windows suite had 3,854 passed and the same 19 upstream baseline failures. Type checking, configured lint, builds and package inspection passed. The published source folder also passed 244 selected tests and a fresh build; all 20 packaged build files matched that build byte for byte. Live service account transitions and a real usage-limit reset have not been tested.

SHA-256 of the attached VSIX:

```text
9a9b68f7343c3cd131f31603a1259ea165a074f2b0d5c9d3f118bf52800fc883
```

Source and installation details: https://github.com/buicongnguyen/claude_extension
Download page: https://buicongnguyen.github.io/claude_extension/

Unofficial fork; original work by Vishal Gupta and contributors. See LICENSE and NOTICE.
