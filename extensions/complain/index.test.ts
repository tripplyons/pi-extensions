import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";
test("complaints are private structured records in the agent directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-complaint-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const h = harness(); install(h.pi);
    const { details } = await h.call("complain", { message: "Suspected harness issue; uncertain cause" });
    expect(details.path.startsWith(join(root, "complaints") + "/")).toBe(true);
    expect((await stat(join(root, "complaints"))).mode & 0o777).toBe(0o700);
    const record = JSON.parse(await readFile(details.path, "utf8"));
    expect(record.session).toBe("test-session");
    expect(record.thinkingLevel).toBe("high");
    expect((await stat(details.path)).mode & 0o777).toBe(0o600);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
