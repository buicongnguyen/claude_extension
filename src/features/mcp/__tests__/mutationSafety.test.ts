import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

const { HOME } = vi.hoisted(() => {
  const fs = require("fs") as typeof import("fs");
  const os = require("os") as typeof import("os");
  const path = require("path") as typeof import("path");
  return { HOME: fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mutation-home-")) };
});
vi.mock("os", async () => ({ ...(await vi.importActual<typeof import("os")>("os")), homedir: () => HOME }));
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
import { addMcpServer, updateMcpServer, deleteMcpServer, globalMcpFileFor } from "../parser";
import { CONFIG_LOCK } from "../../account/claudeLocks";
const config = path.join(HOME, ".claude.json");
beforeEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME);
});
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

describe("global MCP mutation safety", () => {
  it.each(["add", "update", "delete"])("locks %s before reading a competing account update", async (operation) => {
    fs.writeFileSync(config, JSON.stringify({ userID: "user-A", mcpServers: { server: { command: "old" } } }));
    fs.mkdirSync(CONFIG_LOCK.dir);
    const latest = { userID: "user-B", oauthAccount: { accountUuid: "account-B" }, mcpServers: { server: { command: "old" }, concurrent: { command: "fresh" } } };
    const writer = spawn(process.execPath, ["-e", `const fs=require('fs'); setTimeout(()=>{fs.writeFileSync(${JSON.stringify(config)},${JSON.stringify(JSON.stringify(latest))});fs.rmdirSync(${JSON.stringify(CONFIG_LOCK.dir)});},150);`], { windowsHide: true });
    const finished = new Promise<void>((resolve, reject) => {
      writer.on("error", reject);
      writer.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`writer exit ${code}`)));
    });
    const input = { name: "server", scope: "global", transport: "stdio", command: "updated" };
    const ok = operation === "add" ? addMcpServer({ ...input, name: "new" }).ok
      : operation === "update" ? updateMcpServer("server", input).ok : deleteMcpServer("server", "global");
    await finished;
    expect(ok).toBe(true);
    const actual = JSON.parse(fs.readFileSync(config, "utf8"));
    expect(actual.userID).toBe("user-B");
    expect(actual.oauthAccount).toEqual(latest.oauthAccount);
    expect(actual.mcpServers.concurrent).toEqual({ command: "fresh" });
    expect(fs.existsSync(CONFIG_LOCK.dir)).toBe(false);
  });

  it("does not replace a live config it cannot read", () => {
    const raw = '{"userID":"fake-account","mcpServers":{}}';
    fs.writeFileSync(config, raw);
    const read = fs.readFileSync;
    const blocked = vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === config) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return Reflect.apply(read, fs, args);
    });
    expect(addMcpServer({ name: "new", scope: "global", transport: "stdio", command: "demo" }).ok).toBe(false);
    blocked.mockRestore();
    expect(fs.readFileSync(config, "utf8")).toBe(raw);
  });

  it("rejects unsafe names even when the pure writer is called directly", () => {
    expect(addMcpServer({ name: "x'; echo bad; #", scope: "global", transport: "stdio", command: "demo" }).ok).toBe(false);
    expect(fs.existsSync(config)).toBe(false);
  });
  it("persists a valid CLI name that also names an Object prototype property", () => {
    expect(addMcpServer({ name: "__proto__", scope: "global", transport: "stdio", command: "demo" }).ok).toBe(true);
    const actual = JSON.parse(fs.readFileSync(config, "utf8"));
    expect(Object.hasOwn(actual.mcpServers, "__proto__")).toBe(true);
    expect(actual.mcpServers.__proto__).toEqual({ command: "demo" });
  });

  it.each(["", "[]", "null", '{"mcpServers":[]}', '{"mcpServers":null}'])(
    "preserves an invalid existing live config: %s", (raw) => {
      fs.writeFileSync(config, raw);
      expect(addMcpServer({ name: "new", scope: "global", transport: "stdio", command: "demo" }).ok).toBe(false);
      expect(fs.readFileSync(config, "utf8")).toBe(raw);
    },
  );

  it("never deletes global configuration when project scope has no workspace", () => {
    const raw = JSON.stringify({ userID: "fake-account", mcpServers: { server: { command: "keep" } } });
    fs.writeFileSync(config, raw);
    expect(deleteMcpServer("server", "project", undefined)).toBe(false);
    expect(fs.readFileSync(config, "utf8")).toBe(raw);
    expect(fs.existsSync(CONFIG_LOCK.dir)).toBe(false);
  });

  it.each(["__proto__", "constructor"])("finds and safely edits a legacy server named %s", (name) => {
    const canonical = JSON.stringify({ userID: "fake-account", mcpServers: { canonical: { command: "keep" } } });
    fs.writeFileSync(config, canonical);
    const legacy = path.join(HOME, ".claude", "mcp.json");
    fs.mkdirSync(path.dirname(legacy));
    fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { [name]: { command: "old" } } }));
    expect(globalMcpFileFor(name)).toBe(legacy);
    expect(updateMcpServer(name, { name, scope: "global", transport: "stdio", command: "updated" }).ok).toBe(true);
    const actual = JSON.parse(fs.readFileSync(legacy, "utf8"));
    expect(Object.hasOwn(actual.mcpServers, name)).toBe(true);
    expect(actual.mcpServers[name]).toEqual({ command: "updated" });
    expect(deleteMcpServer(name, "global")).toBe(true);
    expect(Object.hasOwn(JSON.parse(fs.readFileSync(legacy, "utf8")).mcpServers, name)).toBe(false);
    expect(fs.readFileSync(config, "utf8")).toBe(canonical);
  });

});
