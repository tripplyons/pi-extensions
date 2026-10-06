import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";

export function installHiddenThinkingBlocks(): () => void {
  const original = AssistantMessageComponent.prototype.render;
  const seen = new Set<AssistantMessageComponent>();
  const render = function (this: AssistantMessageComponent, width: number) {
    // Pi's hidden thinking runs are Text-backed mouse regions. Visible thinking
    // and assistant prose use Markdown. Remove only the native hidden markers.
    const { contentContainer } = this as unknown as { contentContainer: Container };
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
  AssistantMessageComponent.prototype.render = render;
  return () => {
    if (AssistantMessageComponent.prototype.render === render) AssistantMessageComponent.prototype.render = original;
    // Rebuild native rows, including markers, for components already rendered.
    for (const component of seen) component.invalidate();
    seen.clear();
  };
}
