import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

const state = vi.hoisted(() => ({ override: undefined as Record<string, string> | undefined }));
vi.mock("../claudeCliEnvironment", () => ({ nativeClaudeTerminalEnvironment: () => state.override }));
const { nativeClaudeTerminalEnvironment } = await vi.importActual<typeof import("../claudeCliEnvironment")>("../claudeCliEnvironment");
import { createTerminal } from "../../extension/terminal";

const windowsBin = "C:\\Users\\Sample User\\.local\\bin";
function windowsOptions(environment: Record<string, string | undefined> = { Path: "C:\\Windows;D:\\existing" }) {
  return { platform: "win32" as const, homeDirectory: "C:\\Users\\Sample User", environment, isFile: (file: string) => file === `${windowsBin}\\claude.exe` };
}

beforeEach(() => {
  vi.restoreAllMocks(); state.override = undefined;
  Object.assign(vscode.window, { terminals: [] });
  vscode.window.tabGroups.all = [];
});

describe("standalone Claude CLI environment", () => {
  it("appends the native bin while preserving existing Windows PATH priority and key casing", () => {
    const options = windowsOptions();
    expect(nativeClaudeTerminalEnvironment(options)).toEqual({ Path: `C:\\Windows;D:\\existing;${windowsBin}` });
    expect(options.environment).toEqual({ Path: "C:\\Windows;D:\\existing" });
  });

  it("recognizes an existing Windows entry without case sensitivity or trailing-separator differences", () => {
    expect(nativeClaudeTerminalEnvironment(windowsOptions({ PATH: "C:\\USERS\\SAMPLE USER\\.LOCAL\\BIN\\;C:\\Windows" }))).toBeUndefined();
  });

  it("does not change the environment when the standalone binary is missing or inaccessible", () => {
    expect(nativeClaudeTerminalEnvironment({ ...windowsOptions(), isFile: () => false })).toBeUndefined();
    expect(nativeClaudeTerminalEnvironment({ ...windowsOptions(), isFile: () => { throw new Error("inaccessible"); } })).toBeUndefined();
  });

  it("uses environment data for spaces and shell metacharacters without constructing shell text", () => {
    const homeDirectory = "C:\\Users\\Test & (safe) $name `quoted'";
    const isFile = vi.fn(() => true);
    const result = nativeClaudeTerminalEnvironment({ ...windowsOptions({ Path: "C:\\Windows" }), homeDirectory, isFile });
    expect(result).toEqual({ Path: `C:\\Windows;${homeDirectory}\\.local\\bin` });
    expect(isFile).toHaveBeenCalledExactlyOnceWith(`${homeDirectory}\\.local\\bin\\claude.exe`);
  });

  it("works without a current PATH or signed-in account and does not copy unrelated environment values", () => {
    const environment = Object.freeze({ UNRELATED_SECRET: "synthetic-secret" });
    const result = nativeClaudeTerminalEnvironment(windowsOptions(environment));
    expect(result).toEqual({ PATH: windowsBin });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });

  it("does not add an extra empty PATH entry after an existing trailing delimiter", () => {
    expect(nativeClaudeTerminalEnvironment(windowsOptions({ Path: "C:\\Windows;" }))).toEqual({ Path: `C:\\Windows;${windowsBin}` });
  });

  it("appends the native Unix bin using colon delimiters and case-sensitive entries", () => {
    const options = { platform: "linux" as const, homeDirectory: "/home/Sample User", environment: { PATH: "/usr/bin:/HOME/SAMPLE USER/.LOCAL/BIN" }, isFile: vi.fn(() => true) };
    expect(nativeClaudeTerminalEnvironment(options)).toEqual({ PATH: "/usr/bin:/HOME/SAMPLE USER/.LOCAL/BIN:/home/Sample User/.local/bin" });
    expect(options.isFile).toHaveBeenCalledExactlyOnceWith("/home/Sample User/.local/bin/claude");
    expect(nativeClaudeTerminalEnvironment({ ...options, environment: { PATH: "/home/Sample User/.local/bin/:/usr/bin" } })).toBeUndefined();
  });

  it("does not resolve a native binary from a relative home path", () => {
    const isFile = vi.fn(() => true);
    expect(nativeClaudeTerminalEnvironment({ ...windowsOptions(), homeDirectory: "relative", isFile })).toBeUndefined();
    expect(isFile).not.toHaveBeenCalled();
  });
});

describe("Manager terminal environment integration", () => {
  it("creates a fresh corrected terminal instead of reusing an existing uncorrected shell", () => {
    state.override = { Path: `C:\\Windows;${windowsBin}` };
    const existing = { name: "login", exitStatus: undefined, state: { isInteractedWith: false } };
    Object.assign(vscode.window, { terminals: [existing] });
    const create = vi.spyOn(vscode.window, "createTerminal");
    const terminal = createTerminal("login");
    expect(terminal).not.toBe(existing);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "login", env: state.override }));
  });

  it("preserves empty-terminal reuse when no environment correction is required", () => {
    const existing = { name: "login", exitStatus: undefined, state: { isInteractedWith: false } };
    Object.assign(vscode.window, { terminals: [existing] });
    const create = vi.spyOn(vscode.window, "createTerminal");
    expect(createTerminal("login")).toBe(existing);
    expect(create).not.toHaveBeenCalled();
  });
});
