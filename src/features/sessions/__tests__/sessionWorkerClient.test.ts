import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccountFocusedMode } from "../../../core/workloadPolicy";
import { EventEmitter } from "node:events";
vi.unmock("../sessionWorkerClient");
const state = vi.hoisted(() => ({ workers: [] as any[] }));
vi.mock("node:worker_threads", () => ({ Worker: class extends EventEmitter {
  postMessage = vi.fn(); terminate = vi.fn(async () => 0);
  constructor(public file: string, public options: any) { super(); state.workers.push(this); }
} }));
import { parseSessionsAsync, parseSessionDetailAsync, searchContentAsync, disposeSessionWorker } from "../sessionWorkerClient";
beforeEach(() => { setAccountFocusedMode(false); vi.useFakeTimers(); state.workers = []; });
afterEach(() => { setAccountFocusedMode(false); disposeSessionWorker(); vi.useRealTimers(); });
function reply(data: unknown, index = 0) { const w = state.workers[index]; const request = w.postMessage.mock.calls.at(-1)[0]; w.emit("message", { id: request.id, ok: true, data }); }
describe("bounded worker client", () => {
  it("starts no worker for history or preview requests in account-focused mode", async () => {
    setAccountFocusedMode(true);
    expect(await parseSessionsAsync()).toEqual([]);
    expect(await parseSessionDetailAsync("id")).toBeNull();
    expect(await searchContentAsync("needle")).toEqual([]);
    expect(state.workers).toHaveLength(0);
  });
  it("uses a separate heap and resolves only the matching request", async () => {
    const work = parseSessionsAsync(); const w = state.workers[0];
    expect(w.file).toMatch(/session-worker\.js$/);
    expect(w.options.resourceLimits.maxOldGenerationSizeMb).toBe(256);
    w.emit("message", { id: -1, ok: true, data: ["wrong"] });
    reply([]); expect(await work).toEqual([]);
  });
  it("coalesces pending refreshes while retaining cache invalidation", async () => {
    const first = parseSessionsAsync(); const second = parseSessionsAsync({}, true);
    const latest = parseSessionsAsync({ a: "new" }); expect(second).toBe(latest);
    reply([]); await first;
    expect(state.workers[0].postMessage.mock.calls.at(-1)[0]).toMatchObject({ clear: true, renames: { a: "new" } });
    reply([]); await latest;
  });
  it("keeps different search queries separate", async () => {
    const first = parseSessionsAsync(); const alpha = searchContentAsync("alpha"); const beta = searchContentAsync("beta");
    reply([]); await first; reply(["alpha-hit"]); expect(await alpha).toEqual(["alpha-hit"]);
    reply(["beta-hit"]); expect(await beta).toEqual(["beta-hit"]);
  });
  it("contains a worker memory error and permits a fresh worker", async () => {
    const first = parseSessionsAsync(); const queued = parseSessionDetailAsync("id");
    const checks = Promise.all([expect(first).rejects.toThrow("stopped safely"), expect(queued).rejects.toThrow("stopped safely")]);
    state.workers[0].emit("error", new Error("Worker reached memory limit")); await checks;
    const retry = parseSessionsAsync(); expect(state.workers).toHaveLength(2); reply([], 1); await retry;
  });
  it("terminates a stalled request without parsing in the host", async () => {
    const work = parseSessionsAsync(); const check = expect(work).rejects.toThrow("stopped safely");
    await vi.advanceTimersByTimeAsync(60_001); await check;
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
  });
  it("refuses an unbounded queue", async () => {
    const work = Array.from({ length: 9 }, (_, i) => parseSessionDetailAsync(String(i)));
    await expect(parseSessionDetailAsync("overflow")).rejects.toThrow("busy");
    const settled = Promise.allSettled(work); disposeSessionWorker(); await settled;
  });
});
