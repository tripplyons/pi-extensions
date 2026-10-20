import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadCouncils, registerCouncils } from "./index.ts";

/** The original two councils, loaded through the same parser as councils.json. */
export const fixtureCouncils = loadCouncils(join(import.meta.dir, "fixtures.json"));

export default function fixtureCouncil(pi: ExtensionAPI) {
	registerCouncils(pi, fixtureCouncils);
}
