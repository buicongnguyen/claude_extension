import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { exec, read, readlink, starts } = vi.hoisted(() => ({ exec: vi.fn(), read: vi.fn(), readlink: vi.fn(), starts: vi.fn() }));
vi.mock("child_process", () => ({ execFile: (...args: unknown[]) => exec(...args) }));
vi.mock("fs", () => ({ promises: { readFile: read, readlink } }));
vi.mock("os", () => ({ homedir: () => "/fake-home" }));
vi.mock("../procTime", () => ({ getProcessStartTimesAsync: starts }));
import { findClaudeProcess, getProcessAncestors } from "../processTree";
const platform = process.platform;
function setPlatform(value: NodeJS.Platform) { Object.defineProperty(process, "platform", { value, configurable: true }); }
beforeEach(() => { exec.mockReset(); read.mockReset(); readlink.mockReset(); readlink.mockRejectedValue(new Error("no path")); starts.mockReset(); starts.mockImplementation(async (pids: number[]) => new Map(pids.map(pid => [pid, 1234]))); });
afterEach(() => setPlatform(platform));
function mockOutput(stdout: string) {
  exec.mockImplementation((_file, _args, _opts, callback) => callback(null, { stdout }));
}
const chain = [
  { pid: 500, ppid: 400, name: "bash.exe" },
  { pid: 400, ppid: 300, name: "claude.exe", startedAt: 1234 },
  { pid: 300, ppid: 200, name: "cmd.exe" },
  { pid: 200, ppid: 1, name: "powershell.exe" },
];
describe("Claude hook ancestry", () => {
  it("skips the hook shell and separates the native Claude PID from terminal candidates", () => {
    expect(findClaudeProcess(chain)).toEqual({ claudePid: 400, claudeStartedAt: 1234, terminalPids: [300, 200] });
  });
  it("supports npm/Bun installs and rejects an unidentified or unparented CLI", () => {
    expect(findClaudeProcess(chain.map(row => row.pid === 400 ? { ...row, name: "node.exe" } : row))?.claudePid).toBe(400);
    expect(findClaudeProcess([{ pid: 400, ppid: 0, name: "claude" }])).toBeNull();
    expect(findClaudeProcess([{ pid: 500, ppid: 200, name: "bash" }, { pid: 200, ppid: 0, name: "powershell" }])).toBeNull();
  });
  it("Windows queries one bounded parent chain without command lines", async () => {
    setPlatform("win32"); mockOutput(JSON.stringify(chain));
    expect(await getProcessAncestors(500)).toEqual(chain);
    const [, args, options] = exec.mock.calls[0];
    expect(args.at(-1)).toContain("ParentProcessId"); expect(args.at(-1)).not.toContain("CommandLine");
    expect(options).toMatchObject({ timeout: 8000, windowsHide: true });
    expect(await getProcessAncestors(-1)).toEqual([]); expect(exec).toHaveBeenCalledOnce();
  });
  it("Linux follows /proc parents and handles a command name containing parentheses", async () => {
    setPlatform("linux");
    const rows: Record<string, string> = { "/proc/500/stat": "500 (bash (hook)) S 400 0", "/proc/400/stat": "400 (claude) S 200 0", "/proc/200/stat": "200 (bash) S 0 0" };
    read.mockImplementation((file: string) => Promise.resolve(rows[file]));
    const result = await getProcessAncestors(500);
    expect(result.map(row => row.pid)).toEqual([500, 400, 200]);
    expect(findClaudeProcess(result)?.terminalPids).toEqual([200]);
  });
  it("macOS follows ps parent IDs and trims executable paths", async () => {
    setPlatform("darwin"); mockOutput("500 400 /bin/bash\n400 200 /usr/local/bin/claude\n200 0 /bin/zsh\n");
    expect(findClaudeProcess(await getProcessAncestors(500))).toEqual({ claudePid: 400, claudeStartedAt: undefined, terminalPids: [200] });
  });
  it("fails closed when an OS ancestry query fails", async () => {
    setPlatform("win32"); exec.mockImplementation((_file, _args, _opts, callback) => callback(new Error("unavailable")));
    expect(await getProcessAncestors(500)).toEqual([]);
  });
});

