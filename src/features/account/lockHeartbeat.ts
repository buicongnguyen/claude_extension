/** Keep advisory locks fresh even while the extension host performs synchronous I/O. */
import * as fs from "fs";
import { MessageChannel, Worker } from "worker_threads";

export interface OwnedLock {
  dir: string;
  staleMs: number;
  identity: string;
}

/** Birth time prevents an immediately reused inode from looking like the old holder. */
export function lockIdentity(dir: string): string | undefined {
  try {
    const stat = fs.lstatSync(dir, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  } catch {
    return undefined;
  }
}

export interface LockHeartbeat {
  add(lock: OwnedLock): boolean;
  healthy(): boolean;
  stop(): boolean;
}

/** This function must be self-contained: its source runs in a separate Node worker. */
function runHeartbeatWorker(data: {
  port: import("worker_threads").MessagePort;
  control: SharedArrayBuffer;
}): void {
  const fileSystem = require("fs") as typeof import("fs");
  const { receiveMessageOnPort } = require("worker_threads") as typeof import("worker_threads");
  const control = new Int32Array(data.control);
  const locks: OwnedLock[] = [];
  let intervalMs = 5_000;
  const touch = (lock: OwnedLock): void => {
    try {
      const stat = fileSystem.lstatSync(lock.dir, { bigint: true });
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity !== lock.identity) {
        Atomics.store(control, 3, 1);
        return;
      }
      const now = new Date();
      fileSystem.utimesSync(lock.dir, now, now);
    } catch {
      Atomics.store(control, 3, 1);
    }
  };
  try {
    while (Atomics.load(control, 1) === 0) {
      const wakeGeneration = Atomics.load(control, 4);
      let received;
      while ((received = receiveMessageOnPort(data.port))) {
        const lock = received.message as OwnedLock;
        locks.push(lock);
        intervalMs = Math.min(intervalMs, Math.max(5, Math.floor(lock.staleMs / 3)));
        touch(lock);
        Atomics.add(control, 0, 1);
        Atomics.notify(control, 0);
      }
      for (const lock of locks) touch(lock);
      Atomics.wait(control, 4, wakeGeneration, Math.min(intervalMs, 1_000));
    }
  } catch {
    Atomics.store(control, 3, 1);
  } finally {
    Atomics.store(control, 2, 1);
    Atomics.notify(control, 2);
    Atomics.notify(control, 0);
    data.port.close();
  }
}

/** One worker per operation protects every held lock, including acquisition waits. */
export function createLockHeartbeat(): LockHeartbeat {
  const { port1, port2 } = new MessageChannel();
  // Cells: acknowledgements, stop request, stopped, ownership/error, wake generation.
  const shared = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const control = new Int32Array(shared);
  const worker = new Worker(
    `(${runHeartbeatWorker.toString()})(require("worker_threads").workerData)`,
    { eval: true, workerData: { port: port2, control: shared }, transferList: [port2] },
  );
  worker.on("error", () => {
    Atomics.store(control, 3, 1);
    Atomics.store(control, 2, 1);
    Atomics.notify(control, 0);
    Atomics.notify(control, 2);
  });
  worker.unref();
  port1.unref();
  let expected = 0;
  return {
    add(lock) {
      const deadline = Date.now() + 2_000;
      port1.postMessage(lock);
      expected++;
      Atomics.add(control, 4, 1);
      Atomics.notify(control, 4);
      while (
        Atomics.load(control, 0) < expected &&
        !Atomics.load(control, 2) &&
        !Atomics.load(control, 3)
      ) {
        const acknowledged = Atomics.load(control, 0);
        if (acknowledged >= expected) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        Atomics.wait(control, 0, acknowledged, remaining);
      }
      return (
        Atomics.load(control, 0) >= expected &&
        !Atomics.load(control, 2) &&
        !Atomics.load(control, 3)
      );
    },
    healthy() {
      return !Atomics.load(control, 2) && !Atomics.load(control, 3);
    },
    stop() {
      Atomics.store(control, 1, 1);
      Atomics.add(control, 4, 1);
      Atomics.notify(control, 4);
      if (!Atomics.load(control, 2)) Atomics.wait(control, 2, 0, 2_000);
      const stopped = Atomics.load(control, 2) === 1;
      port1.close();
      void worker.terminate();
      return stopped;
    },
  };
}
