import { spawnSync } from "node:child_process";

export const tmux = (args: string[], allowFailure = false) => {
	const result = spawnSync("tmux", args, { encoding: "utf8" });
	if ((result.error || result.status !== 0) && !allowFailure) throw new Error(result.error?.message ?? (result.stderr.trim() || `tmux exited ${result.status}`));
	return { ok: !result.error && result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
export const sessionExists = (session: string) => tmux(["has-session", "-t", session], true).ok;
export const windowExists = (session: string, window: string) => tmux(["list-windows", "-t", session, "-F", "#{window_name}"], true).stdout.split("\n").includes(window);
export const captureWindow = (session: string, window: string, lines = 80) => {
	if (!windowExists(session, window)) throw new Error(`tmux window unavailable: ${session}:${window}`);
	return tmux(["capture-pane", "-p", "-J", "-t", `${session}:${window}`, "-S", `-${Math.max(1, Math.min(500, Math.floor(lines)))}`]).stdout;
};
export const killWindow = (session: string, window: string) => tmux(["kill-window", "-t", `${session}:${window}`], true).ok;
