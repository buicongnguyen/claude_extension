import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("../../../__mocks__/vscode"));

import * as vscode from "vscode";
// @ts-expect-error — _fireTerminalClose is a mock-only helper not in the real API
const { _fireTerminalClose } = vscode as { _fireTerminalClose: (t: unknown) => void };

import { createTerminalRegistry } from "../terminalRegistry";

function fakeTerminal(name = "t"): vscode.Terminal {
  return { name, show: vi.fn() } as unknown as vscode.Terminal;
}

describe("terminalRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers, reports membership, and lists ids", () => {
    const reg = createTerminalRegistry();
    const t = fakeTerminal();
    reg.register("s1", t);
    expect(reg.has("s1")).toBe(true);
    expect(reg.has("other")).toBe(false);
    expect(reg.ids()).toEqual(["s1"]);
  });

  it("view() focuses the registered terminal and returns false for unknown ids", () => {
    const reg = createTerminalRegistry();
    const t = fakeTerminal();
    reg.register("s1", t);
    expect(reg.view("s1")).toBe(true);
    expect((t.show as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(false);
    expect(reg.view("missing")).toBe(false);
  });

  it("emits onChange when an id is added or replaced", () => {
    const reg = createTerminalRegistry();
    const cb = vi.fn();
    reg.onChange(cb);
    const t = fakeTerminal();
    reg.register("s1", t);
    expect(cb).toHaveBeenCalledWith(["s1"]);
    cb.mockClear();
    reg.register("s1", t);
    expect(cb).not.toHaveBeenCalled();
    const t2 = fakeTerminal();
    reg.register("s1", t2);
    expect(cb).toHaveBeenCalledWith(["s1"]);
  });

  it("drops the id and emits onChange when a registered terminal closes", () => {
    const reg = createTerminalRegistry();
    const cb = vi.fn();
    reg.onChange(cb);
    const t = fakeTerminal();
    reg.register("s1", t);
    cb.mockClear();
    _fireTerminalClose(t);
    expect(reg.has("s1")).toBe(false);
    expect(cb).toHaveBeenCalledWith([]);
  });

  it("ignores closes for terminals it never registered", () => {
    const reg = createTerminalRegistry();
    const cb = vi.fn();
    reg.onChange(cb);
    reg.register("s1", fakeTerminal("kept"));
    cb.mockClear();
    _fireTerminalClose(fakeTerminal("stranger"));
    expect(cb).not.toHaveBeenCalled();
    expect(reg.has("s1")).toBe(true);
  });

  it("stops notifying after dispose() and clears state", () => {
    const reg = createTerminalRegistry();
    const cb = vi.fn();
    reg.onChange(cb);
    reg.register("s1", fakeTerminal());
    cb.mockClear();
    reg.dispose();
    expect(reg.ids()).toEqual([]);
    _fireTerminalClose(fakeTerminal());
    expect(cb).not.toHaveBeenCalled();
  });

  it("onChange returns a disposable that unsubscribes", () => {
    const reg = createTerminalRegistry();
    const cb = vi.fn();
    const sub = reg.onChange(cb);
    sub.dispose();
    reg.register("s1", fakeTerminal());
    expect(cb).not.toHaveBeenCalled();
  });
});

interface TestExecution {
  commandLine: { value: string };
}
interface TestExecutionEvent {
  terminal: vscode.Terminal;
  execution: TestExecution;
  exitCode?: number;
}
type TestExecutionListener = (event: TestExecutionEvent) => void;

function shellEvents(): {
  start(event: TestExecutionEvent): void;
  end(event: TestExecutionEvent): void;
  startDisposed: ReturnType<typeof vi.fn>;
  endDisposed: ReturnType<typeof vi.fn>;
} {
  let onStart: TestExecutionListener | undefined;
  let onEnd: TestExecutionListener | undefined;
  const startDisposed = vi.fn();
  const endDisposed = vi.fn();
  vi.spyOn(vscode.window, "onDidStartTerminalShellExecution").mockImplementation(
    ((listener: TestExecutionListener) => {
      onStart = listener;
      return { dispose: startDisposed };
    }) as never,
  );
  const api = vscode.window as unknown as {
    onDidEndTerminalShellExecution?: (listener: TestExecutionListener) => vscode.Disposable;
  };
  Object.defineProperty(api, "onDidEndTerminalShellExecution", {
    configurable: true,
    value: (listener: TestExecutionListener) => {
      onEnd = listener;
      return { dispose: endDisposed };
    },
  });
  return {
    start: (event) => onStart?.(event),
    end: (event) => onEnd?.(event),
    startDisposed,
    endDisposed,
  };
}

