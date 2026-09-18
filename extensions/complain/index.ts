import { renderResult } from "../../lib/tool-preview.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { result, stateRoot, text } from "../../lib/common.ts";

export default function complain(pi: ExtensionAPI) {
  pi.registerTool({ renderResult,
    name: "complain", label: "Record harness issue",
    description: "Record problems in Pi or this extension package for later review, not project bugs or missing dependencies. Report suspected harness problems proactively, explain impact and uncertainty, avoid duplicates, and never include secrets. This does not authorize edits or dependency installation in other projects.",
    parameters: Type.Object({ message: Type.String({ minLength: 1 }) }),
    async execute(id, { message }, signal, _update, ctx) {
      text(message, "message");
      signal?.throwIfAborted();
      const directory = join(stateRoot(), "complaints");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${Date.now()}-${randomUUID()}.json`);
      const record = {
        timestamp: new Date().toISOString(), message, toolCallId: id,
        session: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
        model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id },
        thinkingLevel: pi.getThinkingLevel(),
      };
      await writeFile(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx", signal });
      return result({ path });
    },
  });
}
