import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import { EVIDENCE_RECEIPT } from "../evidence-preserving-reducer/receipt.ts";
import observationPack, { FULL_SENDS, THRESHOLD_BYTES } from "./index.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "observation-pack-"));
  dirs.push(dir);
  const h = harness();
  h.ctx.sessionManager.getSessionDir = () => dir;
  observationPack(h.pi);
  const project = async (messages: any[]) => (await h.emit("context", { messages }))[0].messages as any[];
  return { dir, h, project };
}

const big = Array.from({ length: 2000 }, (_, index) => `line ${index} ${"é".repeat(4)}`).join("\n");
const result = (text: string, extra: object = {}) =>
  ({ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 1, ...extra });
const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }] };
const sent = (message: any, sends: number) => [message, ...Array.from({ length: sends }, () => assistant)];
const recallId = (text: string) => text.match(/id: (obs_[a-f0-9]{24})/)![1]!;

test("a large result is sent in full until it has been sent twice", async () => {
  const { project } = await setup();
  expect(big.length).toBeGreaterThan(THRESHOLD_BYTES);
  expect((await project(sent(result(big), FULL_SENDS - 1)))[0].content[0].text).toBe(big);
  const placeholder = (await project(sent(result(big), FULL_SENDS)))[0].content[0].text as string;
  expect(placeholder).toContain(`[large tool result replaced after its first ${FULL_SENDS} provider requests]`);
  expect(placeholder).toContain("line 0 ");
  expect(placeholder).toContain("line 1999 ");
  expect(placeholder.length).toBeLessThan(2000);
});

test("the session keeps the full result and the projection is stable", async () => {
  const { project } = await setup();
  const original = sent(result(big), 3);
  const first = await project(original);
  expect(original[0].content[0].text).toBe(big);
  expect((await project(original))[0]).toEqual(first[0]);
});

test("obs_recall pages through the stored result exactly", async () => {
  const { h, project } = await setup();
  const id = recallId((await project(sent(result(big), FULL_SENDS)))[0].content[0].text);
  let offset = 0;
  let rebuilt = "";
  for (let eof = false; !eof;) {
    const text = (await h.call("obs_recall", { id, offset })).content[0].text as string;
    const [header, , ...body] = text.split("\n");
    const next = Number(header!.match(/next_offset=(\d+)/)![1]);
    eof = header!.includes("eof=true");
    rebuilt += body.join("\n");
    expect(next).toBeGreaterThan(offset);
    offset = next;
  }
  expect(rebuilt).toBe(big);
});

test("small, error, image, and receipt results are left alone", async () => {
  const { project } = await setup();
  const kept = [
    result("small"),
    result(big, { isError: true }),
    result(big, { content: [{ type: "text", text: big }, { type: "image", data: "x", mimeType: "image/png" }] }),
    result(`${EVIDENCE_RECEIPT}\n${big}`),
  ];
  for (const message of kept) expect((await project(sent(message, 3)))[0]).toEqual(message);
});

test("stored objects are private and recall rejects unknown ids", async () => {
  const { dir, h, project } = await setup();
  const id = recallId((await project(sent(result(big), FULL_SENDS)))[0].content[0].text);
  const path = join(dir, "observation-pack", "test-session", "objects", `${id}.txt`);
  expect(await readFile(path, "utf8")).toBe(big);
  await expect(h.call("obs_recall", { id: "obs_000000000000000000000000" })).rejects.toThrow("Unknown observation id");
  await expect(h.call("obs_recall", { id, offset: 10_000_000 })).rejects.toThrow("exceeds");
});
