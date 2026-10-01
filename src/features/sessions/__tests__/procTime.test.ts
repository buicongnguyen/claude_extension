import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { readFile, stat, execFile } = vi.hoisted(() => ({ readFile: vi.fn(), stat: vi.fn(), execFile: vi.fn() }));
vi.mock("fs", () => ({ promises: { readFile, stat } }));
vi.mock("child_process", () => ({ execFile: (...args: unknown[]) => execFile(...args) }));
import { getProcessStartTimes, getProcessStartTimesAsync, _clearProcStartCache } from "../procTime";

const ORIG_PLATFORM = process.platform;
const BOOT_SECONDS = 1_700_000_000;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}
function mockExec(stdout: string): void {
  execFile.mockImplementation((_cmd, _args, _opts, callback) => callback(null, { stdout }));
}
/** Different neighboring fields catch accidental indexing of field 21 or 23. */
function procStat(pid: number, ticks = "375", name = "claude"): string {
  const fields = Array<string>(25).fill("0");
  fields[0] = "S"; fields[1] = "1"; fields[18] = "9999"; fields[19] = ticks; fields[20] = "8888";
  return `${pid} (${name}) ${fields.join(" ")}\n`;
}
function linuxFixture(hz = "100\n", processes: Record<number, string> = { 42: procStat(42) }): void {
  setPlatform("linux"); mockExec(hz);
  readFile.mockImplementation((file: string) => {
    if (file === "/proc/stat") return Promise.resolve(`cpu  1 2 3 4\nbtime ${BOOT_SECONDS}\nprocesses 123\n`);
    const pid = Number(file.match(/^\/proc\/(\d+)\/stat$/)?.[1]);
    return Object.hasOwn(processes, pid) ? Promise.resolve(processes[pid])
      : Promise.reject(Object.assign(new Error("process disappeared"), { code: "ENOENT" }));
  });
}
function processReads(): unknown[][] {
  return readFile.mock.calls.filter(([file]) => file !== "/proc/stat");
}

beforeEach(() => {
  _clearProcStartCache(); readFile.mockReset(); stat.mockReset(); execFile.mockReset();
});
afterEach(() => { setPlatform(ORIG_PLATFORM); vi.useRealTimers(); });

