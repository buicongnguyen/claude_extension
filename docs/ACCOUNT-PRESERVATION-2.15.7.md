# Saved account preservation — 2.15.7

## Confirmed problems and fixes

- Switching to a saved profile used to replace a readable outgoing login when it had never been saved. The backend now refuses that switch. The native account picker offers Save and switch, waits for a successful save, and rechecks the outgoing login under Claude credential/configuration locks before retrying.
- Native saving used to dispatch through a webview-only handler. Invoking the account picker from the command palette before opening the Manager panel could silently skip the save. The same native save flow now works without a webview. Cancelled or failed saves stop the transition.
- A picker opened before another window changed the login could ignore the profile that was active when the picker opened. Accepted switches now use the backend's fresh account check.
- Unreadable encrypted slots used to be omitted from the saved account list. They now appear as unavailable entries and an account-panel warning. Their encrypted files remain untouched. Error messages contain no credentials or raw decryption errors.
- Populated, conflicting account UUIDs no longer match through email or device-ID fallbacks. Saving a JWT login with conflicting local identity stops until login is complete, instead of storing the new tokens under the previous identity.
- Manager terminals include an existing native standalone CLI in ~/.local/bin when their inherited PATH omits it. Existing PATH entries retain priority; executable paths are passed as environment data, not shell commands. An older terminal is not reused while a PATH correction is needed.
- A successful new save explicitly confirms that the profile is available in Switch account.

Encryption remains AES-256-GCM with the existing VS Code SecretStorage key. Installing this update does not rotate keys, delete saved accounts, change the live Claude login, or reconstruct a missing profile.

## Returning to a missing account

If only one profile was saved, sign into the other account using Claude's normal browser login, then Save profile with a distinct label. Save each account once before using the picker to move between them. If a stored slot is marked unreadable, preserve its files and matching VS Code secret storage; do not delete the vault or create a replacement key to repair it.

Tests use synthetic credentials in isolated home directories. Real account switches, browser logins and quota resets are not exercised during validation.

## Terminal login requirement

Anthropic’s [VS Code documentation](https://code.claude.com/docs/en/vs-code#prerequisites) states that terminal use requires the standalone CLI even though the official extension bundles its own private copy for the chat panel. [Installation troubleshooting](https://code.claude.com/docs/en/troubleshoot-install) covers a missing PATH entry. Manager uses the standalone installation and never invokes the private bundled executable.
