import * as vscode from "vscode";
import { readAccountAuditLog } from "../features/account/accountAudit";

/** Open a snapshot, so copying or saving it cannot edit the ongoing audit. */
export async function showAccountSwitchLog(): Promise<void> {
  try {
    const content = [
      "Claude Code Manager Personal - saved account switch log",
      "Times are UTC. Records with the same operation ID belong to one action.",
      "local_operation_succeeded means local processing succeeded; it does not verify the remote login or restart open Claude chats.",
      "Only bounded event names and codes are recorded. No emails, account names, tokens, paths or chat text.",
      "Logs are local to this VS Code installation/remote host and survive window reloads. Older records rotate out.",
      "",
      readAccountAuditLog(),
    ].join("\n");
    const document = await vscode.workspace.openTextDocument({ content, language: "log" });
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    // Even failure to display diagnostics must not reject a detached command.
    try { await vscode.window.showErrorMessage("Could not open the account switch log. Try again after reloading VS Code."); } catch { /* host closing */ }
  }
}
