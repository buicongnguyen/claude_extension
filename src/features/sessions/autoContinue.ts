/** Native, interactive usage-limit waiting. Never submits into the graphical chat. */
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { createNativeTerminal } from "../../extension/terminal";
import { CONTINUE_TASK_PROMPT } from "../../core/sessionContinuation";

export interface AutoContinuePlan {
  executable: string;
  version: string;
}

const MINIMUM_VERSION = [2, 1, 234] as const;
const waitingTerminals = new Map<string, vscode.Terminal>();
const closedTerminals = new WeakSet<vscode.Terminal>();
let closeListener: vscode.Disposable | undefined;

function forgetTerminal(sessionId: string): void {
  waitingTerminals.delete(sessionId);
  if (waitingTerminals.size === 0) {
    closeListener?.dispose();
    closeListener = undefined;
  }
}

function trackTerminal(sessionId: string, term: vscode.Terminal): void {
  waitingTerminals.set(sessionId, term);
  if (!closeListener) closeListener = vscode.window.onDidCloseTerminal(closed => {
    closedTerminals.add(closed);
    for (const [id, existing] of waitingTerminals) {
      if (existing === closed) forgetTerminal(id);
    }
  });
}

function autoContinueArgs(sessionId: string): string[] {
  return ["--resume", sessionId, "--settings", JSON.stringify({ autoContinueAtUsageLimit: true }),
    "--permission-mode", "default", CONTINUE_TASK_PROMPT];
}

/** Persistence restores the PTY without restoring this extension's in-memory map. */
function matchesRestoredTerminal(term: vscode.Terminal, sessionId: string): boolean {
  if (term.exitStatus !== undefined || closedTerminals.has(term)) return false;
  const options = term.creationOptions as vscode.TerminalOptions;
  if (!options || typeof options.shellPath !== "string" || !Array.isArray(options.shellArgs)) return false;
  const expected = autoContinueArgs(sessionId);
  const args = options.shellArgs;
  if (args.length !== expected.length || !expected.every((arg, index) => args[index] === arg)) return false;
  // Updating Claude can remove the versioned executable while its PTY is still alive.
  // Revealing an existing terminal executes nothing, so no filesystem probe is needed.
  const paths = process.platform === "win32" ? path.win32 : path.posix;
  return paths.isAbsolute(options.shellPath);
}

/** A second click reveals the existing native client rather than resubmitting a turn. */
export function focusAutoContinueSession(sessionId: string): boolean {
  let term = waitingTerminals.get(sessionId);
  if (term && (term.exitStatus !== undefined || !vscode.window.terminals.includes(term))) {
    forgetTerminal(sessionId);
    term = undefined;
  }
  if (!term) {
    term = vscode.window.terminals.find(candidate => matchesRestoredTerminal(candidate, sessionId));
    if (!term) return false;
    trackTerminal(sessionId, term);
  }
  try { term.show(); return true; }
  catch { forgetTerminal(sessionId); return false; }
}
function isNativeExecutable(executable: string): boolean {
  let fd: number | undefined;
  try {
    if (!fs.statSync(executable).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(executable, fs.constants.X_OK);
    fd = fs.openSync(executable, "r");
    const header = Buffer.alloc(4);
    if (fs.readSync(fd, header, 0, 4, 0) !== 4) return false;
    if (process.platform === "win32") return header[0] === 0x4d && header[1] === 0x5a;
    if (process.platform === "linux") return header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    // Mach-O (both byte orders), including the universal/fat variants.
    return [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]
      .includes(header.readUInt32BE(0));
  } catch { return false; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } } }
}

/** Ignore cwd-relative PATH entries and npm scripts: a shell is never used here. */
function findNativeClaude(): string | undefined {
  if (!["win32", "linux", "darwin"].includes(process.platform)) return undefined;
  const windows = process.platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const fileName = windows ? "claude.exe" : "claude";
  const home = os.homedir();
  const pathKey = windows
    ? Object.keys(process.env).find(key => key.toLowerCase() === "path") ?? "PATH"
    : "PATH";
  const directories = (process.env[pathKey] ?? "").split(windows ? ";" : ":");
  const candidates = paths.isAbsolute(home) ? [paths.join(home, ".local", "bin", fileName)] : [];
  for (let directory of directories) {
    if (windows && directory.startsWith('"') && directory.endsWith('"')) directory = directory.slice(1, -1);
    if (paths.isAbsolute(directory)) candidates.push(paths.join(directory, fileName));
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    try {
      const executable = fs.realpathSync(candidate);
      if (!paths.isAbsolute(executable)) continue;
      const key = windows ? executable.toLowerCase() : executable;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isNativeExecutable(executable)) return executable;
    } catch { /* missing or inaccessible candidate */ }
  }
  return undefined;
}

function parseSupportedVersion(output: string): string | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?: \(Claude Code\))?$/.exec(output.trim());
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) return undefined;
  for (let i = 0; i < MINIMUM_VERSION.length; i++) {
    if (parts[i] > MINIMUM_VERSION[i]) return parts.join(".");
    if (parts[i] < MINIMUM_VERSION[i]) return undefined;
  }
  return parts.join(".");
}

/** Check the exact binary that the terminal will launch; --version makes no model request. */
export async function prepareAutoContinue(): Promise<AutoContinuePlan | undefined> {
  const executable = findNativeClaude();
  if (!executable) {
    void vscode.window.showErrorMessage("Wait and auto-continue requires the native Claude Code CLI, version 2.1.234 or later. Install or update it using Claude Code's native installer; the graphical extension and npm command scripts cannot provide this terminal handoff.");
    return undefined;
  }
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(executable, ["--version"], {
        encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true,
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const version = parseSupportedVersion(output);
    if (version) return { executable, version };
    void vscode.window.showErrorMessage("Wait and auto-continue requires Claude Code 2.1.234 or later. Update the native CLI and try again.");
  } catch {
    void vscode.window.showErrorMessage("Could not check the native Claude Code version. Make sure the CLI can start, then try Wait and auto-continue again.");
  }
  return undefined;
}

/** Launch directly in a PTY: JSON and prompts are argv, never evaluated by a shell. */
export function launchAutoContinue(
  plan: AutoContinuePlan,
  name: string,
  cwd: string,
  sessionId: string,
  prompt: string,
): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(sessionId)) {
    void vscode.window.showErrorMessage("Cannot resume: the session id is invalid.");
    return;
  }
  if (prompt !== CONTINUE_TASK_PROMPT) {
    void vscode.window.showErrorMessage("Cannot start waiting: the continuation request is invalid.");
    return;
  }
  if (focusAutoContinueSession(sessionId)) return;
  const term = createNativeTerminal(name, plan.executable, autoContinueArgs(sessionId), cwd, sessionId);
  trackTerminal(sessionId, term);
  term.show();
}
