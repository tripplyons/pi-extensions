import { expect, test } from "bun:test";
import { sanitizeToolImages } from "./images.ts";

const image = { type: "image" as const, mimeType: "image/jpeg", data: "/9j/2Q==" };

test("valid image and text output stays unchanged", () => {
  const content = [{ type: "text" as const, text: "comparison" }, image];
  expect(sanitizeToolImages(content)).toBeUndefined();
  expect(sanitizeToolImages([])).toBeUndefined();
});

test.each([
  ["stderr prefix", { ...image, data: "montage: unable to read font\n" + image.data }],
  ["empty data", { ...image, data: "" }],
  ["invalid alphabet", { ...image, data: "????" }],
  ["misplaced padding", { ...image, data: "a=GVsbG8" }],
  ["excess padding", { ...image, data: "aGVsbG8===" }],
  ["truncated base64", { ...image, data: "a" }],
  ["noncanonical trailing bits", { ...image, data: "aB==" }],
  ["non-image MIME", { ...image, mimeType: "text/plain" }],
  ["MIME parameters", { ...image, mimeType: "image/png;bad=value" }],
])("malformed image becomes a diagnostic: %s", (_name, bad) => {
  const text = { type: "text" as const, text: "keep this" };
  const content = [text, bad, image];
  const snapshot = structuredClone(content);
  const safe = sanitizeToolImages(content)!;
  expect(safe[0]).toBe(text);
  expect(safe[1].type).toBe("text");
  expect(safe[1]).toMatchObject({ text: expect.stringContaining("Image omitted:") });
  expect(safe[2]).toBe(image);
  expect(content).toEqual(snapshot);
});

test("large valid base64 does not overflow the validator", () => {
  expect(sanitizeToolImages([{ ...image, data: Buffer.alloc(4 * 1024 * 1024).toString("base64") }])).toBeUndefined();
});
