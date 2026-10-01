import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

const { HOME } = vi.hoisted(() => {
  const fs = require("fs") as typeof import("fs");
  const os = require("os") as typeof import("os");
  const path = require("path") as typeof import("path");
  return { HOME: fs.mkdtempSync(path.join(os.tmpdir(), "brain-boundary-home-")) };
});
vi.mock("os", async () => ({ ...(await vi.importActual<typeof import("os")>("os")), homedir: () => HOME }));
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
import { importBrain, previewConflicts } from "../importer";
import { exportBrain } from "../exporter";
import { writeZip, readZip } from "../zip";
import { CONFIG_LOCK } from "../../account/claudeLocks";

const workspace = path.join(HOME, "workspace");
const config = path.join(HOME, ".claude.json");
function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function archive(entries: Array<[string, string]>): Buffer {
  return writeZip(entries.map(([path, data]) => ({ path, data: Buffer.from(data) })));
}
const mcp = archive([["global/mcpServers.json", '{"mcpServers":{"new":{"command":"demo"}}}']]);
beforeEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
});
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

describe("Brain archive boundaries", () => {
  it("rejects credentials, sessions, Git hooks, and unrelated workspace files", () => {
    const entries: Array<[string, string]> = [
      ["global/.credentials.json", "fake credential"], ["global/projects/a/session.jsonl", "history"],
      ["project/.git/hooks/post-checkout", "unexpected hook"], ["project/package.json", "unexpected code"],
      ["project/.claude/skills/../settings.json", "traversal"],
      ["project/.claude/skills/a/SKILL.md:stream", "alternate stream"],
      ["project/.claude/skills/.. /agents/a.md", "Windows traversal alias"],
      ["project/.claude/skills/a/CON.txt", "Windows device name"],
    ];
    const zip = archive(entries);
    expect(previewConflicts(zip, workspace, ["global", "project"]).overwrites).toEqual([]);
    const result = importBrain(zip, workspace, ["global", "project"]);
    expect(result.skipped).toEqual(entries.map(([name]) => name));
    expect(result.written).toEqual([]);
    expect(fs.existsSync(path.join(HOME, ".claude", ".credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);
  });

  it("round trips the declared configuration and skill assets", () => {
    put(path.join(workspace, "CLAUDE.md"), "project instructions");
    put(path.join(workspace, ".claude", "skills", "review", "SKILL.md"), "review skill");
    put(path.join(workspace, ".claude", "skills", "review", "assets", "example.txt"), "asset");
    put(path.join(workspace, ".claude", "settings.local.json"), '{"model":"opus"}');
    put(path.join(workspace, ".git", "hooks", "post-checkout"), "never exported");
    const zip = exportBrain("project", workspace);
    expect(readZip(zip).map((entry) => entry.path)).not.toContain("project/.git/hooks/post-checkout");
    const other = path.join(HOME, "other-workspace");
    fs.mkdirSync(other);
    const result = importBrain(zip, other, ["project"]);
    expect(result.written).toHaveLength(4);
    expect(result.skipped).toEqual([]);
    expect(fs.readFileSync(path.join(other, ".claude", "skills", "review", "assets", "example.txt"), "utf8")).toBe("asset");
  });

  it("does not preview, import, or export content through a directory junction", () => {
    const outside = path.join(HOME, "outside");
    const target = path.join(outside, "linked", "SKILL.md");
    put(target, "outside original");
    fs.mkdirSync(path.join(workspace, ".claude"));
    fs.symlinkSync(outside, path.join(workspace, ".claude", "skills"), "junction");
    const entry = "project/.claude/skills/linked/SKILL.md";
    const zip = archive([[entry, "outside overwrite"]]);
    expect(previewConflicts(zip, workspace, ["project"]).overwrites).toEqual([]);
    expect(importBrain(zip, workspace, ["project"]).skipped).toEqual([entry]);
    expect(fs.readFileSync(target, "utf8")).toBe("outside original");
    expect(readZip(exportBrain("project", workspace)).map((file) => file.path)).not.toContain(entry);
  });

  it.each(['{"oauthAccount":{"accountUuid":"fake"},', "[]", "null", ""])(
    "preserves invalid existing live config: %s", (raw) => {
      put(config, raw);
      expect(() => previewConflicts(mcp, workspace, ["global"])).toThrow(/left untouched/);
      expect(() => importBrain(mcp, workspace, ["global"])).toThrow(/left untouched/);
      expect(fs.readFileSync(config, "utf8")).toBe(raw);
      expect(fs.existsSync(CONFIG_LOCK.dir)).toBe(false);
    },
  );

  it("preserves an unreadable existing live config", () => {
    const original = '{"userID":"fake-user","oauthAccount":{"accountUuid":"fake-account"}}';
    put(config, original);
    const read = fs.readFileSync;
    const blocked = vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === config) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return Reflect.apply(read, fs, args);
    });
    expect(() => importBrain(mcp, workspace, ["global"])).toThrow(/left untouched/);
    blocked.mockRestore();
    expect(fs.readFileSync(config, "utf8")).toBe(original);
  });

  it("waits for a competing config writer and preserves its latest account", async () => {
    put(config, '{"oauthAccount":{"accountUuid":"account-A"},"userID":"user-A"}');
    fs.mkdirSync(CONFIG_LOCK.dir);
    const latest = { oauthAccount: { accountUuid: "account-B" }, userID: "user-B", mcpServers: { concurrent: { command: "fresh" } } };
    const writer = spawn(process.execPath, ["-e", `const fs=require('fs'); setTimeout(()=>{fs.writeFileSync(${JSON.stringify(config)},${JSON.stringify(JSON.stringify(latest))});fs.rmdirSync(${JSON.stringify(CONFIG_LOCK.dir)});},150);`], { windowsHide: true });
    const finished = new Promise<void>((resolve, reject) => {
      writer.on("error", reject);
      writer.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`writer exit ${code}`)));
    });
    const result = importBrain(mcp, workspace, ["global"]);
    await finished;
    expect(result.mergedMcpServers).toEqual(["new"]);
    const actual = JSON.parse(fs.readFileSync(config, "utf8"));
    expect(actual.oauthAccount).toEqual(latest.oauthAccount);
    expect(actual.userID).toBe("user-B");
    expect(actual.mcpServers.concurrent).toEqual({ command: "fresh" });
    expect(actual.mcpServers.new).toEqual({ command: "demo" });
  });
});
