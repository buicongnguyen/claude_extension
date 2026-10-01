/** Keep upstream tests and activation background jobs away from the developer's real logins. */
import { afterAll, vi } from "vitest";
const state = vi.hoisted(() => ({ directory: undefined as string | undefined }));
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const fileSystem = await vi.importActual<typeof import("fs")>("fs");
  const path = await vi.importActual<typeof import("path")>("path");
  const home = fileSystem.mkdtempSync(path.join(actual.tmpdir(), "manager-unit-home-"));
  state.directory = home;
  return { ...actual, homedir: () => home };
});
afterAll(async () => {
  const fs = await vi.importActual<typeof import("fs")>("fs");
  if (state.directory) fs.rmSync(state.directory, { recursive: true, force: true });
});
