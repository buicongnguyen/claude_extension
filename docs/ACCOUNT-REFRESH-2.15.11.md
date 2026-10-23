# Account refresh and switching — 2.15.11

The October 23 local logs showed committed account-file swaps followed by Claude OAuth refresh HTTP 400 and usage HTTP 401. That establishes a local switch followed by authentication failure, not the reason the server rejected the token. The earlier ambiguous-token guard did not simply disable switching: the logs show confirmation and committed switches.

## Changes

- Background snapshot syncing attempts busy credential locks once and yields immediately. It does not reclaim an existing lock, including one whose timestamp looks old. Manual operations retain their existing lock coordination.
- Credential and identity file events schedule up to three snapshot attempts (200 ms, then 1 s and 2 s after failures). Settings/statistics changes only refresh the display. Disposal cancels pending attempts in both modes.
- A full opaque-token replacement is checked before acquiring background locks. It still requires explicit identity confirmation to avoid overwriting account A with account B during login.
- The Account tab and picker show when the current credentials differ from the saved active snapshot. Open saved accounts, verify the account in Claude, then use the active row's Update snapshot button.
- Inactive profiles last saved at least six hours ago show a reminder. This is snapshot age, not proof of the last sign-in or token expiration. Missing/invalid timestamps cannot establish an age, and future timestamps do not warn.
- Local switch completion refreshes Manager immediately, before waiting for the optional reload notification. The message says that the saved login was restored and Claude still needs to accept it.

## Recovery for a rejected saved login

Stop active Claude work before switching. Restore the intended account and, if Claude requests authentication, sign in through Claude's normal login flow. Verify the actual account, then open Manager's account picker and update its snapshot. Confirm same account only after checking it; local labels can be stale. Restart other Claude clients that were using the old shared login.

No automatic window reload, token-refresh request, keep-alive request, or synthetic task is added. Manager cannot repair a revoked refresh token or guarantee a server will accept a saved login. Six-hour reminders do not prevent usage-limit stops.

Official authentication guidance: https://code.claude.com/docs/en/authentication
