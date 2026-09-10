import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const complainSchema = Type.Object({
	message: Type.String({ minLength: 1, description: "Specific environment or tool issue encountered, including what failed and its impact." }),
});

export type ComplainInput = Static<typeof complainSchema>;

export const complaintLogPath = () => {
	const configured = process.env.PI_COMPLAIN_LOG;
	if (configured) {
		if (!isAbsolute(configured)) throw new Error("PI_COMPLAIN_LOG must be an absolute path");
		return configured;
	}
	return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi", "complain", "complaints.jsonl");
};

export default function (pi: ExtensionAPI) {
	let writes = Promise.resolve();

	pi.registerTool({
		name: "complain",
		label: "Complain",
		description: "Record an environment or tool issue for later human review. Saves local plaintext with the current timestamp, session, working directory, model, and thinking level.",
		parameters: complainSchema,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const path = complaintLogPath();
			const record = {
				schemaVersion: 1,
				timestamp: new Date().toISOString(),
				message: params.message,
				toolCallId,
				session: {
					id: ctx.sessionManager.getSessionId(),
					path: ctx.sessionManager.getSessionFile() ?? null,
				},
				cwd: ctx.cwd,
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
				thinkingLevel: ctx.thinkingLevel,
			};

			const write = writes.then(async () => {
				await mkdir(dirname(path), { recursive: true, mode: 0o700 });
				const file = await open(path, "a", 0o600);
				try {
					await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
					await file.sync();
				} finally {
					await file.close();
				}
			});
			writes = write.then(() => undefined, () => undefined);
			await write;

			return {
				content: [{ type: "text" as const, text: `Complaint recorded at ${path}` }],
				details: { path, record },
			};
		},
	});
}
