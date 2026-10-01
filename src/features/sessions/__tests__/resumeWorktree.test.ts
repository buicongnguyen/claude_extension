import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import type { WorktreeRef } from "../../../extension/worktrees";

const { checkout } = vi.hoisted(() => ({ checkout: vi.fn() }));
vi.mock("child_process", () => ({ execFile: checkout, execFileSync: vi.fn() }));

// Stub config so importing commands doesn't reach into real dirs.
vi.mock("../../../core/config", () => ({
  CLAUDE_DIR: "/tmp/irrelevant",
  HISTORY_FILE: "/tmp/irrelevant/history.jsonl",
  PROJECTS_DIR: "/tmp/irrelevant/projects",
  SESSIONS_DIR: "/tmp/irrelevant/sessions",
  STATE_FILE: "/tmp/irrelevant/.state.json",
  SESSION_META_READ_BYTES: 4096,
}));

// Capture every createTerminal call: its cwd + the commands sent to it. This
// is how the tests assert "resumed in place at the worktree path, no checkout".
interface TermCall {
  name: string;
  cwd?: string;
  sessionId?: string;
  sent: string[];
}
let terminalCalls: TermCall[] = [];
vi.mock("../../../extension/terminal", () => ({
  createTerminal: (name: string, cwd?: string, sessionId?: string) => {
    const rec: TermCall = { name, cwd, sessionId, sent: [] };
    terminalCalls.push(rec);
    return { show: () => {}, sendText: (t: string) => rec.sent.push(t) };
  },
  runInTerminal: (term: { sendText: (t: string) => void }, cmd: string) => term.sendText(cmd),
  validateGitRef: (n: string) => (/^[A-Za-z0-9._/-]+$/.test(n) ? n : null),
}));

let mockCurrentBranch = "main";
vi.mock("../../../extension/git", () => ({
  getCurrentBranch: () => mockCurrentBranch,
}));

let mockWorkspace = "";
vi.mock("../../../extension/workspace", () => ({
  getWorkspace: () => mockWorkspace,
}));

// Force terminal routing so resolveClaudeTarget never reaches the extension URI
// path — this suite is about the worktree/branch decisions, not the surface.
vi.mock("../../../extension/claudeCodeExtension", () => ({
  isClaudeCodeExtensionInstalled: () => false,
  openSessionInExtension: vi.fn(),
  openPromptInExtension: vi.fn(),
  isExtensionEntrypoint: () => false,
}));

let mockResolveWorktree: (dir: string) => WorktreeRef | null = () => null;
let mockFindWorktreeForBranch: (dir: string, branch: string) => WorktreeRef | null =
  () => null;
const clearWorktreeCache = vi.fn();
vi.mock("../../../extension/worktrees", () => ({
  resolveWorktree: (dir: string) => mockResolveWorktree(dir),
  findWorktreeForBranch: (dir: string, branch: string) =>
    mockFindWorktreeForBranch(dir, branch),
  clearWorktreeCache: () => clearWorktreeCache(),
}));

import { resumeSession, resumeAfterAccountSwitch, continueStoppedTask, CONTINUE_TASK_PROMPT } from "../commands";
import type { Session } from "../types";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    name: "",
    project: "repo",
    projectPath: "/repo/.claude/worktrees/feat",
    branch: "worktree-feat",
    entrypoint: "cli",
    startTime: 1,
    endTime: 2,
    messageCount: 1,
    summary: "",
    prompts: [],
    projectKey: "repo",
    searchHaystack: "",
    ...overrides,
  };
}

function worktreeRef(path: string, kind: WorktreeRef["kind"] = "claude"): WorktreeRef {
  return { path, branch: kind === "main" ? "main" : "worktree-feat", kind, exists: true, locked: false, repoRoot: "/repo" };
}

function forceTerminalResumeIn(): void {
  vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
    get: (_key: string, def?: unknown) => (_key === "resumeIn" ? "terminal" : def),
  } as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
  terminalCalls = [];
  checkout.mockReset();
  checkout.mockImplementation((_file, _args, _opts, callback) => callback(null));
  clearWorktreeCache.mockReset();
  mockCurrentBranch = "main";
  mockResolveWorktree = () => null;
  mockFindWorktreeForBranch = () => null;
  forceTerminalResumeIn();
});

