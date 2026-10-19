import { isAccountFocusedMode } from "../../core/workloadPolicy";
/** One bounded worker and bounded queue per extension host. Failure never falls back to host parsing. */
import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type { Session, SessionDetail } from "./types";
export type WorkerRequest =
  | { kind: "parse"; renames: Record<string, string>; clear?: boolean }
  | { kind: "batch"; ids: string[]; renames: Record<string, string> }
  | { kind: "detail"; sessionId: string; session?: Session; mode: "first" | "last"; query?: string }
  | { kind: "index"; files: { id: string; path: string }[] }
  | { kind: "search"; query: string };
interface Job { request: WorkerRequest; promise: Promise<any>; resolve: (data: any) => void; reject: (error: Error) => void; id: number }
let worker: Worker | undefined;
let active: Job | undefined;
let timer: NodeJS.Timeout | undefined;
let sequence = 0;
let warning: string | null = null;
const queue: Job[] = [];
function fail(): void {
  const old = worker; worker = undefined;
  if (timer) clearTimeout(timer); timer = undefined;
  const jobs = [...(active ? [active] : []), ...queue.splice(0)]; active = undefined;
  for (const job of jobs) job.reject(new Error("Conversation loading stopped safely. Reload Manager or open the conversation in Claude to retry."));
  void old?.terminate().catch(() => {});
}
export function disposeSessionWorker(): void { fail(); }
export function getWorkerParseWarning(): string | null { return warning; }
function pump(): void {
  if (active || !queue.length) return;
  try {
    if (!worker) {
      worker = new Worker(path.join(__dirname, "session-worker.js"), {
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      const current = worker;
      current.on("message", response => {
        if (worker !== current || !active || response.id !== active.id) return;
        if (!response.ok) { fail(); return; }
        if (timer) clearTimeout(timer); timer = undefined;
        warning = typeof response.warning === "string" ? response.warning : null;
        const job = active; active = undefined; job.resolve(response.data); pump();
      });
      current.on("error", () => { if (worker === current) fail(); });
      current.on("exit", () => { if (worker === current) fail(); });
    }
    active = queue.shift()!;
    timer = setTimeout(fail, 60_000); timer.unref();
    worker.postMessage({ ...active.request, id: active.id });
  } catch { fail(); }
}
function request<T>(input: WorkerRequest): Promise<T> {
  if (isAccountFocusedMode()) return Promise.resolve((input.kind === "batch" ? new Map() : input.kind === "detail" ? null : input.kind === "index" ? undefined : []) as T);
  // Repeated pending parses/index builds share one latest request; never pile up scans.
  const pending = queue.find(job => job.request.kind === input.kind && ["parse", "index"].includes(input.kind));
  if (pending) {
    if (input.kind === "parse" && pending.request.kind === "parse") input.clear ||= pending.request.clear;
    pending.request = input; return pending.promise;
  }
  if (queue.length >= 8) return Promise.reject(new Error("Conversation loading is busy. Try again shortly."));
  let resolve!: Job["resolve"], reject!: Job["reject"];
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  queue.push({ request: input, promise, resolve, reject, id: ++sequence }); pump(); return promise;
}
export const parseSessionsAsync = (renames: Record<string, string> = {}, clear = false) => request<Session[]>({ kind: "parse", renames, clear });
export const reparseSessionsBatchAsync = (ids: string[], renames: Record<string, string> = {}) => request<Map<string, Session | null>>({ kind: "batch", ids, renames });
export const parseSessionDetailAsync = (sessionId: string, session?: Session, mode: "first" | "last" = "last", query?: string) => request<SessionDetail | null>({ kind: "detail", sessionId, session, mode, query });
export const indexSessionsAsync = (files: { id: string; path: string }[]) => request<void>({ kind: "index", files });
export const searchContentAsync = (query: string) => request<string[]>({ kind: "search", query });
