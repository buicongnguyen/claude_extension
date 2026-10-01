Claude Code Manager Personal 2.15.6 fixes the twelve issues found in the latest review.

Account switching now reads fresh credentials and stops safely when their store cannot be read. Locks stay fresh during blocking operations and preserve another writer's replacement lock. Brain imports restrict destinations and preserve malformed settings. MCP authentication rejects unsafe names, and global settings changes serialize with account changes.

Task continuation now supports sibling worktrees, clears ended restored terminals, matches the terminal through process ancestry, and selects the branch for the correct workspace.

Install the attached VSIX with **Extensions: Install from VSIX…**, then reload VS Code. Disable the original Manager and keep Anthropic's official Claude Code extension enabled.

See [the review and validation](https://github.com/buicongnguyen/claude_extension/blob/main/docs/REVIEW-FIXES-2.15.6.md). Tests use synthetic accounts; a live quota reset has not been verified. This is an unofficial personal fork under Apache-2.0.
