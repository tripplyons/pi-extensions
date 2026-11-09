import { expect, spyOn } from "bun:test";

// Keep real polling and filesystem I/O; shorten only the swarm's one-second timer.
export async function withFastPolling(check: () => Promise<void>) {
  const setInterval = globalThis.setInterval;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: any, ms: number, ...args: any[]) =>
    setInterval(callback, ms === 1000 ? 10 : ms, ...args)) as typeof setInterval);
  try { await check(); }
  finally { interval.mockRestore(); }
}

export async function waitForPolls(count: () => number) {
  // The second pass cannot start until the first pass has finished its async work.
  const target = count() + 2;
  const deadline = performance.now() + 3000;
  while (count() < target && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(count()).toBeGreaterThanOrEqual(target);
}

// Report Pi's delivery of the newest queued message; the next swarm message waits for it.
export const deliver = (h: { sentMessages: Array<{ message: any }>; emit(name: string, event: any): Promise<unknown> }) =>
  h.emit("message_end", { message: { role: "custom", ...h.sentMessages.at(-1)!.message } });
