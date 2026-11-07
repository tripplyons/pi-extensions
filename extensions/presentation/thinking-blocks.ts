import { AssistantMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { isNarrationSignature } from "./narration.ts";

type AssistantMessage = Parameters<AssistantMessageComponent["updateContent"]>[0];
type ViewState = {
  contentContainer: Container;
  lastMessage?: AssistantMessage;
  hideThinkingBlock: boolean;
  outputPad: number;
  thinkingVisibilityOverrides: Map<number, boolean>;
  markdownSlots: Array<{ kind: string; markdown: Markdown }>;
};
type View = { expanded: boolean; toggled: Set<number> };

/** The latest nonempty line of a thinking run, without common Markdown markers. */
export function latestThinkingLine(text: string): string {
  const lines = stripTerminalSequences(text).split("\n").map(line => line.trim()).filter(Boolean);
  const line = lines.at(-1) ?? "";
  return line.replace(/^#{1,6}\s+/, "").replaceAll("**", "").replaceAll("__", "").replace(/\s+/g, " ").trim();
}

/** One truncated row of thinking text, styled like Pi's thinking blocks. */
class ThinkingRow implements Component {
  constructor(private readonly text: () => string, private readonly pad: number, private readonly theme: () => Theme | undefined) {}
  render(width: number): string[] {
    const theme = this.theme();
    const style = (text: string) => theme ? theme.italic(theme.fg("thinkingText", text)) : text;
    const pad = " ".repeat(Math.min(this.pad, Math.max(0, width - 1)));
    const available = Math.max(0, width - visibleWidth(pad));
    return [pad + truncateToWidth(style(this.text()), available, style("..."))];
  }
  invalidate(): void {}
}

/**
 * Shows each thinking run as one row while tool output is collapsed and in full
 * while expanded. Pi's hideThinkingBlock setting is ignored. Clicking a run
 * switches only that run until the next global expand or collapse.
 */
export function installCompactThinkingBlocks(getTheme: () => Theme | undefined = () => undefined): () => void {
  const proto = AssistantMessageComponent.prototype as AssistantMessageComponent & { setExpanded?: (expanded: boolean) => void };
  const original = proto.render;
  const originalUpdate = proto.updateContent;
  const hadSetExpanded = Object.prototype.hasOwnProperty.call(proto, "setExpanded");
  const originalSetExpanded = proto.setExpanded;
  const seen = new Set<AssistantMessageComponent>();
  const updated = new WeakSet<AssistantMessageComponent>();
  const views = new WeakMap<AssistantMessageComponent, View>();
  // Pi calls setExpanded on every chat child; new messages use the latest state.
  let expandedDefault = false;
  const viewOf = (component: AssistantMessageComponent) => {
    let view = views.get(component);
    if (!view) views.set(component, view = { expanded: expandedDefault, toggled: new Set() });
    return view;
  };
  const update = function (this: AssistantMessageComponent, message: AssistantMessage, isStreaming?: boolean) {
    updated.add(this);
    seen.add(this);
    const state = this as unknown as ViewState;
    const view = viewOf(this);
    // Native click handlers record a per-run override, then rebuild. Treat
    // each recorded override as one toggle between a single row and full text.
    for (const run of state.thinkingVisibilityOverrides?.keys() ?? []) {
      if (!view.toggled.delete(run)) view.toggled.add(run);
    }
    state.thinkingVisibilityOverrides?.clear();
    const content = message.content.map(block => block.type === "thinking" && isNarrationSignature(block.thinkingSignature)
      ? { type: "text" as const, text: block.thinking } : block);
    const hasNarration = content.some((block, i) => block !== message.content[i]);
    const hide = state.hideThinkingBlock;
    state.hideThinkingBlock = false;
    try {
      return originalUpdate.call(this, hasNarration ? { ...message, content } : message, isStreaming);
    } finally {
      state.hideThinkingBlock = hide;
      // Projection is display-only. Native invalidation and visibility toggles
      // must rebuild from the original signed message, not the projected copy.
      state.lastMessage = message;
      compactRuns(state, view, content);
    }
  };
  const compactRuns = (state: ViewState, view: View, content: AssistantMessage["content"]) => {
    // Mirror Pi's grouping: adjacent thinking blocks form one run, and runs
    // with no nonempty text are skipped without taking a run index.
    const runs: string[] = [];
    for (let i = 0; i < content.length; i++) {
      if (content[i].type !== "thinking") continue;
      const parts: string[] = [];
      for (; i < content.length && content[i].type === "thinking"; i++) {
        const text = (content[i] as { thinking: string }).thinking.trim();
        if (text) parts.push(text);
      }
      i--;
      if (parts.length) runs.push(parts.join("\n\n"));
    }
    const thinking = new Set(state.markdownSlots?.filter(slot => slot.kind === "thinking").map(slot => slot.markdown));
    let run = 0;
    for (const child of state.contentContainer.children) {
      if (!(child instanceof MouseRegion)) continue;
      const region = child as unknown as { child: Component };
      if (!thinking.has(region.child as Markdown)) continue;
      const index = run++;
      const full = view.expanded !== view.toggled.has(index);
      if (full) continue;
      const text = runs[index] ?? "";
      region.child = new ThinkingRow(() => latestThinkingLine(text), state.outputPad ?? 1, getTheme);
    }
  };
  const render = function (this: AssistantMessageComponent, width: number) {
    // Also adapt components created before installation, including session replay.
    const state = this as unknown as ViewState;
    if (!updated.has(this) && state.lastMessage) update.call(this, state.lastMessage);
    return original.call(this, width);
  };
  const setExpanded = function (this: AssistantMessageComponent, expanded: boolean) {
    expandedDefault = expanded;
    const view = viewOf(this);
    view.expanded = expanded;
    view.toggled.clear();
    const state = this as unknown as ViewState;
    if (state.lastMessage) update.call(this, state.lastMessage);
  };
  proto.updateContent = update;
  proto.render = render;
  proto.setExpanded = setExpanded;
  return () => {
    if (proto.render === render) proto.render = original;
    if (proto.updateContent === update) proto.updateContent = originalUpdate;
    if (proto.setExpanded === setExpanded) {
      if (hadSetExpanded) proto.setExpanded = originalSetExpanded;
      else delete proto.setExpanded;
    }
    // Rebuild native rows, including hidden thinking markers and narration, on removal.
    for (const component of seen) component.invalidate();
    seen.clear();
  };
}
