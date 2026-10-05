import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { Session } from "../types";

const state = vi.hoisted(() => ({
  workspace: "/repo", directory: true, branch: "main", sibling: false,
  prepare: vi.fn(), launch: vi.fn(), focus: vi.fn(), checkout: vi.fn(), shell: vi.fn(),
}));
vi.mock("../autoContinue", () => ({ prepareAutoContinue: state.prepare, launchAutoContinue: state.launch, focusAutoContinueSession: state.focus }));
vi.mock("../../../extension/workspace", () => ({ getWorkspace: () => state.workspace }));
vi.mock("../../../extension/git", () => ({ getCurrentBranch: () => state.branch }));
vi.mock("../../../extension/worktrees", () => ({
  clearWorktreeCache: vi.fn(),
  resolveWorktree: (p: string) => state.sibling ? ({ exists: true, kind: p === "/repo" ? "main" : "user", repoRoot: "/repo", branch: "main" }) : null,
  findWorktreeForBranch: () => null,
}));
vi.mock("../../../extension/terminal", () => ({ createTerminal: state.shell, runInTerminal: vi.fn(), validateGitRef: (s: string) => s }));
vi.mock("child_process", () => ({ execFile: state.checkout, execFileSync: vi.fn() }));
vi.mock("fs", async () => ({ ...await vi.importActual<typeof import("fs")>("fs"), statSync: () => ({ isDirectory: () => state.directory }) }));
import { waitAndContinueSession, continueStoppedTask, CONTINUE_TASK_PROMPT } from "../commands";
const plan = { executable: "C:/Users/Test/.local/bin/claude.exe", version: "2.1.288" };
function session(over: Partial<Session> = {}): Session {
  return { id: "session-1", name: "task", project: "repo", projectPath: "/repo", branch: "main", entrypoint: "claude-vscode", startTime: 1, endTime: 2, messageCount: 1, summary: "", prompts: [], projectKey: "repo", searchHaystack: "", ...over };
}
function approve() { return vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Old session closed — enable" as never); }
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  Object.assign(state, { workspace: "/repo", directory: true, branch: "main", sibling: false });
  Object.defineProperty(vscode.workspace, "isTrusted", { value: true, configurable: true });
  state.prepare.mockResolvedValue(plan); state.focus.mockReturnValue(false);
  state.checkout.mockImplementation((_exe, _args, _opts, cb) => cb(null));
});

describe("Wait and auto-continue handoff", () => {
  it("requires explicit agreement and never sends into the old chat or a shell", async () => {
    const warning = approve(); const open = vi.spyOn(vscode.env, "openExternal");
    await waitAndContinueSession("session-1", [session()]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("terminal"), expect.objectContaining({ modal: true }), "Old session closed — enable");
    expect(state.launch).toHaveBeenCalledWith(plan, "task", "/repo", "session-1", CONTINUE_TASK_PROMPT);
    expect(state.shell).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it("cancel and unsupported CLI cannot launch", async () => {
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    await waitAndContinueSession("session-1", [session()]);
    state.prepare.mockResolvedValue(undefined); approve();
    await waitAndContinueSession("session-1", [session()]);
    expect(state.launch).not.toHaveBeenCalled();
  });
  it("blocks unknown, injected, missing-folder and untrusted sessions before probing", async () => {
    await waitAndContinueSession("missing", []);
    await waitAndContinueSession("x;bad", [session({ id: "x;bad" })]);
    state.directory = false; await waitAndContinueSession("session-1", [session()]);
    state.directory = true;
    Object.defineProperty(vscode.workspace, "isTrusted", { value: false, configurable: true });
    await waitAndContinueSession("session-1", [session()]);
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.launch).not.toHaveBeenCalled();
  });
  it("requires an open workspace even when the empty window is trusted", async () => {
    state.workspace = ""; approve();
    await waitAndContinueSession("session-1", [session()]);
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.launch).not.toHaveBeenCalled();
  });
  it("requires the correct repository but permits a live sibling worktree", async () => {
    approve(); state.workspace = "/other";
    await waitAndContinueSession("session-1", [session()]);
    expect(state.prepare).not.toHaveBeenCalled();
    state.workspace = "/repo"; state.sibling = true;
    await waitAndContinueSession("session-1", [session({ projectPath: "/repo-wt" })]);
    expect(state.launch).toHaveBeenCalledWith(plan, "task", "/repo-wt", "session-1", CONTINUE_TASK_PROMPT);
  });
  it("focuses an existing waiting terminal without another confirmation or prompt", async () => {
    state.focus.mockReturnValue(true); const warning = approve();
    await waitAndContinueSession("session-1", [session()]);
    expect(warning).not.toHaveBeenCalled(); expect(state.prepare).not.toHaveBeenCalled(); expect(state.launch).not.toHaveBeenCalled();
  });
  it("coalesces repeated clicks and other restart actions during confirmation", async () => {
    let resolve!: (value: any) => void;
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockImplementation(() => new Promise(r => { resolve = r; }) as never);
    const first = waitAndContinueSession("session-1", [session()]);
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    await waitAndContinueSession("session-1", [session()]);
    await continueStoppedTask("session-1", [session()]);
    expect(warning).toHaveBeenCalledOnce();
    resolve("Old session closed — enable"); await first;
    expect(state.launch).toHaveBeenCalledOnce();
  });
  it("retains branch cancellation and checkout failure safeguards", async () => {
    state.branch = "other";
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValueOnce("Old session closed — enable" as never).mockResolvedValueOnce(undefined);
    await waitAndContinueSession("session-1", [session()]);
    expect(state.launch).not.toHaveBeenCalled();
    state.checkout.mockImplementation((_exe, _args, _opts, cb) => cb(new Error("conflict")));
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValueOnce("Old session closed — enable" as never).mockResolvedValueOnce("Switch & Resume" as never);
    await waitAndContinueSession("session-1", [session()]);
    expect(state.checkout).toHaveBeenCalled(); expect(state.launch).not.toHaveBeenCalled();
  });
  it("does not launch when trust or the session folder changes during confirmation", async () => {
    vi.spyOn(vscode.window, "showWarningMessage").mockImplementation(async () => {
      Object.defineProperty(vscode.workspace, "isTrusted", { value: false, configurable: true });
      return "Old session closed — enable" as never;
    });
    await waitAndContinueSession("session-1", [session()]);
    expect(state.launch).not.toHaveBeenCalled();
    Object.defineProperty(vscode.workspace, "isTrusted", { value: true, configurable: true });
    vi.spyOn(vscode.window, "showWarningMessage").mockImplementation(async () => {
      state.directory = false; return "Old session closed — enable" as never;
    });
    await waitAndContinueSession("session-1", [session()]);
    expect(state.launch).not.toHaveBeenCalled();
  });
  it("releases the action guard after failed launch preparation", async () => {
    state.prepare.mockRejectedValueOnce(new Error("probe failure"));
    await expect(waitAndContinueSession("session-1", [session()])).rejects.toThrow("probe failure");
    approve(); await waitAndContinueSession("session-1", [session()]);
    expect(state.launch).toHaveBeenCalledOnce();
  });
});
