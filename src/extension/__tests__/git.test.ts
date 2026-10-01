import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { getCurrentBranch, onBranchChange } from "../git";

/**
 * Build a stand-in VS Code Event: returns a subscription function that
 * records every listener and exposes an `emit` hook so tests can drive
 * the listener manually. Mirrors the shape of vscode.Event just enough
 * for onBranchChange to wire through it.
 */
function makeEvent<T>(): {
  event: (listener: (e: T) => void) => { dispose: () => void };
  emit: (value: T) => void;
  listenerCount: () => number;
  disposeCount: () => number;
} {
  const listeners: Array<(e: T) => void> = [];
  let disposes = 0;
  return {
    event: (listener) => {
      listeners.push(listener);
      return {
        dispose: () => {
          disposes++;
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        },
      };
    },
    emit: (value) => {
      for (const l of listeners.slice()) l(value);
    },
    listenerCount: () => listeners.length,
    disposeCount: () => disposes,
  };
}

describe("getCurrentBranch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty string when git extension is not found", () => {
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue(undefined as any);
    expect(getCurrentBranch()).toBe("");
  });

  it("returns empty string when git extension is not active", () => {
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      isActive: false,
      exports: undefined,
    } as any);
    expect(getCurrentBranch()).toBe("");
  });

  it("returns empty string when no repositories exist", () => {
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      isActive: true,
      exports: {
        getAPI: () => ({ repositories: [] }),
      },
    } as any);
    expect(getCurrentBranch()).toBe("");
  });

  it("returns the branch name from the first repository", () => {
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories: [
            { state: { HEAD: { name: "feature/my-branch" } } },
          ],
        }),
      },
    } as any);
    expect(getCurrentBranch()).toBe("feature/my-branch");
  });

  it("returns empty string when HEAD has no name", () => {
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories: [{ state: { HEAD: {} } }],
        }),
      },
    } as any);
    expect(getCurrentBranch()).toBe("");
  });

  it("returns empty string when getAPI throws", () => {
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      isActive: true,
      exports: {
        getAPI: () => {
          throw new Error("API unavailable");
        },
      },
    } as any);
    expect(getCurrentBranch()).toBe("");
  });
});

describe("onBranchChange", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fires the callback when a repository state changes", () => {
    const repoEvt = makeEvent<void>();
    const openEvt = makeEvent<any>();
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories: [{ state: { onDidChange: repoEvt.event } }],
          onDidOpenRepository: openEvt.event,
        }),
      },
    } as any);

    const cb = vi.fn();
    const disposable = onBranchChange(cb);
    // attach() fires onChange() once at hookup so subscribers receive the
    // current branch immediately; subsequent repo state changes increment.
    expect(cb).toHaveBeenCalledTimes(1);
    repoEvt.emit();
    repoEvt.emit();
    expect(cb).toHaveBeenCalledTimes(3);
    disposable.dispose();
  });

  it("wires newly opened repositories and fires once for the new repo", () => {
    const openEvt = makeEvent<any>();
    const firstRepoEvt = makeEvent<void>();
    const lateRepoEvt = makeEvent<void>();
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories: [{ state: { onDidChange: firstRepoEvt.event } }],
          onDidOpenRepository: openEvt.event,
        }),
      },
    } as any);

    const cb = vi.fn();
    const disposable = onBranchChange(cb);
    // attach() fires once on hookup (initial branch); discount it before
    // asserting the late-repo + state-change counts.
    cb.mockClear();

    // Simulate a late-opened repository arriving after activation.
    const lateRepo = { state: { onDidChange: lateRepoEvt.event } };
    openEvt.emit(lateRepo);
    // The onDidOpenRepository handler itself fires onChange once.
    expect(cb).toHaveBeenCalledTimes(1);
    // Subsequent state changes on the late repo also fire.
    lateRepoEvt.emit();
    expect(cb).toHaveBeenCalledTimes(2);

    disposable.dispose();
  });

  it("dispose removes every attached listener", () => {
    const repoEvt = makeEvent<void>();
    const openEvt = makeEvent<any>();
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories: [{ state: { onDidChange: repoEvt.event } }],
          onDidOpenRepository: openEvt.event,
        }),
      },
    } as any);

    const cb = vi.fn();
    const disposable = onBranchChange(cb);
    expect(repoEvt.listenerCount()).toBe(1);
    expect(openEvt.listenerCount()).toBe(1);

    disposable.dispose();
    expect(repoEvt.listenerCount()).toBe(0);
    expect(openEvt.listenerCount()).toBe(0);
  });

  it("returns a no-throw disposable when the git extension is inactive", () => {
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      isActive: false,
    } as any);
    const disposable = onBranchChange(() => {});
    expect(() => disposable.dispose()).not.toThrow();
  });

  it("swallows errors when getAPI throws", () => {
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      isActive: true,
      exports: {
        getAPI: () => {
          throw new Error("boom");
        },
      },
    } as any);
    expect(() => {
      const d = onBranchChange(() => {});
      d.dispose();
    }).not.toThrow();
  });
});

describe("getCurrentBranch — selected repository", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.assign(vscode.workspace, { workspaceFolders: [] });
    Object.assign(vscode.window, { activeTextEditor: undefined });
  });
  function installRepos() {
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      isActive: true, exports: { getAPI: () => ({ repositories: [
        { rootUri: { fsPath: "C:/repo-a" }, state: { HEAD: { name: "main" } } },
        { rootUri: { fsPath: "C:/repo-b" }, state: { HEAD: { name: "feature" } } },
        { rootUri: { fsPath: "C:/repo-b/nested" }, state: { HEAD: { name: "nested" } } },
      ] }) },
    } as never);
  }
  it("uses the actual session cwd rather than the first Git repository", () => {
    installRepos();
    expect(getCurrentBranch("c:\\REPO-B\\src")).toBe("feature");
    expect(getCurrentBranch("C:/repo-b/nested/src")).toBe("nested");
    expect(getCurrentBranch("C:/repo-b-other")).toBe("");
  });
  it("uses the active editor's workspace for branch indicators", () => {
    installRepos();
    const folder = { uri: { fsPath: "C:/repo-b" }, name: "b", index: 1 };
    Object.assign(vscode.workspace, { workspaceFolders: [
      { uri: { fsPath: "C:/repo-a" }, name: "a", index: 0 }, folder,
    ] });
    Object.assign(vscode.window, { activeTextEditor: { document: { uri: { fsPath: "C:/repo-b/file.ts" } } } });
    vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockReturnValue(folder as never);
    expect(getCurrentBranch()).toBe("feature");
  });
});
