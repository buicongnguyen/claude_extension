/** Heavy transcript work lives in a separate V8 heap, never the extension host. */
import { parentPort } from "node:worker_threads";
import { parseSessions, reparseSessionsBatch, getLastParseWarning, clearOrphanCache } from "./historyParser";
import { parseSessionDetail } from "./detailParser";
import { clearMetaCaches } from "./metaParser";
import { clearPendingCache } from "./liveSessions";
import { indexSession, pruneIndex, clearIndex, searchContent } from "./searchIndex";
import type { WorkerRequest } from "./sessionWorkerClient";
parentPort?.on("message", async (request: WorkerRequest & { id: number }) => {
  try {
    let data: unknown;
    if (request.kind === "parse") {
      if (request.clear) { clearOrphanCache(); clearMetaCaches(); clearPendingCache(); clearIndex(); }
      data = parseSessions(request.renames);
    } else if (request.kind === "batch") data = reparseSessionsBatch(request.ids, request.renames);
    else if (request.kind === "detail") data = parseSessionDetail(request.sessionId, request.session, request.mode, request.query);
    else if (request.kind === "index") {
      pruneIndex(new Set(request.files.map(file => file.id)));
      for (const file of request.files) indexSession(file.id, file.path);
      data = null;
    } else data = await searchContent(request.query);
    if (request.kind === "parse" || request.kind === "batch") {
      let remaining = 4 * 1024 * 1024;
      const sessions: Array<import("./types").Session | null> = data instanceof Map ? [...data.values()] : data as import("./types").Session[];
      for (const session of sessions) {
        if (!session) continue;
        session.name = session.name.slice(0, 512);
        session.searchHaystack = session.searchHaystack.slice(0, Math.min(16 * 1024, remaining));
        remaining -= session.searchHaystack.length;
        session.prompts = session.prompts.slice(0, 1000).flatMap(prompt => {
          const text = prompt.slice(0, Math.min(1024, remaining)); remaining -= text.length;
          return text ? [text] : [];
        });
      }
    }
    parentPort?.postMessage({ id: request.id, ok: true, data, warning: getLastParseWarning() });
  } catch { parentPort?.postMessage({ id: request.id, ok: false }); }
});