describe("getProcessStartTimesAsync", () => {
  it.each([100, 250, 1024])("linux: converts field 22 using the system's %i ticks/second", async (hz) => {
    linuxFixture(`${hz}\n`);
    const result = await getProcessStartTimesAsync([42]);
    expect(result.get(42)).toBe(BOOT_SECONDS * 1000 + 375 / hz * 1000);
    expect(execFile.mock.calls[0].slice(0, 3)).toEqual(["getconf", ["CLK_TCK"], { encoding: "utf-8", timeout: 4000 }]);
    expect(readFile).toHaveBeenCalledWith("/proc/42/stat", "utf-8");
    expect(stat).not.toHaveBeenCalled();
  });
  it("linux: handles spaces and nested/right parentheses in the process name", async () => {
    linuxFixture("100\n", { 42: procStat(42, "1234", "claude (native) worker)") });
    expect((await getProcessStartTimesAsync([42])).get(42)).toBe(BOOT_SECONDS * 1000 + 12_340);
  });
  it("linux: preserves the start time across PID refreshes without consulting mutable directory mtimes", async () => {
    vi.useFakeTimers(); linuxFixture(); stat.mockResolvedValueOnce({ mtimeMs: 111 }).mockResolvedValue({ mtimeMs: 222 });
    const first = await getProcessStartTimesAsync([42]);
    await vi.advanceTimersByTimeAsync(6000);
    const second = await getProcessStartTimesAsync([42]);
    expect(second.get(42)).toBe(first.get(42)); expect(processReads()).toHaveLength(2);
    expect(stat).not.toHaveBeenCalled(); expect(execFile).toHaveBeenCalledOnce();
    expect(readFile.mock.calls.filter(([file]) => file === "/proc/stat")).toHaveLength(1);
  });
  it("linux: detects reused PIDs when their kernel start ticks change", async () => {
    vi.useFakeTimers(); const processes = { 42: procStat(42, "375") }; linuxFixture("100\n", processes);
    expect((await getProcessStartTimesAsync([42])).get(42)).toBe(BOOT_SECONDS * 1000 + 3750);
    processes[42] = procStat(42, "975"); await vi.advanceTimersByTimeAsync(6000);
    expect((await getProcessStartTimesAsync([42])).get(42)).toBe(BOOT_SECONDS * 1000 + 9750);
  });
  it.each(["0", "-100", "100.5", "Infinity", "100 extra", ""])("linux: leaves start times unknown for invalid CLK_TCK: %s", async (hz) => {
    linuxFixture(hz); expect((await getProcessStartTimesAsync([42])).size).toBe(0); expect(processReads()).toHaveLength(0);
  });
  it.each(["cpu 1 2 3\n", "btime -1\n", "btime 1.5\n", "btime 99999999999999999999999\n"])(
    "linux: leaves start times unknown for invalid boot metadata", async (raw) => {
      linuxFixture(); const actual = readFile.getMockImplementation()!;
      readFile.mockImplementation((file: string) => file === "/proc/stat" ? Promise.resolve(raw) : actual(file));
      expect((await getProcessStartTimesAsync([42])).size).toBe(0);
    },
  );
  it("linux: does not guess a clock rate when getconf fails, and retries after the TTL", async () => {
    vi.useFakeTimers(); linuxFixture(); execFile.mockImplementation((_cmd, _args, _opts, callback) => callback(new Error("getconf unavailable")));
    expect((await getProcessStartTimesAsync([42])).size).toBe(0);
    expect((await getProcessStartTimesAsync([43])).size).toBe(0); expect(execFile).toHaveBeenCalledOnce();
    mockExec("100\n"); await vi.advanceTimersByTimeAsync(6000);
    expect((await getProcessStartTimesAsync([42])).get(42)).toBe(BOOT_SECONDS * 1000 + 3750);
    expect(execFile).toHaveBeenCalledTimes(2);
  });
  it("linux: leaves process times unknown when /proc/stat is unreadable", async () => {
    linuxFixture(); readFile.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    expect((await getProcessStartTimesAsync([42])).size).toBe(0); expect(processReads()).toHaveLength(0);
  });
  it.each([procStat(43), "42 missing fields", "42 (claude) S 1 0", procStat(42, "-1"), procStat(42, "1.5"), procStat(42, "999999999999999999999999")])(
    "linux: omits an invalid or mismatched process stat", async (raw) => {
      linuxFixture("100\n", { 42: raw }); expect((await getProcessStartTimesAsync([42])).has(42)).toBe(false);
    },
  );
  it("linux: returns readable process times even when another PID disappears", async () => {
    linuxFixture(); const result = await getProcessStartTimesAsync([42, 99]);
    expect(result.get(42)).toBe(BOOT_SECONDS * 1000 + 3750); expect(result.has(99)).toBe(false);
  });
  it("linux: shares asynchronous clock discovery across concurrent PID lookups", async () => {
    linuxFixture("100\n", { 42: procStat(42), 43: procStat(43, "500") });
    let complete!: (error: null, result: { stdout: string }) => void;
    execFile.mockImplementation((_cmd, _args, _opts, callback) => { complete = callback; });
    const first = getProcessStartTimesAsync([42]); const second = getProcessStartTimesAsync([43]);
    expect(execFile).toHaveBeenCalledOnce(); complete(null, { stdout: "100\n" });
    const [a, b] = await Promise.all([first, second]);
    expect(a.get(42)).toBe(BOOT_SECONDS * 1000 + 3750); expect(b.get(43)).toBe(BOOT_SECONDS * 1000 + 5000);
  });
  it("waits for an already-running refresh of the same PID", async () => {
    linuxFixture(); let complete!: (error: null, result: { stdout: string }) => void;
    execFile.mockImplementation((_cmd, _args, _opts, callback) => { complete = callback; });
    const first = getProcessStartTimesAsync([42]); const second = getProcessStartTimesAsync([42]);
    complete(null, { stdout: "100\n" });
    const [a, b] = await Promise.all([first, second]);
    expect(a.get(42)).toBe(BOOT_SECONDS * 1000 + 3750); expect(b.get(42)).toBe(a.get(42)); expect(processReads()).toHaveLength(1);
  });
  it("caches a failed PID lookup within the TTL", async () => {
    linuxFixture(); await getProcessStartTimesAsync([99]); await getProcessStartTimesAsync([99]);
    expect(processReads().filter(([file]) => file === "/proc/99/stat")).toHaveLength(1);
  });
  it("darwin: parses ps lstart output into epoch milliseconds", async () => {
    setPlatform("darwin"); mockExec("  123 Wed Jul  1 11:39:30 2026\n");
    expect((await getProcessStartTimesAsync([123])).get(123)).toBe(Date.parse("Wed Jul  1 11:39:30 2026"));
  });
  it("win32: parses pid unixms PowerShell output", async () => {
    setPlatform("win32"); mockExec("123 1782886110955\r\n456 1782886182158\r\n");
    const result = await getProcessStartTimesAsync([123, 456]);
    expect(result.get(123)).toBe(1782886110955); expect(result.get(456)).toBe(1782886182158);
  });
  it("returns an empty map on unsupported platforms", async () => {
    setPlatform("aix"); expect((await getProcessStartTimesAsync([1])).size).toBe(0);
  });
  it.each(["darwin", "win32"] as const)("omits unknown times when %s process queries fail", async (platform) => {
    setPlatform(platform); execFile.mockImplementation((_cmd, _args, _opts, callback) => callback(new Error("query failed")));
    expect((await getProcessStartTimesAsync([1])).size).toBe(0);
  });
});

describe("getProcessStartTimes (sync, non-blocking)", () => {
  it("returns immediately while clock discovery is pending, and an async caller can await that refresh", async () => {
    linuxFixture(); let complete!: (error: null, result: { stdout: string }) => void;
    execFile.mockImplementation((_cmd, _args, _opts, callback) => { complete = callback; });
    expect(getProcessStartTimes([42]).size).toBe(0);
    const waiting = getProcessStartTimesAsync([42]); complete(null, { stdout: "100\n" });
    expect((await waiting).get(42)).toBe(BOOT_SECONDS * 1000 + 3750); expect(execFile).toHaveBeenCalledOnce();
  });
  it("serves the warmed cache without another OS query", async () => {
    linuxFixture(); await getProcessStartTimesAsync([42]);
    expect(getProcessStartTimes([42]).get(42)).toBe(BOOT_SECONDS * 1000 + 3750);
    expect(execFile).toHaveBeenCalledOnce(); expect(processReads()).toHaveLength(1);
  });
});
