import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { createTerminal, launchClaudeWithInput } from "../terminal";
import type { MockTerminal } from "../../__mocks__/vscode";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("personal terminal input safety", () => {
  it("never submits input to a shell, even if shell integration never activates", async () => {
    vi.useFakeTimers();
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);
    const sendText = vi.fn();
    const term = { sendText, show: vi.fn() } as unknown as vscode.Terminal;
    const input = "Write-Output 'synthetic-marker'\nWrite-Output 'second-line'";
    await launchClaudeWithInput(term, input);
    vi.advanceTimersByTime(1800);
    expect(sendText).not.toHaveBeenCalled();
    vi.advanceTimersByTime(700);
    expect(sendText.mock.calls).toEqual([["claude"]]);
    vi.advanceTimersByTime(30_000);
    expect(sendText.mock.calls).toEqual([["claude"]]);
  });
  it("copies verbatim only after the user chooses Copy input, without sending it", async () => {
    vi.useFakeTimers();
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue("Copy input" as never);
    const copy = vi.spyOn(vscode.env.clipboard, "writeText").mockResolvedValue(undefined);
    const sendText = vi.fn();
    const input = "a prompt with `quotes`, $variables, and\nnewlines";
    await launchClaudeWithInput({ sendText, show: vi.fn(), shellIntegration: {} } as unknown as vscode.Terminal, input);
    vi.runAllTimers();
    expect(copy).toHaveBeenCalledWith(input);
    expect(sendText.mock.calls).toEqual([["claude"]]);
  });
  it("does not overwrite the clipboard when the notification is dismissed", async () => {
    vi.useFakeTimers();
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);
    const copy = vi.spyOn(vscode.env.clipboard, "writeText");
    await launchClaudeWithInput({ sendText: vi.fn(), show: vi.fn(), shellIntegration: {} } as unknown as vscode.Terminal, "/login");
    expect(copy).not.toHaveBeenCalled();
  });
  it("passes a working directory through the terminal API without typing cd", () => {
    const sendText = vi.fn();
    const existing = { name: "ask", exitStatus: undefined, state: { isInteractedWith: false }, sendText, show() {} } as unknown as MockTerminal;
    (vscode.window as { terminals: MockTerminal[] }).terminals = [existing];
    const create = vi.spyOn(vscode.window, "createTerminal");
    const cwd = "C:/projects/$(Write-Output synthetic-marker)";
    expect(createTerminal("ask", cwd)).not.toBe(existing);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ cwd }));
    expect(sendText).not.toHaveBeenCalled();
  });
});
