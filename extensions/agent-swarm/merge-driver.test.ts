import { expect, test } from "bun:test";
import { assertSupportedAttributes, createGitRunner } from "./git.ts";

const result = (stdout = "", status = 0, stderr = "") => ({ status, stdout, stderr });

test("effectful Git commands neutralize every configured external merge driver", () => {
	const calls: string[][] = [];
	const runner = createGitRunner(((_command: string, args: string[]) => {
		calls.push(args);
		if (args.at(-1)?.startsWith("^filter")) return result("", 1);
		if (args.at(-1)?.startsWith("^merge")) return result("merge.first.driver\0merge.second.driver\0");
		if (args.includes("ls-files") || args.includes("ls-tree")) return result("feature\0");
		if (args.includes("check-attr")) return result("feature\0filter\0unspecified\0");
		return result();
	}) as any);

	runner("/repo", ["merge", "--no-ff", "child"]);
	const merge = calls.at(-1)!;
	expect(merge).toContain("merge.first.driver=/usr/bin/false");
	expect(merge).toContain("merge.second.driver=/usr/bin/false");
});

test("merge preflight preserves built-in modes but rejects custom drivers", () => {
	for (const value of ["unspecified", "set", "unset", "text", "binary", "union"]) {
		expect(() => assertSupportedAttributes(["feature", "merge", value], "merge")).not.toThrow();
	}
	expect(() => assertSupportedAttributes(["feature", "merge", "swarm-probe"], "merge"))
		.toThrow("Custom Git merge drivers are unsupported: feature uses swarm-probe");
});
