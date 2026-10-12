import { homedir } from "node:os";
import { basename, dirname, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultPackageManager,
	getAgentDir,
	getSettingsListTheme,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type PackageSource,
} from "@earendil-works/pi-coding-agent";
import { Box, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";

const ENABLED = "enabled";
const DISABLED = "disabled";
const SELF = fileURLToPath(import.meta.url);

type Resource = Awaited<ReturnType<DefaultPackageManager["resolve"]>>["extensions"][number];

interface ManagedExtension {
	resource: Resource;
	name: string;
}

function withoutFilterPrefix(entry: string): string {
	return /^[!+-]/.test(entry) ? entry.slice(1) : entry;
}

// Mirrors `pi config`: drop exact entries for the path, then add `-path` to
// disable. Enabling adds `+path` only when other filters could still exclude it.
function toggleEntry(entries: string[], pattern: string, enabled: boolean): string[] {
	const kept = entries.filter(entry => withoutFilterPrefix(entry) !== pattern);
	if (!enabled) return [...kept, `-${pattern}`];
	return kept.length > 0 ? [...kept, `+${pattern}`] : kept;
}

function displayName(resource: Resource): string {
	const { metadata, path } = resource;
	const base = metadata.packageRoot ?? metadata.baseDir ?? dirname(path);
	const parts = relative(base, path).slice(0, -extname(path).length).split("/");
	if (parts[parts.length - 1] === "index") parts.pop();
	const name = parts[parts.length - 1];
	if (!name || name === "extensions" || name === "src" || name === "dist" || name === "lib") return basename(base);
	return name;
}

function tildify(path: string): string {
	const home = homedir();
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function setEnabled(settings: SettingsManager, resource: Resource, enabled: boolean): void {
	const { metadata, path } = resource;
	const pattern = relative(metadata.baseDir ?? dirname(path), path);
	if (metadata.origin === "top-level") {
		settings.setExtensionPaths(toggleEntry(settings.getGlobalSettings().extensions ?? [], pattern, enabled));
		return;
	}

	const packages: PackageSource[] = [...(settings.getGlobalSettings().packages ?? [])];
	const index = packages.findIndex(pkg => (typeof pkg === "string" ? pkg : pkg.source) === metadata.source);
	if (index === -1) throw new Error(`Package ${metadata.source} is not in global settings.`);
	const current = packages[index]!;
	const pkg = typeof current === "string" ? { source: current } : { ...current };
	const extensions = toggleEntry(pkg.extensions ?? [], pattern, enabled);
	pkg.extensions = extensions.length > 0 ? extensions : undefined;
	const hasFilters = (["extensions", "skills", "prompts", "themes"] as const).some(key => pkg[key] !== undefined);
	packages[index] = hasFilters ? pkg : pkg.source;
	settings.setPackages(packages);
}

async function listExtensions(cwd: string, settings: SettingsManager): Promise<ManagedExtension[]> {
	const resolved = await new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: settings }).resolve();
	return resolved.extensions
		.filter(resource => resource.metadata.scope === "user" && resource.path !== SELF)
		.map(resource => ({ resource, name: displayName(resource) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

async function showMenu(ctx: ExtensionCommandContext, settings: SettingsManager, extensions: ManagedExtension[]): Promise<boolean> {
	const items: SettingItem[] = extensions.map(({ resource, name }) => ({
		id: resource.path,
		label: name,
		description: tildify(resource.path),
		currentValue: resource.enabled ? ENABLED : DISABLED,
		values: [ENABLED, DISABLED],
	}));
	const initial = new Map(items.map(item => [item.id, item.currentValue]));
	const current = new Map(initial);

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const box = new Box(1, 1, value => theme.bg("customMessageBg", value));
		box.addChild(new Text(theme.fg("customMessageText", "Extensions"), 0, 0));
		box.addChild(new Text(theme.fg("muted", "~/.pi/agent/settings.json · Pi reloads on close"), 0, 0));
		const maxVisible = Math.max(1, Math.min(items.length, Math.floor(tui.terminal.rows * 0.7) - 8));
		const list = new SettingsList(
			items,
			maxVisible,
			getSettingsListTheme(),
			(id, value) => {
				const extension = extensions.find(entry => entry.resource.path === id)!;
				setEnabled(settings, extension.resource, value === ENABLED);
				current.set(id, value);
			},
			() => done(),
			{ enableSearch: true },
		);
		box.addChild(list);
		return {
			render: (width: number) => box.render(width),
			invalidate: () => box.invalidate(),
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } });

	await settings.flush();
	return [...current].some(([id, value]) => initial.get(id) !== value);
}

export default function extensionManager(pi: ExtensionAPI): void {
	pi.registerCommand("extensions", {
		description: "Enable or disable installed extensions",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/extensions requires the TUI. Use `pi config` instead.", "error");
				return;
			}
			const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: false });
			const extensions = await listExtensions(ctx.cwd, settings);
			if (extensions.length === 0) {
				ctx.ui.notify("No installed extensions found.", "info");
				return;
			}
			if (!(await showMenu(ctx, settings, extensions))) return;
			await ctx.waitForIdle();
			await ctx.reload();
		},
	});
}
