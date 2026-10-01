/** Real local process chain; config and hook output are confined to a fresh Temp directory. */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { build } from "esbuild";

describe("SessionStart isolated subprocess chain", () => {
  it("records the fake CLI PID separately and finds the process that launched it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-manager-hook-test-"));
    expect(path.dirname(dir)).toBe(os.tmpdir());
    const registryPath = path.join(dir, "active.json");
    const hookPath = path.join(dir, "hook.cjs");
    try {
      const built = await build({
        entryPoints: [path.resolve(__dirname, "../sessionStartTap.ts")], bundle: true, platform: "node", format: "cjs", write: false,
        plugins: [{ name: "isolated-config", setup(builder) {
          builder.onResolve({ filter: /core\/config$/ }, () => ({ path: "test-config", namespace: "isolated" }));
          builder.onLoad({ filter: /.*/, namespace: "isolated" }, () => ({ contents:
            `export const CLAUDE_MANAGER_DIR = ${JSON.stringify(dir)}; export const SESSION_ACTIVE_FILE = ${JSON.stringify(registryPath)};` }));
        } }],
      });
      fs.writeFileSync(hookPath, built.outputFiles[0].contents);
      const fakeCli = `const cp=require('child_process'); const result=cp.spawnSync(process.execPath,[${JSON.stringify(hookPath)}], {input:JSON.stringify({session_id:'fake-session',cwd:${JSON.stringify(dir)}}),encoding:'utf8',timeout:10000,windowsHide:true}); if(result.status!==0) throw new Error(result.stderr||'hook failed'); console.log(JSON.stringify({pid:process.pid}));`;
      const result = spawnSync(process.execPath, ["-e", fakeCli], { encoding: "utf8", timeout:15000, windowsHide:true });
      expect(result.status, result.stderr).toBe(0);
      const cliPid = JSON.parse(result.stdout).pid;
      const saved = JSON.parse(fs.readFileSync(registryPath, "utf8"))[0];
      expect(saved.sessionId).toBe("fake-session"); expect(saved.claudePid).toBe(cliPid);
      expect(saved.terminalPids).toContain(process.pid);
      expect(saved.terminalPids).not.toContain(cliPid);
    } finally {
      // mkdtemp and the dirname assertion constrain cleanup to this test's Temp child.
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
