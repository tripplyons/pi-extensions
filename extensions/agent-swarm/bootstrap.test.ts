import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { workerEnvironment } from "./isolation.ts";
import { workerExtensionArguments, workerPath } from "./process.ts";

test("worker bootstrap plans only the controller-owned extension set", () => {
	const entryPoint = fileURLToPath(new URL("./index.ts", import.meta.url));
	const withoutMixture = workerExtensionArguments(entryPoint, false);
	const withMixture = workerExtensionArguments(entryPoint, true);
	const values = (args: string[]) => args.filter((_value, index) => index % 2 === 1);

	expect(withoutMixture.filter(value => value === "--extension")).toHaveLength(4);
	expect(withMixture.filter(value => value === "--extension")).toHaveLength(5);
	for (const name of ["pi-codex-conversion", "bg-bash", "agent-swarm", "complain"]) {
		expect(values(withoutMixture).some(path => path.includes(name))).toBe(true);
	}
	expect(values(withoutMixture).some(path => path.includes("/mixture/"))).toBe(false);
	expect(values(withMixture).some(path => path.includes("/mixture/"))).toBe(true);
});

test("worker bootstrap isolates writable caches and builds a bounded executable path", () => {
	const environment = workerEnvironment({ HOME: "/private/home", TMPDIR: "/private/tmp", PI_SWARM_TOKEN: "token" });
	expect(environment).toMatchObject({
		HOME: "/private/home", TMPDIR: "/private/tmp", PI_SWARM_TOKEN: "token",
		XDG_CACHE_HOME: "/private/tmp/cache", PYTHONPYCACHEPREFIX: "/private/tmp/python-bytecode",
		UV_CACHE_DIR: "/private/tmp/uv-cache", UV_PROJECT_ENVIRONMENT: "/private/tmp/uv-venv",
	});
	const path = workerPath(["/private/bin/node", "/private/bin/git"], "/host/bin:relative:/usr/bin");
	expect(path.split(":")).toEqual(["/private/bin", "/host/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
});