describe("resumeSession — worktree aware", () => {
  it("resumes in place when the session ran in a live worktree, no checkout or warning", async () => {
    const sess = makeSession(); // projectPath is a live Claude worktree
    mockWorkspace = sess.projectPath;
    // Even a branch mismatch must be ignored for a live worktree session.
    mockCurrentBranch = "main";
    mockResolveWorktree = (dir) =>
      dir === sess.projectPath ? worktreeRef(sess.projectPath) : null;
    const warn = vi.spyOn(vscode.window, "showWarningMessage");

    await resumeSession(sess.id, false, [sess]);

    expect(warn).not.toHaveBeenCalled();
    expect(clearWorktreeCache).toHaveBeenCalled();
    expect(terminalCalls).toHaveLength(1);
    expect(terminalCalls[0].cwd).toBe(sess.projectPath);
    expect(terminalCalls[0].sent).toEqual([`claude --resume ${sess.id}`]);
    // No git checkout was injected.
    expect(terminalCalls[0].sent.some((t) => t.includes("git checkout"))).toBe(false);
  });

  it("offers Open worktree when the branch is live in a different worktree", async () => {
    const sess = makeSession({
      projectPath: "/repo",
      branch: "worktree-feat",
    });
    mockWorkspace = "/repo";
    mockCurrentBranch = "main"; // mismatch vs the session branch
    // The session dir is the main checkout — not a live worktree.
    mockResolveWorktree = () => worktreeRef("/repo", "main");
    // …but the branch is checked out in a sibling worktree.
    mockFindWorktreeForBranch = (_dir, branch) =>
      branch === "worktree-feat" ? worktreeRef("/repo/.claude/worktrees/feat") : null;
    const warn = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue("Open worktree" as never);

    await resumeSession(sess.id, false, [sess]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("checked out in another worktree");
    expect(terminalCalls).toHaveLength(1);
    expect(terminalCalls[0].cwd).toBe("/repo/.claude/worktrees/feat");
    expect(terminalCalls[0].sent).toEqual([`claude --resume ${sess.id}`]);
    expect(terminalCalls[0].sent.some((t) => t.includes("git checkout"))).toBe(false);
  });

  it("falls back to the in-place Switch & Resume checkout for a main-checkout mismatch", async () => {
    const sess = makeSession({ projectPath: "/repo", branch: "feature" });
    mockWorkspace = "/repo";
    mockCurrentBranch = "main"; // mismatch
    mockResolveWorktree = () => worktreeRef("/repo", "main");
    mockFindWorktreeForBranch = () => null; // branch not live in any worktree
    const warn = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue("Switch & Resume" as never);

    await resumeSession(sess.id, false, [sess]);

    expect(warn.mock.calls[0][0]).toContain('but you\'re on "main"');
    expect(terminalCalls).toHaveLength(1);
    expect(checkout).toHaveBeenCalledWith("git", ["checkout", "feature"], expect.objectContaining({ cwd: "/repo", windowsHide: true }), expect.any(Function));
    expect(terminalCalls[0].sent).toEqual([`claude --resume ${sess.id}`]);
  });

  it("Open worktree is not offered when the found worktree is the current dir", async () => {
    // findWorktreeForBranch returning the same path as cwd must not trigger the
    // redirect — it would be a no-op hop. Fall through to the checkout flow.
    const sess = makeSession({ projectPath: "/repo", branch: "feature" });
    mockWorkspace = "/repo";
    mockCurrentBranch = "main";
    mockResolveWorktree = () => worktreeRef("/repo", "main");
    mockFindWorktreeForBranch = () => worktreeRef("/repo", "main");
    const warn = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue("Resume Anyway" as never);

    await resumeSession(sess.id, false, [sess]);

    expect(warn.mock.calls[0][0]).toContain("but you're on");
  });
});

describe("fresh recovery branch checkout", () => {
  it("checks out with arguments before launching a plain Claude command", async () => {
    const sess = makeSession({ projectPath: "/repo", branch: "feature" });
    mockWorkspace = "/repo"; mockCurrentBranch = "main";
    vi.spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValueOnce("Old session closed — resume" as never)
      .mockResolvedValueOnce("Switch & Resume" as never);
    await resumeAfterAccountSwitch(sess.id, [sess]);
    expect(checkout).toHaveBeenCalledWith("git", ["checkout", "feature"], expect.objectContaining({ cwd: "/repo" }), expect.any(Function));
    expect(terminalCalls).toHaveLength(1);
    expect(terminalCalls[0].sent).toEqual(["claude --resume sess-1"]);
  });
  it("does not start Claude if Git cannot switch the branch", async () => {
    const sess = makeSession({ projectPath: "/repo", branch: "feature" });
    mockWorkspace = "/repo"; mockCurrentBranch = "main";
    checkout.mockImplementation((_file, _args, _opts, callback) => callback(new Error("local changes")));
    vi.spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValueOnce("Old session closed — resume" as never)
      .mockResolvedValueOnce("Switch & Resume" as never);
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    await resumeAfterAccountSwitch(sess.id, [sess]);
    expect(error).toHaveBeenCalled(); expect(terminalCalls).toEqual([]);
  });
});

describe("Continue task — sibling checkout", () => {
  it("continues the task in a sibling worktree without a project-window hop", async () => {
    const sess = makeSession(); mockWorkspace = "/repo";
    mockResolveWorktree = (dir) => worktreeRef(dir, dir === "/repo" ? "main" : "claude");
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Old session closed — continue" as never);
    const open = vi.spyOn(vscode.commands, "executeCommand");
    await continueStoppedTask(sess.id, [sess]);
    expect(warning).toHaveBeenCalledOnce();
    expect(terminalCalls).toHaveLength(1);
    expect(terminalCalls[0].cwd).toBe(sess.projectPath);
    expect(terminalCalls[0].sent).toEqual([`claude --resume ${sess.id} "${CONTINUE_TASK_PROMPT}"`]);
    expect(open).not.toHaveBeenCalled(); expect(checkout).not.toHaveBeenCalled();
  });
  it("opens sibling worktree history in its terminal without a project-window hop", async () => {
    const sess = makeSession(); mockWorkspace = "/repo";
    mockResolveWorktree = (dir) => worktreeRef(dir, dir === "/repo" ? "main" : "user");
    const open = vi.spyOn(vscode.commands, "executeCommand");
    await resumeSession(sess.id, false, [sess]);
    expect(terminalCalls[0].cwd).toBe(sess.projectPath);
    expect(terminalCalls[0].sent).toEqual([`claude --resume ${sess.id}`]);
    expect(open).not.toHaveBeenCalled();
  });
  it("keeps a different repository and a removed sibling outside continuation", async () => {
    const sess = makeSession(); mockWorkspace = "/other";
    mockResolveWorktree = (dir) => ({ ...worktreeRef(dir), repoRoot: dir === "/other" ? "/other" : "/repo" });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    await continueStoppedTask(sess.id, [sess]);
    mockWorkspace = "/repo";
    mockResolveWorktree = (dir) => ({ ...worktreeRef(dir), exists: dir === "/repo" });
    await continueStoppedTask(sess.id, [sess]);
    expect(info).toHaveBeenCalledTimes(2); expect(warning).not.toHaveBeenCalled();
    expect(terminalCalls).toEqual([]);
  });
  it("checks the historical branch against the terminal cwd", async () => {
    const sess = makeSession({ projectPath: "/repo-b", branch: "main" });
    mockWorkspace = "/repo-b"; mockCurrentBranch = "feature";
    const branch = vi.spyOn(await import("../../../extension/git"), "getCurrentBranch");
    vi.spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValueOnce("Old session closed — continue" as never)
      .mockResolvedValueOnce("Resume Anyway" as never);
    await continueStoppedTask(sess.id, [sess]);
    expect(branch).toHaveBeenCalledWith("/repo-b");
    expect(terminalCalls[0].cwd).toBe("/repo-b");
  });
});

describe("main-checkout session from a sibling workspace", () => {
  it("checks the freshly resolved main branch when that checkout is absent from the Git API", async () => {
    const sess = makeSession({ projectPath: "/repo", branch: "historical" });
    mockWorkspace = "/repo/.claude/worktrees/current"; mockCurrentBranch = "";
    mockResolveWorktree = dir => worktreeRef(dir, dir === "/repo" ? "main" : "claude");
    const warning = vi.spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValueOnce("Old session closed — continue" as never)
      .mockResolvedValueOnce("Resume Anyway" as never);
    await continueStoppedTask(sess.id, [sess]);
    expect(warning.mock.calls[1][0]).toContain('but you\'re on "main"');
    expect(terminalCalls[0].cwd).toBe("/repo");
  });
});
