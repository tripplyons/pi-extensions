import type {
	AgentToolResult,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";

const PREVIEW_LINES = 6;

interface StatusRendererState {
	shell: Box;
	resultShell: Box;
	call?: Component;
	result?: Component;
}

const states = new WeakMap<object, StatusRendererState>();
const SPECIAL_RENDERERS = "__trippToolStatusStyleSpecialRenderers";
const specialRendererDefinitions = ((globalThis as Record<string, unknown>)[SPECIAL_RENDERERS] ??= new Map<string, ToolDefinition>()) as Map<string, ToolDefinition>;

class StatusHeader implements Component {
	constructor(
		private readonly prefix: string,
		private readonly content: Component,
	) {}

	render(width: number): string[] {
		if (!this.prefix) return this.content.render(width);

		const prefixWidth = visibleWidth(this.prefix);
		const lines = this.content.render(Math.max(1, width - prefixWidth));
		return lines.map((line, index) =>
			truncateToWidth(`${index === 0 ? this.prefix : " ".repeat(prefixWidth + 2)}${line}`, width, ""),
		);
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

class StatusBody implements Component {
	constructor(
		private readonly prefix: string,
		private readonly content: Component,
	) {}

	render(width: number): string[] {
		const indent = " ".repeat(visibleWidth(this.prefix) + 2);
		return this.content.render(Math.max(1, width - indent.length))
			.map((line) => truncateToWidth(`${indent}${line}`, width, ""));
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

class LimitedResult implements Component {
	constructor(
		private readonly content: Component,
		private readonly expanded: boolean,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const lines = this.content.render(width);
		if (this.expanded || lines.length <= PREVIEW_LINES) return lines;

		const hiddenLineCount = lines.length - PREVIEW_LINES;
		return [
			this.theme.fg("muted", `… ${hiddenLineCount} lines hidden`),
			...lines.slice(-PREVIEW_LINES),
		];
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

const statusPrefix = (theme: Theme, isPartial: boolean, isError: boolean) => {
	if (isPartial) return theme.fg("warning", "● ");
	return isError ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
};

const textResult = (result: AgentToolResult<unknown>, theme: Theme) => {
	const output = result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return new Text(theme.fg("toolOutput", output), 0, 0);
};

/**
 * Mark any tool result whose details carry a string `error` field as a failed
 * status card. Applies to every tool automatically.
 */
export const returnedErrorPatch = (_toolName: string, details: unknown) => {
	if (typeof (details as { error?: unknown } | undefined)?.error === "string") return { isError: true as const };
};

export const withStatusCard = <TParams extends TSchema, TDetails, TState>(
	definition: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> => {
	type CallRenderer = NonNullable<ToolDefinition<TParams, TDetails, TState>["renderCall"]>;
	type ResultRenderer = NonNullable<ToolDefinition<TParams, TDetails, TState>["renderResult"]>;

	const originalCall = definition.renderCall;
	const originalResult = definition.renderResult;

	const renderCall: CallRenderer = (args, theme, context) => {
		let state = states.get(context.state as object);
		if (!state) {
			state = { shell: new Box(1, 1), resultShell: new Box(0, 0) };
			states.set(context.state as object, state);
		}

		state.shell.clear();
		state.call = originalCall
			? originalCall(args, theme, { ...context, lastComponent: state.call })
			: new Text(theme.fg("toolTitle", theme.bold(definition.name)), 0, 0);
		const prefix = statusPrefix(theme, context.isPartial, context.isError);
		state.shell.addChild(new StatusHeader(prefix, state.call));
		state.shell.addChild(new StatusBody(prefix, state.resultShell));
		return state.shell;
	};

	const renderResult: ResultRenderer = (result, options, theme, context) => {
		const state = states.get(context.state as object);
		if (state) {
			state.result = originalResult
				? originalResult(result, options, theme, { ...context, lastComponent: state.result })
				: textResult(result, theme);
			state.resultShell.clear();
			state.resultShell.addChild(new LimitedResult(state.result, options.expanded, theme));
		}

		return context.lastComponent ?? new Container();
	};

	return {
		...definition,
		renderShell: "self",
		renderCall,
		renderResult,
	};
};

/**
 * Install a custom renderer for a self-rendered built-in tool. The renderer is
 * installed before tool calls are created, avoiding the first-call timing gap
 * caused by registering a replacement during session_start.
 */
export const installSpecialToolRenderer = (
	name: string,
	renderCall: NonNullable<ToolDefinition["renderCall"]>,
	renderResult: NonNullable<ToolDefinition["renderResult"]>,
) => {
	specialRendererDefinitions.set(name, withStatusCard({
		name,
		label: name,
		description: name,
		parameters: {} as TSchema,
		async execute() {
			return { content: [], details: undefined };
		},
		renderCall: renderCall as any,
		renderResult: renderResult as any,
	} as ToolDefinition));
};

/**
 * Shape of the ToolExecutionComponent instances the status card renderers are
 * installed onto. Kept structural (instead of importing the class) so the
 * installer stays testable without loading the full pi package.
 */
interface ToolExecutionLike {
	toolName: string;
	toolDefinition?: ToolDefinition | undefined;
	builtInToolDefinition?: ToolDefinition | undefined;
}

/** Methods the installer replaces on the component prototype. */
interface StatusCardPatchTarget {
	getRenderShell(): string;
	getCallRenderer(): unknown;
	getResultRenderer(): unknown;
	hasRendererDefinition(): boolean;
}

type ToolExecutionComponentClass = {
	prototype: object;
	new (...args: never[]): unknown;
};

interface GlobalStatusState {
	shell: Box;
	resultShell: Box;
	call?: Component;
	result?: Component;
}

const globalStatusStates = new WeakMap<object, GlobalStatusState>();
const STATUS_CARD_ORIGINALS = "__toolStatusStyleOriginals" as const;

const isSelfRendered = (component: ToolExecutionLike) =>
	(component.toolDefinition ?? component.builtInToolDefinition)?.renderShell === "self";

/**
 * Install the status card on every tool call automatically.
 *
 * The extension API only lets a tool definition opt in to custom rendering via
 * `renderShell: "self"` + renderCall/renderResult, so tools that do not opt in
 * (all builtin tools and most extension tools) never get the card. This patches
 * the exported ToolExecutionComponent class so every tool call renders through
 * the status card shell. Tools that already render themselves (renderShell
 * "self", e.g. read and the bg-bash tools) are left untouched to avoid
 * double-wrapping.
 *
 * Original methods are captured once, while the patched closures are rebound
 * on every /reload so they can see the current extension module state.
 */
export const installGlobalStatusCards = (componentClass: ToolExecutionComponentClass) => {
	const proto = componentClass.prototype as StatusCardPatchTarget &
		Record<string, unknown> & { [STATUS_CARD_ORIGINALS]?: unknown };

	type CallRenderer = NonNullable<ToolDefinition["renderCall"]>;
	type ResultRenderer = NonNullable<ToolDefinition["renderResult"]>;
	type Originals = {
		getRenderShell: () => string;
		getCallRenderer: () => CallRenderer | undefined;
		getResultRenderer: () => ResultRenderer | undefined;
		hasRendererDefinition: () => boolean;
	};

	const originals = (proto[STATUS_CARD_ORIGINALS] as Originals | undefined) ?? {
		getRenderShell: proto.getRenderShell as () => string,
		getCallRenderer: proto.getCallRenderer as () => CallRenderer | undefined,
		getResultRenderer: proto.getResultRenderer as () => ResultRenderer | undefined,
		hasRendererDefinition: proto.hasRendererDefinition as () => boolean,
	};
	proto[STATUS_CARD_ORIGINALS] = originals;

	proto.getRenderShell = function () {
		return "self";
	};
	proto.hasRendererDefinition = function () {
		return true;
	};
	proto.getCallRenderer = function (this: ToolExecutionLike) {
		const special = specialRendererDefinitions.get(this.toolName);
		if (special?.renderCall) return special.renderCall;
		if (isSelfRendered(this)) return originals.getCallRenderer.call(this);
		const original = originals.getCallRenderer.call(this);
		const renderCall: CallRenderer = (args, theme, context) => {
			let state = globalStatusStates.get(this);
			if (!state) {
				state = { shell: new Box(1, 1), resultShell: new Box(0, 0) };
				globalStatusStates.set(this, state);
			}
			state.shell.clear();
			state.call = original
				? original(args, theme, { ...context, lastComponent: state.call })
				: new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
			const prefix = statusPrefix(theme, context.isPartial, context.isError);
			state.shell.addChild(new StatusHeader(prefix, state.call));
			state.shell.addChild(new StatusBody(prefix, state.resultShell));
			return state.shell;
		};
		return renderCall;
	};
	proto.getResultRenderer = function (this: ToolExecutionLike) {
		const special = specialRendererDefinitions.get(this.toolName);
		if (special?.renderResult) return special.renderResult;
		if (isSelfRendered(this)) return originals.getResultRenderer.call(this);
		const original = originals.getResultRenderer.call(this);
		const renderResult: ResultRenderer = (result, options, theme, context) => {
			const state = globalStatusStates.get(this);
			if (state) {
				state.result = original
					? original(result, options, theme, { ...context, lastComponent: state.result })
					: textResult(result, theme);
				state.resultShell.clear();
				state.resultShell.addChild(new LimitedResult(state.result, options.expanded, theme));
			}
			return context.lastComponent ?? new Container();
		};
		return renderResult;
	};
};
