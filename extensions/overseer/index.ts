import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export class Glow {
  active = false;
  busy = false;
  attention = false;
  prompt = false;
  private last = "";
  constructor(readonly write: (data: string) => void, readonly yellow = "e5c07b", readonly blue = "61afef") {
    if (![yellow, blue].every(color => /^[a-f\d]{6}$/i.test(color))) throw new Error("Overseer colors must be six-digit hex values");
  }
  show() {
    if (!this.active) return;
    const value = this.prompt ? `${this.blue};hold` : this.busy ? `${this.yellow};hold` : this.attention ? `${this.blue};hold` : "off";
    if (value === this.last) return;
    this.write(`\x1b]777;overseer;glow;${value}\x07`); this.last = value;
  }
  reset() { this.busy = this.attention = this.prompt = false; this.show(); }
}

export default function overseer(pi: ExtensionAPI) {
  if (process.env.OVERSEER !== "1" && !process.env.ZMX_SESSION) return;
  const glow = new Glow(data => { process.stdout.write(data); }, process.env.PI_OVERSEER_YELLOW, process.env.PI_OVERSEER_BLUE);
  let detach: (() => void) | undefined;
  const start = (_event: unknown, ctx: ExtensionContext) => {
    detach?.();
    glow.active = ctx.hasUI && !!process.stdout.isTTY && !!process.stdin.isTTY;
    glow.reset();
    if (glow.active) detach = ctx.ui.onTerminalInput(() => { glow.attention = false; glow.show(); });
  };
  pi.on("session_start", start);
  pi.on("session_switch", start);
  pi.on("agent_start", () => { glow.busy = true; glow.attention = false; glow.show(); });
  pi.on("agent_end", () => { glow.busy = false; glow.attention = true; glow.show(); });
  pi.events.on("rework:prompt", value => { glow.prompt = value === true; glow.show(); });
  pi.on("session_shutdown", () => { detach?.(); glow.reset(); glow.active = false; });
}