describe("usable ancestry prefix", () => {
  it("keeps Claude and the user shell when a higher Linux ancestor is inaccessible", async () => {
    setPlatform("linux");
    const rows: Record<string, string> = {
      "/proc/500/stat": "500 (bash) S 400 0",
      "/proc/400/stat": "400 (claude) S 200 0",
      "/proc/200/stat": "200 (bash) S 1 0",
    };
    read.mockImplementation(async (file: string) => {
      if (!rows[file]) throw Object.assign(new Error("hidden ancestor"), { code: "EACCES" });
      return rows[file];
    });

    expect(findClaudeProcess(await getProcessAncestors(500))).toEqual({
      claudePid: 400, claudeStartedAt: 1234, terminalPids: [200],
    });
  });
  it("preserves readable Linux parent links when their start-time stat is unavailable", async () => {
    setPlatform("linux");
    read.mockImplementation(async (file: string) => file === "/proc/400/stat"
      ? "400 (claude) S 200 0" : "200 (bash) S 0 0");
    starts.mockResolvedValue(new Map());
    expect(findClaudeProcess(await getProcessAncestors(400))).toEqual({
      claudePid: 400, claudeStartedAt: undefined, terminalPids: [200],
    });
  });
});

describe("native version executable identity", () => {
  it("recognizes numeric native binaries only inside the runtime home Claude version store", () => {
    setPlatform("linux");
    const rows = [
      { pid: 400, ppid: 200, name: "2.1.233", executablePath: "/fake-home/.local/share/claude/versions/2.1.233" },
      { pid: 200, ppid: 100, name: "bash" },
      { pid: 100, ppid: 0, name: "node" },
    ];
    expect(findClaudeProcess(rows)?.claudePid).toBe(400);
    expect(findClaudeProcess(rows.slice(0, 2).map(row => ({ ...row, executablePath: "/unrelated/2.1.233" })))).toBeNull();
    expect(findClaudeProcess(rows.slice(0, 2).map(row => ({ ...row, executablePath: "/fake-home/.local/share/claude/versions/../unrelated/2.1.233" })))).toBeNull();
  });
  it("reads Linux executable identity and stops after Claude's host shell before a distant Node", async () => {
    setPlatform("linux");
    const rows: Record<string, string> = {
      "/proc/500/stat": "500 (sh) S 400 0", "/proc/400/stat": "400 (2.1.233) S 200 0", "/proc/200/stat": "200 (bash) S 100 0",
    };
    read.mockImplementation(async (file: string) => rows[file]);
    readlink.mockImplementation(async (file: string) => file === "/proc/400/exe" ? "/fake-home/.local/share/claude/versions/2.1.233" : "/bin/sh");
    const result = await getProcessAncestors(500);
    expect(result.map(row => row.pid)).toEqual([500, 400, 200]);
    expect(findClaudeProcess(result)).toEqual({ claudePid: 400, claudeStartedAt: 1234, terminalPids: [200] });
    expect(starts).toHaveBeenCalledExactlyOnceWith([500, 400, 200]);
    expect(read).not.toHaveBeenCalledWith("/proc/100/stat", "utf-8");
  });
  it("uses macOS full executable paths for native version identity", async () => {
    setPlatform("darwin");
    mockOutput("500 400 /bin/sh\n400 200 /fake-home/.local/share/claude/versions/2.1.233\n200 100 /bin/zsh\n100 0 /usr/bin/node\n");
    const result = await getProcessAncestors(500);
    expect(result.map(row => row.pid)).toEqual([500, 400, 200]);
    expect(findClaudeProcess(result)?.claudePid).toBe(400);
  });
});
