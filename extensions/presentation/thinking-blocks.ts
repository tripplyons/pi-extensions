import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import { isNarrationSignature } from "./narration.ts";

type AssistantMessage = Parameters<AssistantMessageComponent["updateContent"]>[0];
type ViewState = { contentContainer: Container; lastMessage?: AssistantMessage };

export function installHiddenThinkingBlocks(): () => void {
  const original = AssistantMessageComponent.prototype.render;
  const originalUpdate = AssistantMessageComponent.prototype.updateContent;
  const seen = new Set<AssistantMessageComponent>();
  const updated = new WeakSet<AssistantMessageComponent>();
  const update = function (this: AssistantMessageComponent, message: AssistantMessage, isStreaming?: boolean) {
    updated.add(this);
    const content = message.content.map(block => block.type === "thinking" && isNarrationSignature(block.thinkingSignature)
      ? { type: "text" as const, text: block.thinking } : block);
    const hasNarration = content.some((block, i) => block !== message.content[i]);
    if (hasNarration) seen.add(this);
    try {
      return originalUpdate.call(this, hasNarration ? { ...message, content } : message, isStreaming);
    } finally {
      // Projection is display-only. Native invalidation and visibility toggles
      // must rebuild from the original signed message, not the projected copy.
      (this as unknown as ViewState).lastMessage = message;
    }
  };
  const render = function (this: AssistantMessageComponent, width: number) {
    // Also adapt components created before installation, including session replay.
    const state = this as unknown as ViewState;
    if (!updated.has(this) && state.lastMessage) update.call(this, state.lastMessage);
    // Pi's hidden thinking runs are Text-backed mouse regions. Visible thinking
    // and assistant prose use Markdown. Remove only the native hidden markers.
    const { contentContainer } = state;
    const children = contentContainer.children;
    const hidden = new Set(children.filter(child => child instanceof MouseRegion && (child as unknown as { child: unknown }).child instanceof Text));
    if (hidden.size) {
      seen.add(this);
      const visible = children.filter((child, i) => !hidden.has(child)
        && !(child instanceof Spacer && hidden.has(children[i - 1])
          && (children[i + 1] instanceof Markdown || children[i + 1] instanceof MouseRegion)));
      // The initial spacer belongs to visible prose/thinking, not error notices.
      if (visible[0] instanceof Spacer && !visible.some(child => child instanceof Markdown || child instanceof MouseRegion)) visible.shift();
      while (visible.at(-1) instanceof Spacer) visible.pop();
      contentContainer.children = visible;
    }
    return original.call(this, width);
  };
  AssistantMessageComponent.prototype.updateContent = update;
  AssistantMessageComponent.prototype.render = render;
  return () => {
    if (AssistantMessageComponent.prototype.render === render) AssistantMessageComponent.prototype.render = original;
    if (AssistantMessageComponent.prototype.updateContent === update) AssistantMessageComponent.prototype.updateContent = originalUpdate;
    // Rebuild native rows, including thinking markers and narration, on removal.
    for (const component of seen) component.invalidate();
    seen.clear();
  };
}
