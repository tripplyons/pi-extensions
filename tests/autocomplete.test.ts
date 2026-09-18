import { expect, test } from "bun:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("native completion suggests and applies extension commands, skills and file paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-completion-"));
  try {
    writeFileSync(join(root, "example.txt"), "fixture");
    const provider = new CombinedAutocompleteProvider([
      { name: "reasoning", description: "Set reasoning" },
      { name: "skill:example", description: "Example skill" },
    ], root);
    for (const [input, expected] of [["/reas", "/reasoning"], ["/skill:exa", "/skill:example"], ["./exa", "./example.txt"]]) {
      const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: new AbortController().signal, force: !input.startsWith("/") });
      expect(suggestions).not.toBeNull();
      const item = suggestions!.items.find(item => item.value === (input.startsWith("/") ? expected.slice(1) : expected));
      expect(item).toBeDefined();
      const applied = provider.applyCompletion([input], 0, input.length, item!, suggestions!.prefix);
      expect(applied.lines[0].trim()).toBe(expected);
      expect(applied.cursorCol).toBe(applied.lines[0].length);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
