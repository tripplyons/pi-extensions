// Explicitly loaded by isolated TUI tests, never by the package manifest.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMixtureExtension } from "./index.ts";
import { emitMessage, emptyUsage, failureMessage, type Registry } from "./provider.ts";
import cleanFooter from "../clean-footer/index.ts";

const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
const tool = (name: string, args: Record<string, unknown>): AssistantMessage["content"] => [{ type: "toolCall", id: `fixture_${crypto.randomUUID().replaceAll("-", "")}`, name, arguments: args }];
const plain = (context: Context) => JSON.stringify(context.messages);
export default async function fixture(pi: ExtensionAPI) {
	if (process.env.PI_MIXTURE_TUI_FIXTURE !== "1") throw new Error("TUI fixture requires an explicit isolated test environment");
	const cwd = process.cwd();
	const find: Registry["find"] = (provider, id) => ({ provider, id, name: `Fixture ${id}`, api: "mixture-fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 4096,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
	const source = () => readFileSync(join(cwd, "clamp.mjs"), "utf8");
	function response(model: Model<any>, context: Context): AssistantMessage["content"] {
		if (model.id.startsWith("reviewer")) {
			const last = context.messages.at(-1);
			if (last?.role !== "toolResult" || last.toolName !== "read") return tool("read", { path: "clamp.mjs" });
			const updates = context.messages.filter(message => message.role === "user");
			const revision = Number(JSON.stringify(updates.at(-1)).match(/Review requested at revision (\d+)/)?.[1]);
			const contents = JSON.stringify(last.content);
			return tool("mixture_review", { revision, findings: contents.includes("Math.min") && !contents.includes("Math.max") ? [{ id: "negative-input", severity: "blocker", summary: "Negative input is not clamped to zero", path: "clamp.mjs", evidence: "Math.min(-1, 10) returns -1, not 0." }] : [] });
		}
		if (!context.tools?.length) return text("The writer implemented clamp.mjs, corrected negative inputs, and ran check.mjs. Re-read current files before more work.");
		if (model.id === "ordinary") {
			if (context.tools?.some(tool => tool.name === "mixture_control")) throw new Error("Mixture controls leaked into an ordinary model request");
			return text("Ordinary model selected; no Mixture collaborators ran.");
		}
		if (model.id === "writer") {
			if (!source().includes("Math.min")) return tool("write", { path: "clamp.mjs", content: "export const clamp = n => Math.min(n, 10);\n" });
			if (!source().includes("Math.max") && plain(context).includes("Correct negative")) return tool("edit", { path: "clamp.mjs", oldText: "Math.min(n, 10)", newText: "Math.max(0, Math.min(n, 10))" });
			if (source().includes("Math.max") && !context.messages.some(message => message.role === "toolResult" && message.toolName === "bash")) return tool("bash", { command: "node check.mjs" });
			return text(source().includes("Math.max") ? "Corrected clamp.mjs. node check.mjs passed for negative, in-range and above-range inputs." : "Implemented clamp.mjs. Tests have not run; please assess the review findings.");
		}
		if (plain(context).includes("Slow review") && context.messages.at(-1)?.role === "user") return tool("read", { path: "clamp.mjs" });
		if (!source().includes("Math.min")) return tool("mixture_control", { action: "delegate", task: "Implement clamp.mjs for values between zero and ten", constraints: ["Preserve unrelated.txt"], successCriteria: ["Clamp negative inputs to zero", "Clamp values above ten to ten", "Run node check.mjs"] });
		if (!source().includes("Math.max")) return tool("mixture_control", { action: "delegate", task: "Correct negative inputs in clamp.mjs and run node check.mjs", constraints: ["Preserve unrelated.txt"], successCriteria: ["All three assertions pass"] });
		return text("Implemented clamp.mjs and corrected the negative-input defect identified by both reviewers. node check.mjs passes. unrelated.txt is unchanged.");
	}
	const provider: Provider = { id: "fixture", name: "Unpaid TUI fixture", auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
		getModels: () => ["lead", "writer", "reviewer1", "reviewer2", "ordinary"].map(id => find("fixture", id)!), stream: () => { throw new Error("Use simple stream"); },
		streamSimple: (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			const slow = (model.id !== "ordinary" && plain(context).includes("Slow request")) || (model.id.startsWith("reviewer") && plain(context).includes("Slow review"));
			const abort = () => { clearTimeout(timer); emitMessage(stream, failureMessage(model, "Fixture request cancelled", true)); };
			const timer = setTimeout(() => {
				options?.signal?.removeEventListener("abort", abort);
				try {
					const content = response(model, context);
					emitMessage(stream, { role: "assistant", provider: "fixture", model: model.id, api: model.api, timestamp: Date.now(), content,
						stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop", usage: { ...emptyUsage(), input: 100, output: 10, totalTokens: 110, cost: { ...emptyUsage().cost, input: 0.0001, output: 0.00001, total: 0.00011 } } });
				} catch (error) { emitMessage(stream, failureMessage(model, error)); }
			}, slow ? 10_000 : 200);
			if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true });
			return stream;
		} };
	pi.registerProvider(provider);
	const registry: Registry = { find, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) };
	await createMixtureExtension(pi, registry);
	cleanFooter(pi);
}
