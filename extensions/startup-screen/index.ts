import { homedir } from "node:os";
import { relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface RenderableNode {
	children?: RenderableNode[];
	getExpandedText?: () => string;
	getCollapsedText?: () => string;
	setText?: (text: string) => void;
	invalidate(): void;
	render(width: number): string[];
}

interface StartupTui extends RenderableNode {
	requestRender(force?: boolean): void;
}

const LOGO = [
	"██████╗ ██╗",
	"██╔══██╗██║",
	"██████╔╝██║",
	"██╔═══╝ ██║",
	"██║     ██║",
	"╚═╝     ╚═╝",
];
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const FILTER_DELAYS_MS = [0, 50, 250, 1_000] as const;
const HIDDEN_SECTIONS = new Set(["[Prompts]", "[Themes]"]);
const PROJECT_SECTIONS = new Set(["[Context]", "[Skills]", "[Extensions]"]);

function projectSection(text: string, heading: string): string {
	const [title, ...lines] = text.split("\n");
	let project = false;
	const kept = lines.filter((line) => {
		const plain = line.replace(ANSI_ESCAPE, "");
		if (heading === "[Context]") {
			const path = plain.trim();
			return ![displayDirectory(getAgentDir()), "~/.agents", "~/AGENTS.md", "~/CLAUDE.md"].some(
				(global) => path === global || path.startsWith(`${global}/`),
			);
		}
		if (/^  \S/.test(plain)) project = plain.trim() === "project";
		return project;
	});
	return kept.length ? [title, ...kept].join("\n") : "";
}

function centered(text: string, width: number): string {
	const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
	return truncateToWidth(`${" ".repeat(padding)}${text}`, width, "");
}

export function displayDirectory(cwd: string, home = homedir()): string {
	if (cwd === home) return "~";
	return cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
}

export function renderHeader(theme: Theme, cwd: string, width: number): string[] {
	const logo = LOGO.map((line) => centered(theme.fg("accent", theme.bold(line)), width));
	const subtitle = centered(theme.fg("muted", displayDirectory(cwd)), width);
	return ["", ...logo, subtitle, ""];
}

function renderedText(component: RenderableNode): string {
	try {
		return component.render(200).join("\n").replace(ANSI_ESCAPE, "");
	} catch {
		return "";
	}
}

export function removeHiddenSection(component: RenderableNode): boolean {
	if (!Array.isArray(component.children)) return false;

	for (let index = 0; index < component.children.length; index += 1) {
		const child = component.children[index]!;
		const heading = renderedText(child).split("\n").find((line) => line.trim())?.trim();
		let empty = false;
		if (heading && PROJECT_SECTIONS.has(heading) && child.getExpandedText && child.setText) {
			const expanded = child.getExpandedText();
			const filtered = projectSection(expanded, heading);
			empty = !filtered;
			if (filtered && (filtered !== expanded || child.getCollapsedText?.() !== filtered)) {
				child.getExpandedText = () => filtered;
				child.getCollapsedText = () => filtered;
				child.setText(filtered);
				component.invalidate();
				return true;
			}
		}
		if (empty || (heading && HIDDEN_SECTIONS.has(heading))) {
			const following = component.children[index + 1];
			const removeCount = following && renderedText(following).trim() === "" ? 2 : 1;
			component.children.splice(index, removeCount);
			component.invalidate();
			return true;
		}
		if (removeHiddenSection(child)) return true;
	}

	return false;
}

export default function startupScreenExtension(pi: ExtensionAPI) {
	let activeTui: StartupTui | undefined;
	let filterTimers: Array<ReturnType<typeof setTimeout>> = [];

	const clearFilterTimers = () => {
		for (const timer of filterTimers) clearTimeout(timer);
		filterTimers = [];
	};

	const scheduleSectionFilter = (tui: StartupTui) => {
		clearFilterTimers();
		for (const delay of FILTER_DELAYS_MS) {
			filterTimers.push(setTimeout(() => {
				let changed = false;
				while (removeHiddenSection(tui)) changed = true;
				if (changed) tui.requestRender(true);
			}, delay));
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((tui, theme) => {
			activeTui = tui as StartupTui;
			scheduleSectionFilter(activeTui);
			return {
				invalidate() {},
				render: (width: number) => renderHeader(theme, ctx.cwd, width),
			};
		});
	});

	pi.on("resources_discover", () => {
		if (activeTui) scheduleSectionFilter(activeTui);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearFilterTimers();
		activeTui = undefined;
		if (ctx.mode === "tui") ctx.ui.setHeader(undefined);
	});
}
