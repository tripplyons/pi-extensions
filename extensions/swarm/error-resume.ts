// Pi retries transient provider errors first. These waits apply after Pi gives up.
// Tests shorten them in place.
export const resumeDelays = [30_000, 120_000, 300_000];
// Allow a scheduled resume this long to start before health reports the worker as errored.
export const resumeGrace = 60_000;

export function resumePrompt(error: string, attempt: number) {
  return `Swarm automatic resume ${attempt} of ${resumeDelays.length}: your last turn ended with a model error after Pi's retries ("${error.slice(0, 500)}"). Continue your current assignment from where you stopped. Read swarm_task and check your files and owned jobs first. Do not rerun tool calls or jobs that already finished.`;
}
