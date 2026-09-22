import { EventEmitter } from "node:events";
// Lightweight event harness. Runtime loading is checked separately through Pi RPC.
export function harness() {
  const tools = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const commands = new Map<string, any>();
  const hooks = new Map<string, Function[]>();
  const entries: any[] = [];
  const sent: string[] = [];
  const sentMessages: Array<{ message: any; options: any }> = [];
  const ctx: any = {
    cwd: process.cwd(), hasUI: true, hasPendingMessages: () => false,
    sessionManager: { getBranch: () => entries, getSessionId: () => "test-session" },
    ui: { setStatus() {}, notify() {}, input: async () => "answer" },
  };
  const pi: any = {
    registerShortcut: (key: string, shortcut: any) => shortcuts.set(key, shortcut),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, fn: Function) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
    events: new EventEmitter(), getThinkingLevel: () => "high",
    sendMessage: (message: any, options: any) => sentMessages.push({ message, options }),
    sendUserMessage: (message: string) => sent.push(message),
  };
  return { pi, ctx, tools, commands, shortcuts, entries, sent, sentMessages,
    async emit(name: string, event: any = {}) { const results = []; for (const fn of hooks.get(name) ?? []) results.push(await fn(event, ctx)); return results; },
    call(name: string, args: unknown, signal?: AbortSignal) { return tools.get(name).execute("test-call", args, signal, undefined, ctx); },
    command(name: string, args = "") { return commands.get(name).handler(args, ctx); },
  };
}
