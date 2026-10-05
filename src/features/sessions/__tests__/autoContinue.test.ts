import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { _fireTerminalClose } from "../../../__mocks__/vscode";

const { files, descriptors, exec, nativeTerminal } = vi.hoisted(() => ({
  files: new Map<string, { header: number[]; realPath?: string; executable?: boolean; regular?: boolean }>(),
  descriptors: new Map<number, string>(),
  exec: vi.fn(),
  nativeTerminal: vi.fn(),
}));
vi.mock("os", () => ({ homedir: () => process.platform === "win32" ? "C:\\fake home" : "/fake home" }));
vi.mock("fs", () => ({
  constants: { X_OK: 1 },
  realpathSync: (file: string) => {
    const entry = files.get(file);
    if (!entry) throw new Error("missing");
    return entry.realPath ?? file;
  },
  statSync: (file: string) => ({ isFile: () => files.get(file)?.regular !== false }),
  accessSync: (file: string) => { if (files.get(file)?.executable === false) throw new Error("not executable"); },
  openSync: (file: string) => { descriptors.set(1, file); return 1; },
  readSync: (fd: number, target: Buffer) => {
    const header = files.get(descriptors.get(fd)!)?.header ?? [];
    Buffer.from(header).copy(target);
    return header.length;
  },
  closeSync: (fd: number) => descriptors.delete(fd),
}));
vi.mock("child_process", () => ({ execFile: (...args: unknown[]) => exec(...args) }));
vi.mock("../../../extension/terminal", () => ({ createNativeTerminal: (...args: unknown[]) => nativeTerminal(...args) }));
import { focusAutoContinueSession, launchAutoContinue, prepareAutoContinue } from "../autoContinue";
import { CONTINUE_TASK_PROMPT } from "../../../core/sessionContinuation";

const originalPlatform = process.platform;
const originalEnvironment = process.env;
function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}
function native(file: string, header = [0x4d, 0x5a, 0, 0]): void { files.set(file, { header }); }
function version(output = "2.1.289 (Claude Code)\n"): void {
  exec.mockImplementation((_file, _args, _options, callback) => callback(null, output));
}

beforeEach(() => {
  for (const terminal of [...vscode.window.terminals]) _fireTerminalClose(terminal);
  vi.restoreAllMocks();
  platform("win32");
  process.env = { Path: "C:\\on path" };
  files.clear(); descriptors.clear(); exec.mockReset(); nativeTerminal.mockReset();
  (vscode.window as { terminals: unknown[] }).terminals = [];
  nativeTerminal.mockImplementation((name, executable, args, cwd) => vscode.window.createTerminal({
    name, shellPath: executable, shellArgs: args, cwd,
  }));
  version();
});
afterEach(() => {
  for (const terminal of [...vscode.window.terminals]) _fireTerminalClose(terminal);
  process.env = originalEnvironment;
  platform(originalPlatform);
});

