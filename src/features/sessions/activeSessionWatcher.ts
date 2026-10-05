/** Match SessionStart process ancestry to terminals, with separate CLI liveness. */
import * as fs from "fs";
import * as vscode from "vscode";
import { SESSION_ACTIVE_FILE } from "../../core/config";
import { getProcessStartTimesAsync } from "./procTime";
import type { TerminalBindingSource, TerminalRegistry } from "./terminalRegistry";

export interface ActiveEntry {
  sessionId: string;
  ppid: number;
  terminalPids: number[];
  claudePid: number;
  claudeStartedAt?: number;
  cwd: string;
  transcriptPath: string;
  ts: number;
}
const PPID_START_TOLERANCE_MS = 60_000;
const POLL_INTERVAL_MS = 4000;
const validPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
function isProcessAlive(pid: number): boolean {
  if (!validPid(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Legacy entries lack a Claude PID and cannot prove their shell hosts Claude. */
export function readActiveSessions(now: number = Date.now()): ActiveEntry[] {
  return readActiveSessionRegistry(now) ?? [];
}

function readActiveSessionRegistry(now: number = Date.now()): ActiveEntry[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(SESSION_ACTIVE_FILE, "utf-8")); }
  catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const out: ActiveEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Partial<ActiveEntry>;
    if (typeof entry.sessionId !== "string" || !entry.sessionId ||
        !validPid(entry.claudePid) || typeof entry.ts !== "number" || !Number.isFinite(entry.ts) ||
        entry.ts < 0 || entry.ts > now + PPID_START_TOLERANCE_MS || !isProcessAlive(entry.claudePid)) continue;
    const terminalPids = Array.isArray(entry.terminalPids)
      ? [...new Set(entry.terminalPids.filter(validPid))].filter(isProcessAlive)
      : validPid(entry.ppid) && isProcessAlive(entry.ppid) ? [entry.ppid] : [];
    if (terminalPids.length === 0) continue;
    out.push({
      sessionId: entry.sessionId, ppid: terminalPids[0], terminalPids, claudePid: entry.claudePid,
      ...(typeof entry.claudeStartedAt === "number" && Number.isFinite(entry.claudeStartedAt)
        ? { claudeStartedAt: entry.claudeStartedAt } : {}),
      cwd: typeof entry.cwd === "string" ? entry.cwd : "",
      transcriptPath: typeof entry.transcriptPath === "string" ? entry.transcriptPath : "", ts: entry.ts,
    });
  }
  return out;
}

/** Reject recycled CLI PIDs and recycled terminal ancestors independently. */
export async function filterReusedPpids(entries: ActiveEntry[]): Promise<ActiveEntry[]> {
  const pids = [...new Set(entries.flatMap((entry) => [entry.claudePid, ...entry.terminalPids]))];
  const starts = await getProcessStartTimesAsync(pids);
  const out: ActiveEntry[] = [];
  for (const entry of entries) {
    const cliStart = starts.get(entry.claudePid);
    if (cliStart !== undefined && (entry.claudeStartedAt !== undefined
      ? Math.abs(cliStart - entry.claudeStartedAt) > 1000
      : cliStart > entry.ts + PPID_START_TOLERANCE_MS)) continue;
    const terminalPids = entry.terminalPids.filter((pid) => {
      const start = starts.get(pid);
      return start === undefined || start <= entry.ts + PPID_START_TOLERANCE_MS;
    });
    if (terminalPids.length) out.push({ ...entry, ppid: terminalPids[0], terminalPids });
  }
  return out;
}

/** Polling also notices a CLI exit on restored terminals without shell events. */
export function startActiveSessionWatcher(registry: TerminalRegistry): vscode.Disposable {
  let disposed = false;
  let pending = false;
  let running = false;
  const matches = new Map<vscode.Terminal, { sessionId: string; source: TerminalBindingSource }>();
  const syncMatches = async (): Promise<void> => {
    const snapshot = readActiveSessionRegistry();
    if (snapshot === null) {
      // Missing/partial reads do not prove that a live Claude client ended.
      for (const [terminal, match] of matches) {
        if (!isProcessAlive(match.source.claudePid)) {
          registry.unregister?.(match.sessionId, terminal, match.source);
          matches.delete(terminal);
        }
      }
      return;
    }
    const entries = await filterReusedPpids(snapshot);
    if (disposed) return;
    const byPpid = new Map<number, ActiveEntry>();
    const byClaudePid = new Map<number, ActiveEntry>();
    for (const entry of entries) {
      // The CLI can exit while the OS query is pending.
      if (!isProcessAlive(entry.claudePid)) continue;
      // Direct native terminals run Claude as their shell process. The entry
      // already passed CLI liveness and process-start verification above.
      if (!byClaudePid.has(entry.claudePid) || byClaudePid.get(entry.claudePid)!.ts <= entry.ts) {
        byClaudePid.set(entry.claudePid, entry);
      }
      for (const pid of entry.terminalPids) {
        if (!byPpid.has(pid) || byPpid.get(pid)!.ts <= entry.ts) byPpid.set(pid, entry);
      }
    }
    const next = new Map<vscode.Terminal, { sessionId: string; source: TerminalBindingSource }>();
    for (const terminal of vscode.window.terminals) {
      let pid: number | undefined;
      try { pid = await terminal.processId; } catch { continue; }
      if (disposed) return;
      const entry = pid === undefined ? undefined : byClaudePid.get(pid) ?? byPpid.get(pid);
      if (!entry || !vscode.window.terminals.includes(terminal)) continue;
      const source = { claudePid: entry.claudePid, ts: entry.ts };
      next.set(terminal, { sessionId: entry.sessionId, source });
    }
    // Replace a same-session process before retiring its old generation.
    for (const [terminal, match] of next) registry.register(match.sessionId, terminal, match.source);
    for (const [terminal, previous] of matches) {
      const current = next.get(terminal);
      if (!current || current.sessionId !== previous.sessionId || current.source.claudePid !== previous.source.claudePid || current.source.ts !== previous.source.ts) {
        registry.unregister?.(previous.sessionId, terminal, previous.source);
      }
    }
    matches.clear();
    for (const [terminal, match] of next) {
      matches.set(terminal, match);
    }
  };
  const schedule = (): void => {
    if (disposed) return;
    pending = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (pending && !disposed) { pending = false; await syncMatches(); }
      } finally { running = false; }
    })();
  };
  schedule();
  const fileWatcher = vscode.workspace.createFileSystemWatcher(SESSION_ACTIVE_FILE);
  fileWatcher.onDidCreate(schedule); fileWatcher.onDidChange(schedule); fileWatcher.onDidDelete(schedule);
  const terminalOpen = vscode.window.onDidOpenTerminal(schedule);
  const timer = setInterval(schedule, POLL_INTERVAL_MS);
  timer.unref?.();
  return { dispose: () => {
    disposed = true; clearInterval(timer); fileWatcher.dispose(); terminalOpen.dispose(); matches.clear();
  } };
}
