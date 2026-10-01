import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("../../../__mocks__/vscode"));

import * as vscode from "vscode";
import { createTerminalLinker, extractResumeId } from "../terminalLinker";
import { createTerminalRegistry } from "../terminalRegistry";

const UUID = "01abcdef-2345-6789-abcd-ef0123456789";

describe("extractResumeId", () => {
  it("pulls the uuid from a plain claude --resume invocation", () => {
    expect(extractResumeId(`claude --resume ${UUID}`)).toBe(UUID);
  });

  it("ignores invocations without --resume", () => {
    expect(extractResumeId("claude --continue")).toBeNull();
    expect(extractResumeId("claude")).toBeNull();
  });

  it("matches after a path prefix or env var", () => {
    expect(extractResumeId(`/usr/local/bin/claude --resume ${UUID}`)).toBe(UUID);
    expect(extractResumeId(`ANTHROPIC_API_KEY=x claude --resume ${UUID}`)).toBe(UUID);
  });

  it("matches after a shell separator", () => {
    expect(extractResumeId(`cd /tmp && claude --resume ${UUID}`)).toBe(UUID);
    expect(extractResumeId(`echo hi ; claude --resume ${UUID}`)).toBe(UUID);
    expect(extractResumeId(`true | claude --resume ${UUID}`)).toBe(UUID);
  });

  it("matches extra flags between claude and --resume", () => {
    expect(extractResumeId(`claude --dangerously-skip-permissions --resume ${UUID}`)).toBe(UUID);
  });

  it("lowercases the captured id so the registry stays case-insensitive", () => {
    expect(extractResumeId(`claude --resume ${UUID.toUpperCase()}`)).toBe(UUID);
  });

  it("rejects malformed uuids", () => {
    expect(extractResumeId("claude --resume not-a-uuid")).toBeNull();
    expect(extractResumeId("claude --resume 12345")).toBeNull();
  });

  it("does not match unrelated commands that happen to contain 'resume'", () => {
    expect(extractResumeId(`other-tool --resume ${UUID}`)).toBeNull();
  });
});

describe("createTerminalLinker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a no-op disposable when the host VS Code lacks the API", () => {
    const reg = createTerminalRegistry();
    const before = (vscode.window as unknown as { onDidStartTerminalShellExecution?: unknown })
      .onDidStartTerminalShellExecution;
    delete (vscode.window as unknown as { onDidStartTerminalShellExecution?: unknown })
      .onDidStartTerminalShellExecution;
    try {
      const sub = createTerminalLinker(reg);
      expect(typeof sub.dispose).toBe("function");
      sub.dispose();
    } finally {
      if (before !== undefined) {
        (vscode.window as unknown as { onDidStartTerminalShellExecution?: unknown })
          .onDidStartTerminalShellExecution = before;
      }
    }
  });

  it("registers the session id for the terminal whose shell ran claude --resume", () => {
    const reg = createTerminalRegistry();
    let listener: ((e: unknown) => void) | undefined;
    (vscode.window as unknown as {
      onDidStartTerminalShellExecution: (
        cb: (e: unknown) => void,
      ) => { dispose: () => void };
    }).onDidStartTerminalShellExecution = (cb) => {
      listener = cb;
      return { dispose: () => {} };
    };
    createTerminalLinker(reg);
    const fakeTerm = { name: "user-tab", show: vi.fn() } as unknown as vscode.Terminal;
    listener?.({
      terminal: fakeTerm,
      execution: { commandLine: { value: `claude --resume ${UUID}` } },
    });
    expect(reg.has(UUID)).toBe(true);
    expect(reg.ids()).toContain(UUID);
  });

  it("ignores command lines without a resume id", () => {
    const reg = createTerminalRegistry();
    let listener: ((e: unknown) => void) | undefined;
    (vscode.window as unknown as {
      onDidStartTerminalShellExecution: (
        cb: (e: unknown) => void,
      ) => { dispose: () => void };
    }).onDidStartTerminalShellExecution = (cb) => {
      listener = cb;
      return { dispose: () => {} };
    };
    createTerminalLinker(reg);
    listener?.({
      terminal: { name: "x", show: vi.fn() } as unknown as vscode.Terminal,
      execution: { commandLine: { value: "ls -la" } },
    });
    expect(reg.ids()).toEqual([]);
  });
});

describe("terminalLinker — quoted CLI commands", () => {
  it("recognizes a quoted Windows claude.exe path and UUID", () => {
    expect(
      extractResumeId("& 'C:\\Program Files\\Claude\\claude.exe' --resume '" + UUID + "'"),
    ).toBe(UUID);
    expect(
      extractResumeId('"C:\\Program Files\\Claude\\claude.exe" --resume "' + UUID + '"'),
    ).toBe(UUID);
  });

  it("does not accept a UUID prefix followed by additional characters", () => {
    expect(extractResumeId("claude --resume " + UUID + "garbage")).toBeNull();
  });
});

describe("terminalLinker — launch completion", () => {
  type Event = {
    terminal: vscode.Terminal;
    execution: { commandLine: { value: string } };
    exitCode?: number;
  };
  const startDescriptor = Object.getOwnPropertyDescriptor(
    vscode.window,
    "onDidStartTerminalShellExecution",
  );
  const endDescriptor = Object.getOwnPropertyDescriptor(
    vscode.window,
    "onDidEndTerminalShellExecution",
  );

  afterEach(() => {
    if (startDescriptor) {
      Object.defineProperty(vscode.window, "onDidStartTerminalShellExecution", startDescriptor);
    } else {
      Reflect.deleteProperty(vscode.window, "onDidStartTerminalShellExecution");
    }
    if (endDescriptor) {
      Object.defineProperty(vscode.window, "onDidEndTerminalShellExecution", endDescriptor);
    } else {
      Reflect.deleteProperty(vscode.window, "onDidEndTerminalShellExecution");
    }
  });

  it("links a failed resume then removes it when that command returns to the shell", () => {
    const starts = new Set<(event: Event) => void>();
    const ends = new Set<(event: Event) => void>();
    Object.defineProperty(vscode.window, "onDidStartTerminalShellExecution", {
      configurable: true,
      value: (listener: (event: Event) => void) => {
        starts.add(listener);
        return { dispose: () => starts.delete(listener) };
      },
    });
    Object.defineProperty(vscode.window, "onDidEndTerminalShellExecution", {
      configurable: true,
      value: (listener: (event: Event) => void) => {
        ends.add(listener);
        return { dispose: () => ends.delete(listener) };
      },
    });
    const registry = createTerminalRegistry();
    const linker = createTerminalLinker(registry);
    const event = {
      terminal: { name: "resume", show: vi.fn() } as unknown as vscode.Terminal,
      execution: { commandLine: { value: "claude --resume " + UUID } },
      exitCode: 1,
    };
    for (const listener of starts) listener(event);
    expect(registry.has(UUID)).toBe(true);
    for (const listener of ends) listener(event);
    expect(registry.ids()).toEqual([]);
    registry.register(UUID, event.terminal);
    expect(registry.ids()).toEqual([]); // stale hook cannot restore a dead launch.
    linker.dispose();
    registry.dispose();
    expect(starts.size).toBe(0);
    expect(ends.size).toBe(0);
  });
});
