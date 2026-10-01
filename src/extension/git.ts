/**
 * Git integration — requires VS Code API.
 */
import * as vscode from "vscode";
import { normPath } from "../core/utils";
import { getWorkspace } from "./workspace";

/** Minimal interface for the VS Code built-in Git extension API. */
interface GitExtensionAPI {
  getAPI(version: number): GitAPI;
}

interface GitAPI {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitRepository {
  rootUri?: vscode.Uri;
  state: {
    HEAD?: {
      name?: string;
    };
    onDidChange: vscode.Event<void>;
  };
}

/**
 * Get the branch of the repository containing the requested working directory.
 * Returns an empty string if the Git extension is not active, no repo is open,
 * or the branch cannot be determined.
 */
export function getCurrentBranch(cwd: string = getWorkspace()): string {
  try {
    const gitExt = vscode.extensions.getExtension<GitExtensionAPI>("vscode.git");
    if (!gitExt?.isActive) {
      return "";
    }
    const git = gitExt.exports.getAPI(1);
    const target = normPath(cwd);
    const repo = target
      ? git.repositories
          .filter((candidate) => {
            const root = candidate.rootUri ? normPath(candidate.rootUri.fsPath) : "";
            return root && (target === root || target.startsWith(`${root}/`));
          })
          .sort((a, b) => b.rootUri!.fsPath.length - a.rootUri!.fsPath.length)[0]
      : git.repositories[0];
    return repo?.state?.HEAD?.name ?? "";
  } catch {
    return "";
  }
}

/**
 * Subscribe to branch changes (checkouts, detached HEAD, repo open/close).
 * Returns a Disposable that removes every underlying listener — the caller
 * must keep the returned value alive and dispose it when the subscriber
 * goes away. Fires `onChange` without arguments; consumers call
 * `getCurrentBranch()` themselves when they need the latest value.
 *
 * The Git extension activates asynchronously, so we retry once after
 * 2000ms when it is not ready yet. Any failure is swallowed — git is
 * optional; a workspace with no repo should not spew errors.
 */
export function onBranchChange(onChange: () => void): vscode.Disposable {
  const inner: vscode.Disposable[] = [];

  const attach = (): boolean => {
    const gitExt = vscode.extensions.getExtension<GitExtensionAPI>("vscode.git");
    if (!gitExt?.isActive) return false;
    try {
      const git = gitExt.exports.getAPI(1);
      for (const repo of git.repositories) {
        inner.push(repo.state.onDidChange(() => onChange()));
      }
      // New repos (e.g. a user clones/opens a folder after activation)
      // also need to be wired, otherwise the chip stays stale.
      inner.push(
        git.onDidOpenRepository((repo) => {
          inner.push(repo.state.onDidChange(() => onChange()));
          onChange();
        }),
      );
      // Fire once on attach so subscribers get the current branch as soon
      // as the git extension is up — otherwise the initial post made
      // before activation lands as "" and any (current) marker on the
      // sidebar's branch list stays cold until the user checks out.
      if (git.repositories.length > 0) onChange();
      return true;
    } catch {
      return false;
    }
  };

  if (!attach()) {
    const timer = setTimeout(() => attach(), 2000);
    inner.push({ dispose: () => clearTimeout(timer) });
  }

  return {
    dispose: () => {
      for (const d of inner) {
        try {
          d.dispose();
        } catch {
          // ignore — best-effort cleanup on webview dispose
        }
      }
    },
  };
}
