import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";

export function installCompactToolSpacing(): () => void {
  const original = ToolExecutionComponent.prototype.render;
  const originalMouse = ToolExecutionComponent.prototype.handleMouse;
  const originalContainer = Container.prototype.render;
  const groupStarts = new WeakSet<ToolExecutionComponent>();
  const separatorRemoved = new WeakSet<ToolExecutionComponent>();
  const padding = new Map<{ paddingY: number; invalidate(): void }, number>();
  const render = function (this: ToolExecutionComponent, width: number) {
    // Pi has no tool-shell padding setting. Leave custom renderers untouched.
    const shells = this as unknown as {
      contentBox: { paddingY: number; invalidate(): void };
      contentText: { paddingY: number; invalidate(): void };
    };
    for (const shell of [shells.contentBox, shells.contentText]) {
      if (padding.has(shell)) continue;
      padding.set(shell, shell.paddingY);
      shell.paddingY = 0;
      shell.invalidate();
    }
    // Pi appends images outside tool renderers, even when a renderer is collapsed.
    const images = this as unknown as {
      expanded: boolean;
      imageComponents: typeof this.children;
      imageSpacers: typeof this.children;
      toolDefinition?: { renderShell?: string };
      selfRenderHeight: number;
    };
    const children = this.children;
    const imageComponents = images.imageComponents;
    if (!images.expanded) {
      const hidden = new Set([...imageComponents, ...images.imageSpacers]);
      this.children = children.filter(child => !hidden.has(child));
      images.imageComponents = [];
    }
    try {
      const lines = original.call(this, width);
      // Drop only Pi's outer separator, not blank rows owned by tool renderers.
      // Self-rendered image-only tools have no outer separator.
      const hasSeparator = images.toolDefinition?.renderShell !== "self" || images.selfRenderHeight > 0;
      if (hasSeparator && lines[0] === "" && !groupStarts.has(this)) {
        separatorRemoved.add(this);
        return lines.slice(1);
      }
      separatorRemoved.delete(this);
      return lines;
    }
    finally {
      this.children = children;
      images.imageComponents = imageComponents;
    }
  };
  const handleMouse: typeof originalMouse = function (event) {
    // Native hit testing still includes the removed separator row.
    return originalMouse.call(this, separatorRemoved.has(this)
      ? { ...event, y: event.y + 1, height: event.height + 1 }
      : event);
  };
  const renderContainer = function (this: Container, width: number) {
    if (!this.children.some(child => child instanceof ToolExecutionComponent)) return originalContainer.call(this, width);
    // Pi has no transcript group-spacing hook. Match its container layout while
    // retaining the separator only before the first visible tool in each run.
    const lines: string[] = [];
    const mouseChildren: Array<{ component: Component; height: number }> = [];
    let previousWasTool = false;
    for (const child of this.children) {
      const isTool = child instanceof ToolExecutionComponent;
      if (isTool) {
        if (previousWasTool) groupStarts.delete(child);
        else groupStarts.add(child);
      }
      const childLines = child.render(width);
      mouseChildren.push({ component: child, height: childLines.length });
      for (const line of childLines) lines.push(line);
      // Empty assistant messages, including hidden thinking, do not split groups.
      if (childLines.length) previousWasTool = isTool;
    }
    (this as unknown as { mouseLayout: { width: number; children: typeof mouseChildren } }).mouseLayout = { width, children: mouseChildren };
    return lines;
  };
  ToolExecutionComponent.prototype.render = render;
  ToolExecutionComponent.prototype.handleMouse = handleMouse;
  Container.prototype.render = renderContainer;
  return () => {
    for (const [shell, originalPadding] of padding) {
      shell.paddingY = originalPadding;
      shell.invalidate();
    }
    padding.clear();
    if (ToolExecutionComponent.prototype.render === render) ToolExecutionComponent.prototype.render = original;
    if (ToolExecutionComponent.prototype.handleMouse === handleMouse) ToolExecutionComponent.prototype.handleMouse = originalMouse;
    if (Container.prototype.render === renderContainer) Container.prototype.render = originalContainer;
  };
}
