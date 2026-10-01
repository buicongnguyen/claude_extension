// Modified for the personal fork, October 2026. See NOTICE.
/** Write to an exclusively created random sibling, then rename over the target. */
import * as fs from "fs";
import { randomUUID } from "crypto";

export function writeFileAtomic(filePath: string, data: string | Uint8Array): void {
  const tmp = `${filePath}.csm-tmp-${randomUUID()}`;
  let mode = 0o600;
  try {
    const existing = fs.lstatSync(filePath);
    if (existing.isFile()) mode = existing.mode & 0o777;
  } catch {
    // A new file is private by default; an unreadable target still fails at rename.
  }
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    created = true;
    fs.writeFileSync(fd, data);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve the write error */ }
    }
    // Never remove a file we did not create if exclusive creation failed.
    if (created) {
      try { fs.unlinkSync(tmp); } catch { /* preserve the write error */ }
    }
    throw err;
  }
}
