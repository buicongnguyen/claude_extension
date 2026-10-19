import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
vi.mock("fs", async (original) => ({ ...(await original<typeof import("fs")>()) }));
import { setAccountFocusedMode } from "../../../core/workloadPolicy";
import { discoverModelsFromCli, warmModelCache } from "../models";
import { aggregateUsage, warmUsageAggregate } from "../projectStats";
afterEach(() => { setAccountFocusedMode(false); vi.restoreAllMocks(); });
describe("account-focused background budget", () => {
  it("does not enumerate transcripts or scan model files through implicit warm calls", async () => {
    setAccountFocusedMode(true);
    const reads = vi.spyOn(fs.promises, "readdir").mockRejectedValue(new Error("No scan allowed"));
    const stat = vi.spyOn(fs, "statSync");
    expect(discoverModelsFromCli()).toEqual([]); expect(await warmModelCache()).toEqual([]);
    expect(aggregateUsage().totalMessages).toBe(0); expect((await warmUsageAggregate()).totalMessages).toBe(0);
    expect(reads).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled();
  });
});
