import { Container, VStack, type Component, type StackEntry, type TUI } from "@earendil-works/pi-tui";

export function compactEditorLayout(tui: TUI, editor: Component): () => void {
  const changed = new Map<StackEntry, PropertyDescriptor | undefined>();
  const original = editor.render;
  function compact(component: Component) {
    if (component instanceof VStack) {
      // Pi's fullscreen dock reserves three rows for the bordered editor.
      // There is no public API for changing an existing stack entry's minimum.
      const { entries } = component as unknown as { entries: StackEntry[] };
      for (const entry of entries) {
        const container = entry.component;
        if (container instanceof Container && container.children.includes(editor) && !changed.has(entry)) {
          const minSize = entry.minSize;
          changed.set(entry, Object.getOwnPropertyDescriptor(entry, "minSize"));
          Object.defineProperty(entry, "minSize", {
            configurable: true, enumerable: true,
            // Selectors temporarily replace the editor in the same container.
            get: () => container.children.includes(editor) ? 0 : minSize,
          });
        }
      }
    }
    if (component instanceof Container) component.children.forEach(compact);
  }
  const render = (width: number) => {
    // The TUI reference follows renderer switches. Regular mode has no layout root.
    const root = (tui as unknown as { layoutRoot?: Component }).layoutRoot;
    if (root) compact(root);
    return original.call(editor, width);
  };
  editor.render = render;
  return () => {
    if (editor.render === render) editor.render = original;
    for (const [entry, descriptor] of changed) {
      if (descriptor) Object.defineProperty(entry, "minSize", descriptor);
      else delete entry.minSize;
    }
    changed.clear();
  };
}
