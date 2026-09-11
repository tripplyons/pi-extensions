import type { WorkerResult } from "./runner.ts";

export interface MixtureOutput {
	task: string;
	succeeded: number;
	failed: number;
	results: WorkerResult[];
}

const formatUsage = (result: WorkerResult) =>
	`turns=${result.usage.turns} input=${result.usage.input} output=${result.usage.output} cost=${result.usage.cost.toFixed(4)}`;

const formatResult = (result: WorkerResult) => {
	const header = `## ${result.model} [${result.status}] ${formatUsage(result)}`;
	const location = result.branch ? `branch=${result.branch}` : `worktree=${result.worktree}`;
	const stat = result.diffStat ? `\nChanged files:\n${result.diffStat}` : "";
	if (result.status !== "ok") return `${header}\n${location}\nError: ${result.error ?? "unknown"}`;
	const body = result.output || "(no output)";
	return `${header}\n${location}${stat}\n\n${body}`;
};

export const formatMixture = (task: string, results: WorkerResult[]): MixtureOutput => ({
	task,
	succeeded: results.filter((result) => result.status === "ok").length,
	failed: results.filter((result) => result.status !== "ok").length,
	results,
});

export const renderMixture = (output: MixtureOutput): string => {
	const lines = [
		`Mixture result for: ${output.task}`,
		`${output.succeeded} of ${output.results.length} workers succeeded.`,
		"Pick the best answer or combine the best parts of each. Apply edits in the main checkout yourself; worker branches above hold their file changes for inspection.",
		"",
		...output.results.map(formatResult),
	];
	return lines.join("\n");
};
