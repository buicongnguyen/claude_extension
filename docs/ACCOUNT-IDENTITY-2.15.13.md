# Account identity conflicts — 2.15.13

## Reproduced failure

A synthetic account A was saved, account B was saved, and A was selected. Replacing only the live identity configuration with the previous B configuration reproduced three failures in 2.15.12: the picker displayed B's email on A's row, selecting A again failed, and selecting B failed. All three tests failed before the change and pass afterward.

The live credentials can remain A's while a process or external write leaves B's metadata on disk. Manager previously used the local email to relabel the active saved row without checking its UUID. It also tried to save the inconsistent outgoing pair before any switch, so the identity mismatch guard blocked even a repair selection.

The user's available 10:18 AM KST switch records were from 2.15.10 and included Claude HTTP 400/401 failures. These logs do not establish which process wrote the mismatching identity or prove that this reproduced bug explains every rejected login.

## Changes

- The picker overlays a changed email only when the saved and live account UUIDs match, allowing legitimate email changes without copying another account's name.
- When live credentials exactly match a saved snapshot but local identity points elsewhere, Manager flags the mismatch and hides the conflicting identity in its profile display. UUID agreement takes precedence over email changes; unknown or rotated tokens are not treated as proof of a conflict.
- During an explicitly requested switch, if the entire live credential payload is already saved exactly, Manager preserves that snapshot instead of overwriting it with inconsistent identity metadata. It then restores the selected account through the existing journaled transaction, including when the selected account was already marked active.
- Changed/unknown credentials still require the original preservation and identity-confirmation checks. Update snapshot continues to refuse a mismatched identity.
- Identity-file watcher events invalidate the cached identity; mutation decisions also start with a cleared identity cache. The ordinary cache remains in place for repeated display reads.
- The audit records the fixed reason saved_snapshot_kept when it preserves exact known credentials during a metadata repair. No names or credentials are added to logs.

## Use

Reload VS Code once to activate the installed update. If the identity-conflict banner appears, stop ongoing Claude work, close old Claude chats/terminals, then reselect the intended saved account in Manager. The explicit selection restores consistent local files; it does not authenticate the token remotely. If Claude rejects the login, sign in again and update the verified account's snapshot.

There is no automatic identity rewrite or window reload. Another running Claude client can still write to the shared credential/configuration store. Server-revoked tokens cannot be repaired by restoring their old saved copy. Tests use isolated synthetic accounts; no live user login is changed during verification.
