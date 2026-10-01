/**
 * Best-effort link from a VS Code terminal to the Claude session it hosts,
 * including terminals opened by the user. The registry follows shell execution
 * completion so an exited or failed Claude command becomes resumable again.
 *
 * Requires VS Code shell integration; feature detection keeps older hosts safe.
 */
import * as vscode from "vscode";
import type { TerminalRegistry } from "./terminalRegistry";

/**
 * Support the bare CLI and quoted executable paths, including Windows
 * claude.exe. Quotes around the UUID are accepted by the shells we launch.
 */
const RESUME_CMD_RE =
  /\bclaude(?:\.exe)?\b["']?[^|;&]*?\s--resume\s+["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=["'\s]|$)/i;

/** Pure helper — exported for unit tests. Returns the UUID or null. */
export function extractResumeId(commandLine: string): string | null {
  const m = commandLine.match(RESUME_CMD_RE);
  return m ? m[1].toLowerCase() : null;
}

interface ShellExecutionStartEvent {
  terminal: vscode.Terminal;
  execution: { commandLine?: { value?: string } };
}

interface ShellExecutionApi {
  onDidStartTerminalShellExecution?: (
    listener: (e: ShellExecutionStartEvent) => void,
  ) => vscode.Disposable;
}

/**
 * Register any resume id detected in a shell command. The provider constructs
 * the registry first, so its execution listener runs before this one.
 */
export function createTerminalLinker(registry: TerminalRegistry): vscode.Disposable {
  const api = vscode.window as unknown as ShellExecutionApi;
  const subscribe = api.onDidStartTerminalShellExecution;
  if (typeof subscribe !== "function") {
    return { dispose: () => {} };
  }
  return subscribe((e) => {
    const cmd = e.execution?.commandLine?.value ?? "";
    const id = extractResumeId(cmd);
    if (id) registry.register(id, e.terminal);
  });
}
