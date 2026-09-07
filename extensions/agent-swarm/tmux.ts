import { spawnSync } from "node:child_process";

export const runTmux = (args: string[], allowFailure = false) => {
	const result = spawnSync("tmux", args, { encoding: "utf8" });
	if (result.error) {
		if (allowFailure) return { ok: false, stdout: "", stderr: result.error.message, status: null };
		throw new Error(`tmux is required for agent-swarm: ${result.error.message}`);
	}
	if (result.status !== 0) {
		if (allowFailure) return { ok: false, stdout: result.stdout, stderr: result.stderr, status: result.status };
		throw new Error(result.stderr.trim() || result.stdout.trim() || `tmux exited with code ${result.status}`);
	}
	return { ok: true, stdout: result.stdout, stderr: result.stderr, status: result.status };
};

export const tmuxSessionExists = (session: string) => runTmux(["has-session", "-t", session], true).ok;
export const tmuxWindowExists = (session: string, window: string) => runTmux(["list-windows", "-t", session, "-F", "#{window_name}"], true).stdout.split("\n").includes(window);
export const tmuxWindowAlive = (session: string, window: string) => {
	if (!tmuxWindowExists(session, window)) return false;
	const panes = runTmux(["list-panes", "-t", `${session}:${window}`, "-F", "#{pane_dead}"], true);
	return panes.ok && panes.stdout.trim() !== "1";
};
export const capturePane = (session: string, window: string, lines: number) => {
	if (!tmuxWindowExists(session, window)) throw new Error(`tmux window is not available: ${session}:${window}`);
	return runTmux(["capture-pane", "-p", "-J", "-t", `${session}:${window}`, "-S", `-${lines}`]).stdout;
};
