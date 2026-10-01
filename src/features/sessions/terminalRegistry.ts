import * as vscode from "vscode";

export interface TerminalBindingSource {
  claudePid: number;
  ts: number;
}
export interface TerminalRegistry {
  register(sessionId: string, terminal: vscode.Terminal, source?: TerminalBindingSource): void;
  unregister?(sessionId: string, terminal: vscode.Terminal, source: TerminalBindingSource): void;
  has(sessionId: string): boolean;
  view(sessionId: string): boolean;
  ids(): string[];
  onChange(cb: (ids: string[]) => void): vscode.Disposable;
  dispose(): void;
}
interface ShellExecution { commandLine?: { value?: string } }
interface ShellExecutionEvent { terminal: vscode.Terminal; execution: ShellExecution }
interface ShellExecutionApi {
  onDidStartTerminalShellExecution?: (listener: (event: ShellExecutionEvent) => void) => vscode.Disposable;
  onDidEndTerminalShellExecution?: (listener: (event: ShellExecutionEvent) => void) => vscode.Disposable;
}

// Match the executable, including quoted paths and PowerShell's call operator.
const CLAUDE_EXECUTION_RE =
  /(?:^|[|;&])\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s|;&]+)\s+)*(?:&\s*)?(?:"(?:[^"\r\n]*[/\\])?claude(?:\.exe|\.cmd|\.ps1)?"|'(?:[^'\r\n]*[/\\])?claude(?:\.exe|\.cmd|\.ps1)?'|(?:[^\s"'|;&]*[/\\])?claude(?:\.exe|\.cmd|\.ps1)?)(?=\s|$)/i;