describe("terminalRegistry — execution lifetime", () => {
  const originalEndApi = Object.getOwnPropertyDescriptor(
    vscode.window,
    "onDidEndTerminalShellExecution",
  );

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEndApi) {
      Object.defineProperty(vscode.window, "onDidEndTerminalShellExecution", originalEndApi);
    } else {
      Reflect.deleteProperty(vscode.window, "onDidEndTerminalShellExecution");
    }
  });

  it("makes a failed Claude launch resumable without closing its shell", () => {
    const events = shellEvents();
    const reg = createTerminalRegistry();
    const terminal = fakeTerminal();
    const execution = { commandLine: { value: "claude --resume s1" } };
    const changed = vi.fn();
    reg.register("s1", terminal); // Manager registers before launching.
    reg.onChange(changed);
    events.start({ terminal, execution });
    events.end({ terminal, execution, exitCode: 127 });
    expect(reg.has("s1")).toBe(false);
    expect(reg.view("s1")).toBe(false);
    expect(changed).toHaveBeenCalledExactlyOnceWith([]);
    reg.dispose();
  });

  it("does not resurrect an exited session from a stale SessionStart hook", () => {
    const events = shellEvents();
    const reg = createTerminalRegistry();
    const terminal = fakeTerminal();
    const execution = { commandLine: { value: "claude" } };
    events.start({ terminal, execution });
    reg.register("s1", terminal); // SessionStart watcher discovers a bare CLI.
    events.end({ terminal, execution, exitCode: 0 });
    reg.register("s1", terminal); // Parent shell PID is still alive.
    expect(reg.ids()).toEqual([]);
    reg.dispose();
  });

  it("accepts the same session again once a new execution begins", () => {
    const events = shellEvents();
    const reg = createTerminalRegistry();
    const terminal = fakeTerminal();
    const first = { commandLine: { value: "claude --resume s1" } };
    events.start({ terminal, execution: first });
    reg.register("s1", terminal);
    events.end({ terminal, execution: first });
    const second = { commandLine: { value: "claude --resume s1" } };
    events.start({ terminal, execution: second });
    reg.register("s1", terminal);
    expect(reg.has("s1")).toBe(true);
    events.end({ terminal, execution: second });
    expect(reg.has("s1")).toBe(false);
    reg.dispose();
  });

  it("ignores an old completion after the same session gets a newer execution", () => {
    const events = shellEvents();
    const reg = createTerminalRegistry();
    const terminal = fakeTerminal();
    const first = { commandLine: { value: "claude --resume s1" } };
    const second = { commandLine: { value: "claude --resume s1" } };
    events.start({ terminal, execution: first });
    reg.register("s1", terminal);
    events.start({ terminal, execution: second });
    reg.register("s1", terminal);
    events.end({ terminal, execution: first });
    expect(reg.has("s1")).toBe(true);
    events.end({ terminal, execution: second });
    expect(reg.has("s1")).toBe(false);
    reg.dispose();
  });

  it("does not remove a replacement terminal when the old execution completes", () => {
    const events = shellEvents();
    const reg = createTerminalRegistry();
    const oldTerminal = fakeTerminal("old");
    const newTerminal = fakeTerminal("new");
    const first = { commandLine: { value: "claude --resume s1" } };
    const second = { commandLine: { value: "claude --resume s1" } };
    events.start({ terminal: oldTerminal, execution: first });
    reg.register("s1", oldTerminal);
    events.start({ terminal: newTerminal, execution: second });
    reg.register("s1", newTerminal);
    events.end({ terminal: oldTerminal, execution: first });
    expect(reg.view("s1")).toBe(true);
    expect(newTerminal.show).toHaveBeenCalledWith(false);
    expect(oldTerminal.show).not.toHaveBeenCalled();
    events.end({ terminal: newTerminal, execution: second });
    expect(reg.has("s1")).toBe(false);
    reg.dispose();
  });

  it("preserves execution ownership through repeated advisory registrations", () => {
    const events = shellEvents();
    const reg = createTerminalRegistry();
    const terminal = fakeTerminal();
    const execution = { commandLine: { value: "claude --continue" } };
    reg.register("s1", terminal);
    events.start({ terminal, execution });
    reg.register("s1", terminal);
    events.end({ terminal, execution });
    expect(reg.has("s1")).toBe(false);
    reg.dispose();
  });

  it("does not clear a newer session binding on the same terminal", () => {
    const events = shellEvents();
    const reg = createTerminalRegistry();
    const terminal = fakeTerminal();
    const first = { commandLine: { value: "claude --resume s1" } };
    const second = { commandLine: { value: "claude --resume s2" } };
    events.start({ terminal, execution: first });
    reg.register("s1", terminal);
    events.start({ terminal, execution: second });
    reg.register("s2", terminal);
    events.end({ terminal, execution: first });
    expect(reg.has("s2")).toBe(true);
    events.end({ terminal, execution: second });
    expect(reg.ids()).toEqual([]);
    reg.dispose();
  });

  it("ignores a completion for an unrelated terminal", () => {
    const events = shellEvents();
    const reg = createTerminalRegistry();
    const terminal = fakeTerminal();
    const stranger = fakeTerminal("stranger");
    const execution = { commandLine: { value: "claude" } };
    events.start({ terminal, execution });
    reg.register("s1", terminal);
    events.end({ terminal: stranger, execution });
    expect(reg.has("s1")).toBe(true);
    reg.dispose();
  });

  it("disposes both execution subscriptions", () => {
    const events = shellEvents();
    const reg = createTerminalRegistry();
    reg.dispose();
    expect(events.startDisposed).toHaveBeenCalledOnce();
    expect(events.endDisposed).toHaveBeenCalledOnce();
  });

  it("remains usable on hosts without the execution completion API", () => {
    const events = shellEvents();
    Reflect.deleteProperty(vscode.window, "onDidEndTerminalShellExecution");
    const reg = createTerminalRegistry();
    const terminal = fakeTerminal();
    const execution = { commandLine: { value: "claude" } };
    events.start({ terminal, execution });
    reg.register("s1", terminal);
    expect(reg.has("s1")).toBe(true);
    _fireTerminalClose(terminal);
    expect(reg.has("s1")).toBe(false);
    reg.dispose();
  });
  it("keeps stale hooks suppressed during an unrelated shell command", () => {
    const events = shellEvents();
    const reg = createTerminalRegistry();
    const terminal = fakeTerminal();
    const claude = { commandLine: { value: "claude --resume s1" } };
    events.start({ terminal, execution: claude });
    reg.register("s1", terminal);
    events.end({ terminal, execution: claude });
    const unrelated = { commandLine: { value: "Get-Date" } };
    events.start({ terminal, execution: unrelated });
    reg.register("s1", terminal);
    expect(reg.ids()).toEqual([]);
    events.end({ terminal, execution: unrelated });
    reg.register("s1", terminal);
    expect(reg.ids()).toEqual([]);
    reg.dispose();
  });

  it("does not mistake echoed Claude text for a fresh client", () => {
    const events = shellEvents();
    const reg = createTerminalRegistry();
    const terminal = fakeTerminal();
    const claude = { commandLine: { value: "claude --resume s1" } };
    events.start({ terminal, execution: claude });
    reg.register("s1", terminal);
    events.end({ terminal, execution: claude });
    const echo = { commandLine: { value: 'echo "claude --resume s1"' } };
    events.start({ terminal, execution: echo });
    reg.register("s1", terminal);
    expect(reg.ids()).toEqual([]);
    reg.dispose();
  });

  it("accepts a genuine new Claude command through a quoted executable path", () => {
    const events = shellEvents();
    const reg = createTerminalRegistry();
    const terminal = fakeTerminal();
    const claude = { commandLine: { value: "claude --resume s1" } };
    events.start({ terminal, execution: claude });
    reg.register("s1", terminal);
    events.end({ terminal, execution: claude });
    const fresh = {
      commandLine: { value: "& 'C:\\Program Files\\Claude\\claude.exe' --resume s1" },
    };
    events.start({ terminal, execution: fresh });
    reg.register("s1", terminal);
    expect(reg.has("s1")).toBe(true);
    events.end({ terminal, execution: fresh });
    expect(reg.has("s1")).toBe(false);
    reg.dispose();
  });

  it("blocks an old terminal's stale hook after the session moves to a new terminal", () => {
    const events = shellEvents();
    const reg = createTerminalRegistry();
    const oldTerminal = fakeTerminal("old");
    const newTerminal = fakeTerminal("new");
    const oldExecution = { commandLine: { value: "claude --resume s1" } };
    const newExecution = { commandLine: { value: "claude --resume s1" } };
    events.start({ terminal: oldTerminal, execution: oldExecution });
    reg.register("s1", oldTerminal);
    events.start({ terminal: newTerminal, execution: newExecution });
    reg.register("s1", newTerminal);
    events.end({ terminal: oldTerminal, execution: oldExecution });
    reg.register("s1", oldTerminal); // old SessionStart hook delivered late.
    reg.view("s1");
    expect(newTerminal.show).toHaveBeenCalledWith(false);
    expect(oldTerminal.show).not.toHaveBeenCalled();
    reg.dispose();
  });
});
