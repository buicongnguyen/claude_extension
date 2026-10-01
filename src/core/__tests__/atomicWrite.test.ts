import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeFileAtomic } from "../atomicWrite";

const written: string[] = [];
function tmpTarget(name: string): string {
  const p = path.join(os.tmpdir(), `csm-atomic-${process.pid}-${name}`);
  written.push(p);
  return p;
}

afterEach(() => {
  for (const p of written.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(`${p}.csm-tmp`);
    } catch {
      /* ignore */
    }
  }
});

describe("writeFileAtomic", () => {
  it("writes the content and leaves no temp file behind", () => {
    const target = tmpTarget("write");
    writeFileAtomic(target, '{"ok":true}\n');
    expect(fs.readFileSync(target, "utf-8")).toBe('{"ok":true}\n');
    expect(fs.existsSync(`${target}.csm-tmp`)).toBe(false);
  });

  it("replaces an existing file's contents", () => {
    const target = tmpTarget("replace");
    fs.writeFileSync(target, "old");
    writeFileAtomic(target, "new");
    expect(fs.readFileSync(target, "utf-8")).toBe("new");
  });

  it("throws and cleans the temp file when the target dir is missing", () => {
    const target = path.join(os.tmpdir(), `csm-atomic-missing-${process.pid}`, "no", "where.json");
    expect(() => writeFileAtomic(target, "x")).toThrow();
    expect(fs.existsSync(`${target}.csm-tmp`)).toBe(false);
  });
  it("does not overwrite a pre-existing predictable temp file", () => {
    const target = tmpTarget("planted-temp");
    const planted = `${target}.csm-tmp`;
    fs.writeFileSync(planted, "outside sentinel");
    writeFileAtomic(target, "safe replacement");
    expect(fs.readFileSync(target, "utf8")).toBe("safe replacement");
    expect(fs.readFileSync(planted, "utf8")).toBe("outside sentinel");
    expect(fs.readdirSync(path.dirname(target)).filter((file) => file.startsWith(`${path.basename(target)}.csm-tmp-`))).toEqual([]);
  });

  it("cleans its random temp file if replacing the destination fails", () => {
    const target = tmpTarget("rename-failure");
    fs.mkdirSync(target);
    try {
      expect(() => writeFileAtomic(target, "must fail")).toThrow();
      expect(fs.statSync(target).isDirectory()).toBe(true);
      expect(fs.readdirSync(path.dirname(target)).filter((file) => file.startsWith(`${path.basename(target)}.csm-tmp-`))).toEqual([]);
    } finally {
      fs.rmdirSync(target);
    }
  });

});