interface Binding {
  terminal: vscode.Terminal;
  execution?: ShellExecution;
  source?: TerminalBindingSource;
  sourceExecution?: ShellExecution;
}
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function createTerminalRegistry(): TerminalRegistry {
  const byId = new Map<string, Binding>();
  const listeners = new Set<(ids: string[]) => void>();
  const executions = new WeakMap<vscode.Terminal, ShellExecution>();
  const retiredSources = new WeakMap<vscode.Terminal, Map<string, TerminalBindingSource>>();
  const executionIds = new WeakMap<ShellExecution, Set<string>>();
  const endedExecutions = new WeakSet<ShellExecution>();
  const completed = new WeakMap<vscode.Terminal, Map<string, TerminalBindingSource | null>>();
  const emit = (): void => { for (const fn of listeners) fn([...byId.keys()]); };
  const markCompleted = (terminal: vscode.Terminal, ids: Iterable<string>, sources = new Map<string, TerminalBindingSource>()): void => {
    const ended = completed.get(terminal) ?? new Map<string, TerminalBindingSource | null>();
    for (const id of ids) ended.set(id, sources.get(id) ?? null);
    completed.set(terminal, ended);
  };
  const closeSub = vscode.window.onDidCloseTerminal((closed) => {
    executions.delete(closed); completed.delete(closed); retiredSources.delete(closed);
    let changed = false;
    for (const [id, binding] of byId) {
      if (binding.terminal === closed) { byId.delete(id); changed = true; }
    }
    if (changed) emit();
  });
  const api = vscode.window as unknown as ShellExecutionApi;
  const startSub = api.onDidStartTerminalShellExecution?.((event) => {
    if (!event.execution) return;
    executions.set(event.terminal, event.execution);
    const isClaude = CLAUDE_EXECUTION_RE.test(event.execution.commandLine?.value ?? "");
    if (isClaude) completed.delete(event.terminal);
    const ids = new Set<string>();
    for (const [id, binding] of byId) {
      if (binding.terminal === event.terminal) {
        if (isClaude && binding.source && !isPidAlive(binding.source.claudePid)) {
          // A dead process proves this hook is stale; event delivery order does not.
          const retired = retiredSources.get(event.terminal) ?? new Map<string, TerminalBindingSource>();
          retired.set(id, binding.source); retiredSources.set(event.terminal, retired);
          binding.source = undefined; binding.sourceExecution = undefined;
        }
        binding.execution = event.execution;
        if (binding.source && (!binding.sourceExecution || endedExecutions.has(binding.sourceExecution))) {
          binding.sourceExecution = event.execution;
        }
        ids.add(id);
      }
    }
    executionIds.set(event.execution, ids);
  });
  const endSub = api.onDidEndTerminalShellExecution?.((event) => {
    if (!event.execution || endedExecutions.has(event.execution)) return;
    endedExecutions.add(event.execution);
    const current = executions.get(event.terminal);
    const isCurrent = current === event.execution;
    const restoredEnd = current === undefined &&
      CLAUDE_EXECUTION_RE.test(event.execution.commandLine?.value ?? "");
    if (isCurrent) executions.delete(event.terminal);
    const endedIds = new Set(isCurrent ? executionIds.get(event.execution) : []);
    executionIds.delete(event.execution);
    const endedSources = new Map<string, TerminalBindingSource>();
    let changed = false;
    for (const [id, binding] of byId) {
      if (binding.terminal !== event.terminal) continue;
      if (binding.source && isPidAlive(binding.source.claudePid)) { endedIds.delete(id); continue; }
      const restored = binding.execution === undefined && restoredEnd &&
        (!binding.source || !isPidAlive(binding.source.claudePid));
      if (binding.execution !== event.execution && !restored) continue;
      if (binding.source) endedSources.set(id, binding.source);
      byId.delete(id); endedIds.add(id); changed = true;
    }
    if (isCurrent || changed) markCompleted(event.terminal, endedIds, endedSources);
    if (changed) emit();
  });
  return {
    register(sessionId, terminal, source) {
      const ended = completed.get(terminal);
      const endedSource = ended?.get(sessionId);
      // Delivery time is not process start time. A distinct live hook can precede a delayed End.
      if (ended?.has(sessionId) && (!source ||
          (endedSource?.claudePid === source.claudePid && source.ts <= endedSource.ts))) return;
      const existing = byId.get(sessionId);
      if (source && existing?.source && source.ts < existing.source.ts) return;
      const execution = executions.get(terminal);
      const retired = retiredSources.get(terminal)?.get(sessionId);
      if (source && (!isPidAlive(source.claudePid) ||
          (retired?.claudePid === source.claudePid && source.ts <= retired.ts))) return;
      if (execution) {
        const ids = executionIds.get(execution) ?? new Set<string>();
        ids.add(sessionId); executionIds.set(execution, ids);
      }
      if (existing?.terminal === terminal) {
        if (source && existing.source && source.claudePid !== existing.source.claudePid) {
          // The new process can publish its hook before the queued Start event arrives.
          if (existing.execution) executionIds.get(existing.execution)?.delete(sessionId);
          existing.execution = undefined; existing.sourceExecution = undefined;
        } else if (execution && (!source || !existing.source || existing.sourceExecution === execution)) {
          existing.execution = execution;
          if (source) existing.sourceExecution = execution;
        }
        if (source) existing.source = { ...source };
        return;
      }
      byId.set(sessionId, { terminal, execution, source: source ? { ...source } : undefined, sourceExecution: source ? execution : undefined });
      emit();
    },
    unregister(sessionId, terminal, source) {
      const binding = byId.get(sessionId);
      if (binding?.terminal !== terminal || binding.source?.claudePid !== source.claudePid || binding.source.ts !== source.ts) return;
      if (binding.execution && binding.sourceExecution && binding.execution !== binding.sourceExecution &&
          !endedExecutions.has(binding.execution)) {
        // A watcher cleanup for the previous client cannot remove the new observed launch.
        binding.source = undefined; binding.sourceExecution = undefined;
        if (!isPidAlive(source.claudePid)) {
          const retired = retiredSources.get(terminal) ?? new Map<string, TerminalBindingSource>();
          retired.set(sessionId, source); retiredSources.set(terminal, retired);
        }
        return;
      }
      byId.delete(sessionId);
      if (!isPidAlive(source.claudePid)) markCompleted(terminal, [sessionId], new Map([[sessionId, source]]));
      emit();
    },
    has: (sessionId) => byId.has(sessionId),
    view(sessionId) {
      const binding = byId.get(sessionId);
      if (!binding) return false;
      binding.terminal.show(false); return true;
    },
    ids: () => [...byId.keys()],
    onChange(cb) { listeners.add(cb); return { dispose: () => listeners.delete(cb) }; },
    dispose() {
      closeSub.dispose(); startSub?.dispose(); endSub?.dispose();
      byId.clear(); listeners.clear();
    },
  };
}
