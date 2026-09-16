const files = process.argv.slice(2);
const concurrency = positiveInteger(process.env.PI_TEST_JOBS, 4);
const timeoutMs = positiveInteger(process.env.PI_TEST_FILE_TIMEOUT_MS, 30_000);
let cursor = 0;
let failed = false;

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function run(file: string): Promise<void> {
	const started = performance.now();
	const process = Bun.spawn(["bun", "test", "--smol", "--only-failures", file], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(process.stdout).text();
	const stderr = new Response(process.stderr).text();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		process.kill(9);
	}, timeoutMs);
	const exitCode = await process.exited;
	clearTimeout(timeout);
	const output = `${await stdout}${await stderr}`.trim();
	const elapsed = ((performance.now() - started) / 1_000).toFixed(1);
	const status = timedOut ? `TIMEOUT after ${timeoutMs}ms` : exitCode === 0 ? "pass" : `FAIL (${exitCode})`;
	console.log(`\n[${status}] ${file} (${elapsed}s)${output ? `\n${output}` : ""}`);
	if (timedOut || exitCode !== 0) failed = true;
}

async function worker(): Promise<void> {
	while (true) {
		const index = cursor++;
		if (index >= files.length) return;
		await run(files[index]!);
	}
}

await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
if (failed) process.exitCode = 1;
