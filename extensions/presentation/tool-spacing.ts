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
    return original.call(this, width);
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
