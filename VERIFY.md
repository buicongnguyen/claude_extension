# Verify Claude Code Manager Personal 2.15.5

Install the prebuilt package using the [README](README.md#install). The original Manager must be disabled; the official Anthropic Claude Code extension can stay enabled. Account profiles and keys must be set up again on each machine.

## Build and automated checks

Requires Node.js 20+ and VS Code 1.90+.

```powershell
npx --yes pnpm@11.10.0 install --frozen-lockfile --ignore-scripts
npm run typecheck
npm run check
npm run build
npm test
npm run package:personal
```

The complete Windows suite has 19 known failures matching the unchanged upstream baseline. They are documented in [verification notes](docs/PERSONAL-VERIFICATION.md); they are not hidden or skipped. Tests use synthetic credentials and an isolated home directory.

Before publication, the new source folder passed type checking, the configured lint check, a fresh build and 244 selected tests across 13 files. All 20 packaged build files matched the new build byte for byte. The downloadable VSIX is the previously reviewed package with SHA-256 `9a9b68f7343c3cd131f31603a1259ea165a074f2b0d5c9d3f118bf52800fc883`.

## Manual checks still needed

These steps require your normal Claude login and consume usage when a request is sent. They have not been performed by the automated review.

- Confirm saved accounts switch correctly: close active Claude clients, select a saved account, reload, reopen Claude and check its identity with /status. Repeat for the other account.
- After a usage reset, close the old session and use **Continue task**. Confirm the same history opens in the standalone CLI and the continuation request is submitted. Normal permissions can still pause work.
- Use **Open conversation** to confirm it opens history without sending a request.
- Check the session list, account picker and relevant configuration views in your usual workspace.

See [post-reset behavior](docs/POST-RESET-REVIEW.md) and [account-switch recovery](docs/RESUME-REVIEW.md) for the tested logic and its limits. Custom config directories, remote hosts and live service transitions remain unvalidated.
