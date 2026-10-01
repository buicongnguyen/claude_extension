import * as vscode from "vscode";

export interface TerminalRegistry {
  register(sessionId: string, terminal: vscode.Terminal): void;
  has(sessionId: string): boolean;
  view(sessionId: string): boolean;
  ids(): string[];
  onChange(cb: (ids: string[]) => void): vscode.Disposable;
  dispose(): void;
}

interface ShellExecution {
  commandLine?: { value?: string };
}

interface ShellExecutionEvent {
  terminal: vscode.Terminal;
  execution: ShellExecution;
}

interface ShellExecutionApi {
  onDidStartTerminalShellExecution?: (
    listener: (event: ShellExecutionEvent) => void,
  ) => vscode.Disposable;
  onDidEndTerminalShellExecution?: (
    listener: (event: ShellExecutionEvent) => void,
  ) => vscode.Disposable;
}

// Match Claude as the executable, not text in commands such as echo. Support
// quoted paths, PowerShell's call operator, shell chains, and env assignments.
const CLAUDE_EXECUTION_RE =
  /(?:^|[|;&])\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s|;&]+)\s+)*(?:&\s*)?(?:"(?:[^"\r\n]*[/\\])?claude(?:\.exe|\.cmd|\.ps1)?"|'(?:[^'\r\n]*[/\\])?claude(?:\.exe|\.cmd|\.ps1)?'|(?:[^\s"'|;&]*[/\\])?claude(?:\.exe|\.cmd|\.ps1)?)(?=\s|$)/i;

interface Binding {
  terminal: vscode.Terminal;
  execution?: ShellExecution;
}

export function createTerminalRegistry(): TerminalRegistry {
  const byId = new Map<string, Binding>();
  const listeners = new Set<(ids: string[]) => void>();
  const executions = new WeakMap<vscode.Terminal, ShellExecution>();
  const executionIds = new WeakMap<ShellExecution, Set<string>>();
  // SessionStart hook entries outlive their Claude process because the parent
  // shell stays alive. Do not let an advisory watcher resurrect an ended binding.
  const completed = new WeakMap<vscode.Terminal, Set<string>>();

  const emit = (): void => {
    const ids = [...byId.keys()];
    for (const fn of listeners) fn(ids);
  };

  const closeSub = vscode.window.onDidCloseTerminal((closed) => {
    executions.delete(closed);
    completed.delete(closed);
    let changed = false;
    for (const [id, binding] of byId) {
      if (binding.terminal === closed) {
        byId.delete(id);
        changed = true;
      }
    }
    if (changed) emit();
  });

  // Feature detection keeps the extension compatible with its VS Code floor.
  // The registry subscribes before the linker, so a newly detected resume id is
  // attached to the execution that actually launched it.
  const api = vscode.window as unknown as ShellExecutionApi;
  const startSub = api.onDidStartTerminalShellExecution?.((event) => {
    if (!event.execution) return;
    executions.set(event.terminal, event.execution);
    if (CLAUDE_EXECUTION_RE.test(event.execution.commandLine?.value ?? "")) {
      completed.delete(event.terminal);
    }
    const ids = new Set<string>();
    for (const [id, binding] of byId) {
      if (binding.terminal === event.terminal) {
        binding.execution = event.execution;
        ids.add(id);
      }
    }
    executionIds.set(event.execution, ids);
  });
  const endSub = api.onDidEndTerminalShellExecution?.((event) => {
    if (!event.execution) return;
    const isCurrent = executions.get(event.terminal) === event.execution;
    if (isCurrent) {
      executions.delete(event.terminal);
      const ended = completed.get(event.terminal) ?? new Set<string>();
      for (const id of executionIds.get(event.execution) ?? []) ended.add(id);
      completed.set(event.terminal, ended);
    }
    executionIds.delete(event.execution);
    let changed = false;
    for (const [id, binding] of byId) {
      if (binding.terminal !== event.terminal || binding.execution !== event.execution) continue;
      byId.delete(id);
      changed = true;
    }
    if (changed) emit();
  });

  return {
    register(sessionId, terminal) {
      if (completed.get(terminal)?.has(sessionId)) return;
      const execution = executions.get(terminal);
      if (execution) {
        const ids = executionIds.get(execution) ?? new Set<string>();
        ids.add(sessionId);
        executionIds.set(execution, ids);
      }
      const existing = byId.get(sessionId);
      if (existing?.terminal === terminal) {
        // Advisory registrations must not lose the execution identity.
        if (execution) existing.execution = execution;
        return;
      }
      byId.set(sessionId, { terminal, execution });
      emit();
    },
    has(sessionId) {
      return byId.has(sessionId);
    },
    view(sessionId) {
      const binding = byId.get(sessionId);
      if (!binding) return false;
      binding.terminal.show(false);
      return true;
    },
    ids() {
      return [...byId.keys()];
    },
    onChange(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose() {
      closeSub.dispose();
      startSub?.dispose();
      endSub?.dispose();
      byId.clear();
      listeners.clear();
    },
  };
}
