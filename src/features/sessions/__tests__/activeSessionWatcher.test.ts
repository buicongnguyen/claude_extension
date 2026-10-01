import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
const { fsReadMock, startTimes } = vi.hoisted(() => ({ fsReadMock: vi.fn(), startTimes: vi.fn() }));
vi.mock("fs", () => ({ readFileSync: fsReadMock }));
vi.mock("../../../core/config", () => ({ SESSION_ACTIVE_FILE: "/fake/active-sessions.json" }));
vi.mock("../procTime", () => ({ getProcessStartTimesAsync: startTimes }));
import { readActiveSessions, filterReusedPpids, startActiveSessionWatcher, type ActiveEntry } from "../activeSessionWatcher";
import { createTerminalRegistry } from "../terminalRegistry";
const NOW = 1_000_000_000_000;
let alive: Set<number>;
function entry(overrides: Partial<ActiveEntry> = {}): ActiveEntry {
  return { sessionId: "session", ppid: 100, terminalPids: [100], claudePid: 300,
    claudeStartedAt: NOW - 10_000, ts: NOW, cwd: "/work", transcriptPath: "/fake.jsonl", ...overrides };
}
beforeEach(() => {
  vi.restoreAllMocks(); fsReadMock.mockReset(); startTimes.mockReset(); startTimes.mockResolvedValue(new Map());
  alive = new Set([100, 101, 300, 301]);
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (alive.has(pid)) return true;
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  Object.assign(vscode.window, { terminals: [] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("readActiveSessions", () => {
  it("ignores missing, malformed, or non-array registries", () => {
    fsReadMock.mockImplementationOnce(() => { throw new Error("ENOENT"); });
    expect(readActiveSessions(NOW)).toEqual([]);
    fsReadMock.mockReturnValue("not json"); expect(readActiveSessions(NOW)).toEqual([]);
    fsReadMock.mockReturnValue("{}"); expect(readActiveSessions(NOW)).toEqual([]);
  });
  it("retains a live Claude even when its SessionStart was over an hour ago", () => {
    fsReadMock.mockReturnValue(JSON.stringify([entry({ ts: NOW - 2 * 60 * 60 * 1000 })]));
    expect(readActiveSessions(NOW)).toHaveLength(1);
  });
  it("does not mistake the still-live terminal shell for a live Claude", () => {
    alive.delete(300);
    fsReadMock.mockReturnValue(JSON.stringify([entry()]));
    expect(readActiveSessions(NOW)).toEqual([]);
  });
  it("requires a valid live terminal ancestor and an independently live Claude", () => {
    fsReadMock.mockReturnValue(JSON.stringify([entry({ terminalPids: [999, 100] })]));
    expect(readActiveSessions(NOW)[0].terminalPids).toEqual([100]);
    alive.delete(100); expect(readActiveSessions(NOW)).toEqual([]);
  });
  it("ignores legacy shell-only entries and malformed process IDs", () => {
    fsReadMock.mockReturnValue(JSON.stringify([
      null, "bad", { sessionId: "legacy", ppid: 100, ts: NOW },
      entry({ claudePid: -1 }), entry({ ts: Number.POSITIVE_INFINITY }), entry(),
    ]));
    expect(readActiveSessions(NOW).map(e => e.sessionId)).toEqual(["session"]);
  });
});

describe("filterReusedPpids", () => {
  it("validates the Claude process identity separately from the terminal shell", async () => {
    startTimes.mockResolvedValue(new Map([[100, NOW - 5000], [300, NOW - 10_000]]));
    expect(await filterReusedPpids([entry()])).toHaveLength(1);
    startTimes.mockResolvedValue(new Map([[100, NOW - 5000], [300, NOW + 5000]]));
    expect(await filterReusedPpids([entry()])).toEqual([]);
  });
  it("drops a recycled terminal ancestor and keeps another matching ancestor", async () => {
    startTimes.mockResolvedValue(new Map([[100, NOW + 5 * 60 * 1000], [101, NOW - 5000]]));
    const out = await filterReusedPpids([entry({ terminalPids: [100, 101] })]);
    expect(out[0].terminalPids).toEqual([101]); expect(out[0].ppid).toBe(101);
    expect(await filterReusedPpids([entry()])).toEqual([]);
  });
  it("allows unknown start times and a small shell-clock gap", async () => {
    expect(await filterReusedPpids([entry()])).toHaveLength(1);
    startTimes.mockResolvedValue(new Map([[100, NOW + 1000]]));
    expect(await filterReusedPpids([entry()])).toHaveLength(1);
  });
});

describe("advisory terminal lifecycle", () => {
  function terminal() {
    const term = { processId: Promise.resolve(100), show: vi.fn() };
    Object.assign(vscode.window, { terminals: [term] });
    return term;
  }
  it("removes a restored binding when Claude exits while its shell stays open", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW); terminal();
    fsReadMock.mockReturnValue(JSON.stringify([entry()]));
    const registry = createTerminalRegistry(); const watcher = startActiveSessionWatcher(registry);
    await vi.advanceTimersByTimeAsync(0); expect(registry.has("session")).toBe(true);
    alive.delete(300);
    await vi.advanceTimersByTimeAsync(4000); expect(registry.has("session")).toBe(false);
    expect(alive.has(100)).toBe(true);
    watcher.dispose(); registry.dispose();
  });
  it("matches through a launch-wrapper ancestor and replaces the old process generation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW); const term = terminal();
    fsReadMock.mockReturnValue(JSON.stringify([entry({ ppid: 101, terminalPids: [101, 100] })]));
    const registry = createTerminalRegistry(); const watcher = startActiveSessionWatcher(registry);
    await vi.advanceTimersByTimeAsync(0); expect(registry.has("session")).toBe(true);
    fsReadMock.mockReturnValue(JSON.stringify([entry({ claudePid: 301, ts: NOW + 4000 })]));
    await vi.advanceTimersByTimeAsync(4000);
    registry.unregister?.("session", term as never, { claudePid: 300, ts: NOW });
    expect(registry.has("session")).toBe(true);
    watcher.dispose(); registry.dispose();
  });
  it("does not register after being disposed during a pending OS query", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW); terminal();
    fsReadMock.mockReturnValue(JSON.stringify([entry()]));
    let complete!: (value: Map<number, number>) => void;
    startTimes.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const registry = createTerminalRegistry(); const watcher = startActiveSessionWatcher(registry);
    watcher.dispose(); complete(new Map());
    await vi.advanceTimersByTimeAsync(0); expect(registry.ids()).toEqual([]); registry.dispose();
  });
});

