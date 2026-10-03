import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

export function installCompactToolSpacing(): () => void {
  const original = ToolExecutionComponent.prototype.render;
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
    };
    if (images.expanded) return original.call(this, width);
    const children = this.children;
    const imageComponents = images.imageComponents;
    const hidden = new Set([...imageComponents, ...images.imageSpacers]);
    this.children = children.filter(child => !hidden.has(child));
    images.imageComponents = [];
    try { return original.call(this, width); }
    finally {
      this.children = children;
      images.imageComponents = imageComponents;
    }
  };
  ToolExecutionComponent.prototype.render = render;
  return () => {
    for (const [shell, originalPadding] of padding) {
      shell.paddingY = originalPadding;
      shell.invalidate();
    }
    padding.clear();
    if (ToolExecutionComponent.prototype.render === render) ToolExecutionComponent.prototype.render = original;
  };
}