describe("native auto-continue preparation", () => {
  it("prefers the standalone installation and checks that exact executable without a shell", async () => {
    const installed = "C:\\fake home\\.local\\bin\\claude.exe";
    native(installed); native("C:\\on path\\claude.exe");
    expect(await prepareAutoContinue()).toEqual({ executable: installed, version: "2.1.289" });
    expect(exec).toHaveBeenCalledWith(installed, ["--version"], expect.objectContaining({ timeout: 5000, windowsHide: true }), expect.any(Function));
    expect(exec.mock.calls[0][2].shell).toBeUndefined();
  });

  it("resolves a native absolute PATH candidate and never probes cwd-relative entries", async () => {
    process.env = { Path: ".;relative;C:relative;C:\\on path" };
    native("C:\\on path\\claude.exe");
    expect((await prepareAutoContinue())?.executable).toBe("C:\\on path\\claude.exe");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("accepts quoted Windows PATH entries and keeps shell metacharacters literal", async () => {
    process.env = { Path: '"C:\\tools $(bad); version"' };
    // Semicolon is a PATH separator even inside quotes, so do not resolve an ambiguous entry.
    expect(await prepareAutoContinue()).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    process.env = { Path: '"C:\\tools $(bad)"' };
    native("C:\\tools $(bad)\\claude.exe");
    expect((await prepareAutoContinue())?.executable).toBe("C:\\tools $(bad)\\claude.exe");
    expect(exec.mock.calls[0][0]).toBe("C:\\tools $(bad)\\claude.exe");
  });

  it("rejects npm Windows scripts instead of asking a shell to execute them", async () => {
    native("C:\\on path\\claude.cmd"); native("C:\\on path\\claude.ps1");
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    expect(await prepareAutoContinue()).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("native installer"));
  });

  it("rejects Unix shell/node shims even when named claude", async () => {
    platform("linux"); process.env = { PATH: "/npm/bin" };
    native("/npm/bin/claude", [0x23, 0x21, 0x2f, 0x62]);
    expect(await prepareAutoContinue()).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it("follows an executable ELF symlink to the exact versioned binary", async () => {
    platform("linux"); process.env = { PATH: "/usr/bin" };
    const target = "/fake home/.local/share/claude/versions/2.1.289";
    files.set("/fake home/.local/bin/claude", { realPath: target, header: [] });
    native(target, [0x7f, 0x45, 0x4c, 0x46]);
    expect((await prepareAutoContinue())?.executable).toBe(target);
    expect(exec.mock.calls[0][0]).toBe(target);
    expect(descriptors.size).toBe(0);
  });

  it("rejects a non-executable Unix native file", async () => {
    platform("linux"); process.env = { PATH: "" };
    files.set("/fake home/.local/bin/claude", { header: [0x7f, 0x45, 0x4c, 0x46], executable: false });
    expect(await prepareAutoContinue()).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    [0xfe, 0xed, 0xfa, 0xcf], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe],
  ])("supports a macOS native binary header %j", async (...header) => {
    platform("darwin"); process.env = { PATH: "" };
    native("/fake home/.local/bin/claude", header);
    expect((await prepareAutoContinue())?.version).toBe("2.1.289");
  });

  it.each(["2.1.234", "2.1.235 (Claude Code)", "2.2.0", "3.0.0"])("accepts supported version %s", async output => {
    native("C:\\fake home\\.local\\bin\\claude.exe"); version(output);
    expect(await prepareAutoContinue()).toBeDefined();
  });

  it.each(["2.1.233", "2.0.999", "1.99.999", "2.1.289-beta", "unknown", "2.1.289\nother output"])("fails closed for unsupported or unknown version %s", async output => {
    native("C:\\fake home\\.local\\bin\\claude.exe"); version(output);
    expect(await prepareAutoContinue()).toBeUndefined();
    expect(nativeTerminal).not.toHaveBeenCalled();
  });

  it("reports a failed or timed-out version probe without creating a terminal", async () => {
    native("C:\\fake home\\.local\\bin\\claude.exe");
    exec.mockImplementation((_file, _args, _options, callback) => callback(new Error("timeout"), ""));
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    expect(await prepareAutoContinue()).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Could not check"));
    expect(nativeTerminal).not.toHaveBeenCalled();
  });
});

describe("native waiting terminal lifecycle", () => {
  const plan = { executable: 'C:\\user $(keep)\\claude.exe', version: "2.1.289" };
  const prompt = CONTINUE_TASK_PROMPT;

  it("passes JSON, history id, normal permissions and prompt as argv without sending shell text", () => {
    launchAutoContinue(plan, "waiting", "C:\\project with spaces", "session-1", prompt);
    expect(nativeTerminal).toHaveBeenCalledWith("waiting", plan.executable, [
      "--resume", "session-1", "--settings", '{"autoContinueAtUsageLimit":true}',
      "--permission-mode", "default", prompt,
    ], "C:\\project with spaces", "session-1");
    expect(vscode.window.terminals[0].sentText).toEqual([]);
  });

  it("focuses the live terminal on repeated clicks without resubmitting a continuation", () => {
    launchAutoContinue(plan, "waiting", "/repo", "session-1", prompt);
    const show = vi.spyOn(vscode.window.terminals[0], "show");
    expect(focusAutoContinueSession("session-1")).toBe(true);
    launchAutoContinue(plan, "waiting", "/repo", "session-1", prompt);
    expect(nativeTerminal).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("allows a new launch after the native client closes", () => {
    launchAutoContinue(plan, "waiting", "/repo", "session-1", prompt);
    _fireTerminalClose(vscode.window.terminals[0]);
    expect(focusAutoContinueSession("session-1")).toBe(false);
    launchAutoContinue(plan, "waiting", "/repo", "session-1", prompt);
    expect(nativeTerminal).toHaveBeenCalledTimes(2);
  });

  it("clears an exited or missing terminal even if a close event was missed", () => {
    launchAutoContinue(plan, "waiting", "/repo", "session-1", prompt);
    vscode.window.terminals[0].exitStatus = { code: 0 };
    expect(focusAutoContinueSession("session-1")).toBe(false);
    launchAutoContinue(plan, "waiting", "/repo", "session-1", prompt);
    (vscode.window as { terminals: unknown[] }).terminals = [];
    expect(focusAutoContinueSession("session-1")).toBe(false);
  });

  it("does not clear another waiting session when a terminal closes", () => {
    launchAutoContinue(plan, "one", "/repo", "session-1", prompt);
    launchAutoContinue(plan, "two", "/repo", "session-2", prompt);
    _fireTerminalClose(vscode.window.terminals[0]);
    expect(focusAutoContinueSession("session-1")).toBe(false);
    expect(focusAutoContinueSession("session-2")).toBe(true);
  });

  it("rejects an invalid history id at the launch boundary", () => {
    launchAutoContinue(plan, "waiting", "/repo", "id;bad", prompt);
    expect(nativeTerminal).not.toHaveBeenCalled();
  });
});

describe("restored native waiting terminal", () => {
  function restored(overrides: Record<string, unknown> = {}) {
    const options = {
      name: "restored wait", shellPath: "C:\\removed version\\claude.exe",
      shellArgs: ["--resume", "session-1", "--settings", '{"autoContinueAtUsageLimit":true}',
        "--permission-mode", "default", CONTINUE_TASK_PROMPT],
      ...overrides,
    };
    const term = vscode.window.createTerminal(options);
    Object.assign(term, { creationOptions: options });
    return term;
  }

  it("focuses an exact restored waiter even if its versioned executable was removed by an update", () => {
    const term = restored();
    const show = vi.spyOn(term, "show");
    expect(files.size).toBe(0);
    expect(focusAutoContinueSession("session-1")).toBe(true);
    launchAutoContinue({ executable: "C:\\new version\\claude.exe", version: "2.1.289" }, "wait", "/repo", "session-1", CONTINUE_TASK_PROMPT);
    expect(show).toHaveBeenCalledTimes(2);
    expect(nativeTerminal).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    { shellPath: "relative\\claude.exe" },
    { shellArgs: "--resume session-1" },
    { shellArgs: ["--resume", "session-1", "--settings", '{"autoContinueAtUsageLimit":false}', "--permission-mode", "default", CONTINUE_TASK_PROMPT] },
    { shellArgs: ["--resume", "session-1", "--settings", '{"autoContinueAtUsageLimit":true}', "--permission-mode", "bypassPermissions", CONTINUE_TASK_PROMPT] },
    { shellArgs: ["--resume", "session-1", "--settings", '{"autoContinueAtUsageLimit":true}', "--permission-mode", "default", "another request"] },
    { shellArgs: ["--resume", "session-1", "--settings", '{"autoContinueAtUsageLimit":true}', "--permission-mode", "default", CONTINUE_TASK_PROMPT, "--extra"] },
  ])("does not adopt a merely similar terminal %j", overrides => {
    restored(overrides);
    expect(focusAutoContinueSession("session-1")).toBe(false);
  });

  it("does not adopt a different session or an exited restored waiter", () => {
    const term = restored();
    expect(focusAutoContinueSession("session-2")).toBe(false);
    term.exitStatus = { code: 0 };
    expect(focusAutoContinueSession("session-1")).toBe(false);
  });

  it("removes an adopted waiter when its terminal closes", () => {
    const term = restored();
    expect(focusAutoContinueSession("session-1")).toBe(true);
    _fireTerminalClose(term);
    expect(focusAutoContinueSession("session-1")).toBe(false);
  });

  it("refuses a changed continuation prompt at the launch boundary", () => {
    launchAutoContinue({ executable: "C:\\native\\claude.exe", version: "2.1.289" }, "wait", "/repo", "session-1", "arbitrary request");
    expect(nativeTerminal).not.toHaveBeenCalled();
  });
});
