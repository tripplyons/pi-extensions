import { expect, test } from "bun:test";
import { closeMixtureCodexSessions } from "./index.ts";

test("Mixture session cleanup closes only validated nested role sessions", () => {
	const closed: string[] = [];
	closeMixtureCodexSessions({ sessionIds: ["root/mixture/run/lead", "root/mixture/run/writer"] }, id => closed.push(id));
	closeMixtureCodexSessions({ sessionIds: ["", 3] }, id => closed.push(id));
	expect(closed).toEqual(["root/mixture/run/lead", "root/mixture/run/writer"]);
});
