import { expect, test } from "bun:test";
import { applyDelta, createDelta } from "./delta.ts";

test("state deltas round-trip appends, mutations, deletions and truncation", () => {
	const before = {
		messages: [{ role: "user", content: "old" }],
		receipts: [{ id: "one", delivery: "nested" }, { id: "two", delivery: "held" }],
		optional: "remove",
		count: 1,
	};
	const after = {
		messages: [{ role: "user", content: "old" }, { role: "assistant", content: "new" }],
		receipts: [{ id: "one", delivery: "reported" }],
		count: 2,
	};
	const delta = createDelta(before, after);
	expect(applyDelta(before, delta)).toEqual(after);
	expect(delta.some(operation => operation.op === "append")).toBe(true);
	expect(delta.some(operation => operation.op === "truncate")).toBe(true);
	expect(delta.some(operation => operation.op === "delete")).toBe(true);
});

test("state deltas reject unsafe or structurally invalid paths", () => {
	expect(() => applyDelta({}, [{ op: "set", path: ["__proto__", "polluted"], value: true }])).toThrow("invalid delta operation");
	expect(() => applyDelta({}, [{ op: "append", path: ["missing"], values: [] }])).toThrow("path does not exist");
	expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});