describe("transient advisory registry reads", () => {
  it("retains a live restored binding across malformed, missing, and restored snapshots", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    Object.assign(vscode.window, { terminals: [{ processId: Promise.resolve(100), show: vi.fn() }] });
    const original = JSON.stringify([entry()]); fsReadMock.mockReturnValue(original);
    const registry = createTerminalRegistry(); const watcher = startActiveSessionWatcher(registry);
    await vi.advanceTimersByTimeAsync(0); expect(registry.has("session")).toBe(true);
    fsReadMock.mockReturnValueOnce("[");
    await vi.advanceTimersByTimeAsync(4000); expect(registry.has("session")).toBe(true);
    fsReadMock.mockImplementationOnce(() => { throw Object.assign(new Error("missing temporarily"), { code: "ENOENT" }); });
    await vi.advanceTimersByTimeAsync(4000); expect(registry.has("session")).toBe(true);
    await vi.advanceTimersByTimeAsync(4000); expect(registry.has("session")).toBe(true);
    // An unreadable snapshot still must not hide a proven Claude-process exit.
    fsReadMock.mockReturnValue("["); alive.delete(300);
    await vi.advanceTimersByTimeAsync(4000); expect(registry.has("session")).toBe(false);
    watcher.dispose(); registry.dispose();
  });
  it("allows an omitted live record to return with the same process generation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    Object.assign(vscode.window, { terminals: [{ processId: Promise.resolve(100), show: vi.fn() }] });
    const original = JSON.stringify([entry()]); fsReadMock.mockReturnValue(original);
    const registry = createTerminalRegistry(); const watcher = startActiveSessionWatcher(registry);
    await vi.advanceTimersByTimeAsync(0); expect(registry.has("session")).toBe(true);
    fsReadMock.mockReturnValueOnce("[]");
    await vi.advanceTimersByTimeAsync(4000); expect(registry.has("session")).toBe(false);
    await vi.advanceTimersByTimeAsync(4000); expect(registry.has("session")).toBe(true);
    watcher.dispose(); registry.dispose();
  });
});
