import { AgentSession } from "@earendil-works/pi-coding-agent";

let users = 0;
let restore: (() => void) | undefined;

// Pi 1.0.1 marks a run active only after prompt preflight, which can compact.
// Reserve that gap so compaction-queue flushes and notifications cannot start
// a second run. Release at agent_start so Pi can queue input during the run.
export function installPromptAdmission(): () => void {
  if (users++ === 0) {
    const prompt = AgentSession.prototype.prompt;
    const sendCustomMessage = AgentSession.prototype.sendCustomMessage;
    const pending = new WeakMap<AgentSession, Promise<void>>();
    async function admit<T>(session: AgentSession, action: () => Promise<T>): Promise<T> {
      while (pending.has(session)) await pending.get(session);
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      pending.set(session, ready);
      const finish = () => {
        if (pending.get(session) === ready) pending.delete(session);
        release();
      };
      const unsubscribe = session.subscribe(event => { if (event.type === "agent_start") finish(); });
      try { return await action(); }
      finally { unsubscribe(); finish(); }
    }
    const guardedPrompt: typeof prompt = function (text, options) {
      // Commands can themselves submit prompts, so they must not hold admission.
      const command = options?.expandPromptTemplates !== false && text.startsWith("/") &&
        this.extensionRunner.getCommand(text.slice(1).split(" ")[0]);
      if (command) return prompt.call(this, text, options);
      return admit(this, () => prompt.call(this, text, options));
    };
    const guardedCustomMessage: typeof sendCustomMessage = function (message, options) {
      if (!options?.triggerTurn || options.deliverAs === "nextTurn") return sendCustomMessage.call(this, message, options);
      return admit(this, () => sendCustomMessage.call(this, message, options));
    };
    AgentSession.prototype.prompt = guardedPrompt;
    AgentSession.prototype.sendCustomMessage = guardedCustomMessage;
    restore = () => {
      if (AgentSession.prototype.prompt === guardedPrompt) AgentSession.prototype.prompt = prompt;
      if (AgentSession.prototype.sendCustomMessage === guardedCustomMessage) AgentSession.prototype.sendCustomMessage = sendCustomMessage;
    };
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (--users === 0) { restore?.(); restore = undefined; }
  };
}
