/** Parent-process lookup for the SessionStart hook. Never reads command lines. */
import * as fs from "fs";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { getProcessStartTimesAsync } from "./procTime";

const execFileP = promisify(execFile);
const MAX_ANCESTORS = 16;
const QUERY_TIMEOUT_MS = 8000;
const HOST_SHELL_RE = /^(?:powershell|pwsh|bash|zsh|fish|sh)(?:\.exe)?$/i;
const NPM_RUNTIME_RE = /^(?:node|nodejs|bun)(?:\.exe)?$/i;
const VERSION_FILE_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\.exe)?$/;

export interface ProcessAncestor {
  pid: number;
  ppid: number;
  name: string;
  executablePath?: string;
  startedAt?: number;
}
export interface ClaudeProcessChain {
  claudePid: number;
  claudeStartedAt?: number;
  terminalPids: number[];
}
const validPid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 0;
function versionStore(): string {
  return `${os.homedir().replace(/\\/g, "/").replace(/\/$/, "")}/.local/share/claude/versions/`;
}
function isNativeClaude(row: ProcessAncestor): boolean {
  if (/^claude(?:\.exe)?$/i.test(row.name)) return true;
  if (!row.executablePath) return false;
  const file = row.executablePath.replace(/\\/g, "/").replace(/ \(deleted\)$/, "");
  const root = versionStore();
  const match = process.platform === "win32" ? file.toLowerCase().startsWith(root.toLowerCase()) : file.startsWith(root);
  return match && VERSION_FILE_RE.test(file.slice(root.length));
}
function isCli(row: ProcessAncestor): boolean { return isNativeClaude(row) || NPM_RUNTIME_RE.test(row.name); }

/** Native versions can be named 2.1.233; only trust such names in Claude's version store. */
export function findClaudeProcess(chain: ProcessAncestor[]): ClaudeProcessChain | null {
  let index = chain.findIndex(isNativeClaude);
  if (index < 0) index = chain.findIndex((p) => NPM_RUNTIME_RE.test(p.name));
  if (index < 0 || index + 1 >= chain.length) return null;
  const cli = chain[index];
  const terminalPids = chain.slice(index + 1).map((p) => p.pid).filter(validPid);
  return terminalPids.length ? { claudePid: cli.pid, claudeStartedAt: cli.startedAt, terminalPids } : null;
}

/** Start at the hook's parent: temporary hook shells are below the CLI. */
export async function getProcessAncestors(startPid: number): Promise<ProcessAncestor[]> {
  if (!validPid(startPid)) return [];
  try {
    if (process.platform === "win32") {
      // Walk one parent chain in one bounded subprocess. No command-line fields.
      const store = versionStore().replace(/'/g, "''");
      const script =
        `$taskPid = ${startPid}; $seenPids = @{}; $rows = @(); $foundCli = $false; $versionStore = '${store}'; ` +
        `for ($index = 0; $index -lt ${MAX_ANCESTORS} -and $taskPid -gt 0; $index++) { ` +
        "if ($seenPids.ContainsKey($taskPid)) { break }; $seenPids[$taskPid] = $true; " +
        "try { $item = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $taskPid) -ErrorAction Stop } catch { break }; " +
        "if (!$item) { break }; $startMs = $null; if ($item.CreationDate) { $startMs = ([DateTimeOffset]$item.CreationDate).ToUnixTimeMilliseconds() }; " +
        "$rows += @{ pid = [int]$item.ProcessId; ppid = [int]$item.ParentProcessId; name = $item.Name; executablePath = $item.ExecutablePath; startedAt = $startMs }; " +
        "if ($foundCli -and $item.Name -match '^(powershell|pwsh|bash|zsh|fish|sh)([.]exe)?$') { break }; " +
        "$exePath = ([string]$item.ExecutablePath).Replace([char]92, [char]47); " +
        "$nativeVersion = $exePath.StartsWith($versionStore, [StringComparison]::OrdinalIgnoreCase) -and " +
        "$exePath.Substring($versionStore.Length) -match '^[0-9]+[.][0-9]+[.][0-9]+(-[A-Za-z0-9.-]+)?([.]exe)?$'; " +
        "if ($nativeVersion -or $item.Name -match '^(claude|node|nodejs|bun)([.]exe)?$') { $foundCli = $true }; " +
        "$taskPid = [int]$item.ParentProcessId }; ConvertTo-Json -InputObject @($rows) -Compress";
      const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf-8", windowsHide: true, timeout: QUERY_TIMEOUT_MS });
      const rows: unknown = JSON.parse(stdout);
      if (!Array.isArray(rows)) return [];
      const chain: ProcessAncestor[] = [];
      let expectedPid = startPid;
      for (const value of rows.slice(0, MAX_ANCESTORS)) {
        if (!value || typeof value !== "object") break;
        const row = value as ProcessAncestor;
        if (!validPid(row.pid) || row.pid !== expectedPid || typeof row.name !== "string" || !Number.isSafeInteger(row.ppid)) break;
        chain.push({ pid: row.pid, ppid: row.ppid, name: row.name,
          ...(typeof row.executablePath === "string" && row.executablePath ? { executablePath: row.executablePath } : {}),
          ...(typeof row.startedAt === "number" && Number.isFinite(row.startedAt) ? { startedAt: row.startedAt } : {}) });
        expectedPid = row.ppid;
      }
      return chain;
    }
    const chain: ProcessAncestor[] = [];
    const seen = new Set<number>();
    let next = startPid;
    let foundCli = false;
    if (process.platform === "linux") {
      while (validPid(next) && !seen.has(next) && chain.length < MAX_ANCESTORS) {
        seen.add(next);
        let stat: string;
        try { stat = await fs.promises.readFile(`/proc/${next}/stat`, "utf-8"); }
        catch { break; } // An inaccessible upper ancestor must not discard Claude + its shell.
        const open = stat.indexOf("(");
        const close = stat.lastIndexOf(")");
        if (open < 0 || close < open) break;
        const ppid = Number(stat.slice(close + 1).trim().split(/\s+/)[1]);
        if (!Number.isSafeInteger(ppid)) break;
        let executablePath: string | undefined;
        try { executablePath = await fs.promises.readlink(`/proc/${next}/exe`); }
        catch { /* Process names still identify conventional native/npm installs. */ }
        const row = { pid: next, ppid, name: stat.slice(open + 1, close), executablePath };
        chain.push(row);
        if (foundCli && HOST_SHELL_RE.test(row.name)) break;
        foundCli ||= isCli(row);
        next = ppid;
      }
      try {
        const starts = await getProcessStartTimesAsync(chain.map((row) => row.pid));
        for (const row of chain) row.startedAt = starts.get(row.pid);
      } catch { /* Readable ancestry remains useful when process birth times are unknown. */ }
    } else if (process.platform === "darwin") {
      const { stdout } = await execFileP("ps", ["-axo", "pid=,ppid=,comm="],
        { encoding: "utf-8", timeout: QUERY_TIMEOUT_MS });
      const table = new Map<number, ProcessAncestor>();
      for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (match) table.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), name: match[3].split("/").pop()!, executablePath: match[3] });
      }
      while (validPid(next) && !seen.has(next) && chain.length < MAX_ANCESTORS) {
        const row = table.get(next);
        if (!row) break;
        seen.add(next); chain.push(row);
        if (foundCli && HOST_SHELL_RE.test(row.name)) break;
        foundCli ||= isCli(row);
        next = row.ppid;
      }
    }
    return chain;
  } catch {
    // Failed ancestry lookup cannot safely identify a terminal.
    return [];
  }
}
