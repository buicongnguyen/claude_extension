Account switching now preserves an outgoing login that has not been saved, and native saving works even before opening the Manager panel. Unreadable saved profiles remain visible with an explanation instead of disappearing. Account identity conflict checks prevent a new login being stored under stale metadata.

Manager terminals find an installed standalone Claude CLI in ~/.local/bin even when the inherited PATH omits it. Existing PATH priority is preserved.

Validation: 3,995 passing tests; the same 19 known upstream Windows failures as 2.15.6, with no new failures. Type checks, configured lint, builds and installer inspection pass. Tests use synthetic accounts; real account switches and quota resets were not exercised.

Install the attached VSIX and reload VS Code. Saved-account keys are not changed. If an account was never saved, sign in once and save it with a distinct profile label.
