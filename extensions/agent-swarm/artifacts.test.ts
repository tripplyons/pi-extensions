import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packPayload, textPreview, unpackPayload } from "./artifacts.ts";
import { ensureDir, outboxDir } from "./state.ts";

test("large request bodies use checked private artifacts and scoped previews", () => {
	const state = mkdtempSync(join(tmpdir(), "pi-swarm-artifacts-"));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = state;
	try {
		ensureDir(outboxDir("run_test", "node_test"));
		const body = "界".repeat(5000);
		const packed = packPayload("run_test", "node_test", "req_test", { body, nodeId: "node_parent" }, 1024);
		expect(Buffer.byteLength(JSON.stringify(packed))).toBeLessThan(1024);
		expect(unpackPayload("run_test", "node_test", "req_test", packed)).toEqual({ body, nodeId: "node_parent" });
		const preview = textPreview("run_test", "node_parent", body, 1024);
		expect(Buffer.byteLength(preview)).toBeLessThan(1024);
		expect(readFileSync(preview.split("Full text: ")[1], "utf8")).toBe(body);
		const path = join(outboxDir("run_test", "node_test"), "req_test-body.txt");
		writeFileSync(path, "Changed");
		expect(() => unpackPayload("run_test", "node_test", "req_test", packed)).toThrow("changed");
		rmSync(path);
		symlinkSync("/etc/passwd", path);
		expect(() => unpackPayload("run_test", "node_test", "req_test", packed)).toThrow();
		expect(() => unpackPayload("run_test", "node_test", "req_other", packed)).toThrow("reference");
	} finally {
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(state, { recursive: true, force: true });
	}
});
