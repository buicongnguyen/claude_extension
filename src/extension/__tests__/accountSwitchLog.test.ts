import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { showAccountSwitchLog } from "../accountSwitchLog";
vi.mock("../../features/account/accountAudit", () => ({ readAccountAuditLog: () => "retained-switch-record" }));
beforeEach(() => vi.restoreAllMocks());
describe("account switch log viewer", () => {
  it("opens retained records as a separate snapshot with outcome guidance", async () => {
    const document = {} as vscode.TextDocument;
    const open = vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(document);
    const show = vi.spyOn(vscode.window, "showTextDocument").mockResolvedValue({} as vscode.TextEditor);
    await showAccountSwitchLog();
    expect(open).toHaveBeenCalledWith({ content: expect.stringContaining("retained-switch-record"), language: "log" });
    expect((open.mock.calls[0][0] as { content: string }).content).toContain("does not verify the remote login");
    expect(show).toHaveBeenCalledWith(document, { preview: false });
  });
  it("does not reject if both opening and reporting fail during shutdown", async () => {
    vi.spyOn(vscode.workspace, "openTextDocument").mockRejectedValue(new Error("closed"));
    vi.spyOn(vscode.window, "showErrorMessage").mockRejectedValue(new Error("closed"));
    await expect(showAccountSwitchLog()).resolves.toBeUndefined();
  });
});
