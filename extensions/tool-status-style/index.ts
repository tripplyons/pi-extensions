import {
	createReadToolDefinition,
	ToolExecutionComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { renderEditCall, renderEditResult, renderWriteCall, renderWriteResult } from "./render.ts";
import {
	installGlobalStatusCards,
	installSpecialToolRenderer,
	returnedErrorPatch,
	withStatusCard,
} from "./style.ts";

export default function toolStatusStyleExtension(pi: ExtensionAPI) {
	// Status card on every tool call, whether or not the tool opted in.
	installGlobalStatusCards(ToolExecutionComponent);
	installSpecialToolRenderer("write", renderWriteCall, renderWriteResult);
	installSpecialToolRenderer("edit", renderEditCall, renderEditResult);

	pi.on("session_start", (_event, ctx) => {
		pi.registerTool(withStatusCard(createReadToolDefinition(ctx.cwd)));
	});

	pi.on("tool_result", (event) => {
		return returnedErrorPatch(event.toolName, event.details);
	});
}
