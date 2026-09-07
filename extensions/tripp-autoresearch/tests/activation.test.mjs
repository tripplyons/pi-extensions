import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import autoresearchExtension, {
  shouldAutoActivateAutoresearch,
} from "../index.ts";

const ACTIVATION_ENTRY = "pi-autoresearch.activation";
const AUTORESEARCH_TOOLS = ["init_experiment", "log_experiment", "run_experiment"];

function createHarness({ cwd, branch = [], initialActiveTools = [], nativeCodexAvailable = false }) {
  const commands = new Map();
  const handlers = new Map();
  const eventHandlers = new Map();
  const widgets = [];
  const notifications = [];
  const appendedEntries = [];
  const sentMessages = [];
  let activeTools = [...initialActiveTools];
  let aborted = false;

  autoresearchExtension({
    events: {
      on(name, handler) {
        eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
        return () => eventHandlers.set(name, (eventHandlers.get(name) ?? []).filter((candidate) => candidate !== handler));
      },
      emit(name, data) {
        if (nativeCodexAvailable && name === "tripp:codex-compaction:v1:capability") data.available = true;
        for (const handler of eventHandlers.get(name) ?? []) handler(data);
      },
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    registerTool() {},
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerShortcut() {},
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(nextTools) {
      activeTools = [...nextTools];
    },
    sendUserMessage(content, options) {
      sentMessages.push({ content, options });
    },
  });

  const ctx = {
    cwd,
    model: { provider: "openai-codex", api: "openai-codex-responses" },
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {
      aborted = true;
    },
    sessionManager: {
      getSessionId: () => `test:${cwd}`,
      getBranch: () => branch,
    },
    ui: {
      setWidget(name, widget) {
        widgets.push({ name, widget });
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  return {
    appendedEntries,
    commands,
    handlers,
    ctx,
    notifications,
    sentMessages,
    widgets,
    activeTools: () => activeTools,
    aborted: () => aborted,
  };
}

function activationEntry(workDir, active = true) {
  return {
    type: "custom",
    customType: ACTIVATION_ENTRY,
    data: {
      version: 1,
      workDir,
      active,
    },
  };
}

test("registers the vendored skills directory with Pi", () => {
  const harness = createHarness({ cwd: "/project" });
  const discover = harness.handlers.get("resources_discover");
  assert.ok(discover);

  const result = discover();
  assert.equal(result.skillPaths.length, 1);
  for (const name of ["autoresearch-create", "autoresearch-finalize", "autoresearch-hooks"]) {
    assert.equal(existsSync(join(result.skillPaths[0], name, "SKILL.md")), true);
  }

  const createSkill = readFileSync(join(result.skillPaths[0], "autoresearch-create", "SKILL.md"), "utf-8");
  assert.match(createSkill, /Find the biggest plausible jump/);
  assert.match(createSkill, /Search widely at the start/);
  assert.match(createSkill, /Narrow with the score/);
  assert.match(createSkill, /Keep only new bests/);
  assert.match(createSkill, /Starting a loop and finalizing its results are separate jobs/);
  assert.match(createSkill, /If the user says they will start it manually/);
  assert.match(createSkill, /Do not call `init_experiment`, create `.auto\/log.jsonl`, edit a candidate/);
  assert.match(createSkill, /Never run `autoresearch-finalize`/);
});

function assertJumpClimbPrompt(systemPrompt) {
  assert.match(systemPrompt, /## Jump-climb: make the largest plausible improvement at each scale/);
  assert.match(systemPrompt, /Find the biggest plausible jump/);
  assert.match(systemPrompt, /Rank ideas by plausible relative improvement, not ease of implementation/);
  assert.match(systemPrompt, /Search widely at the start/);
  assert.match(systemPrompt, /Narrow with the score/);
  assert.match(systemPrompt, /Keep only new bests/);
  assert.match(systemPrompt, /run_experiment/);
  assert.match(systemPrompt, /log_experiment/);
  assert.match(systemPrompt, /Starting and finalizing are separate jobs/);
  assert.match(systemPrompt, /Never finalize, split, merge, return to trunk, or clean up/);
  assert.doesNotMatch(systemPrompt, /SPEC\.md|\.\/eval\.sh|\.\/preflight\.sh|VERDICT|attempts\//);
}

function staleLogExperimentEntry() {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "log_experiment",
      details: {
        state: {
          results: [
            {
              commit: "abcdef0",
              metric: 12,
              metrics: {},
              status: "crash",
              description: "stale run from deleted log",
              timestamp: Date.now(),
              segment: 0,
              confidence: null,
            },
          ],
          bestMetric: 12,
          bestDirection: "lower",
          metricName: "quote_field_usec",
          metricUnit: "µs",
          secondaryMetrics: [],
          name: "PickPeriod backend quote field optimization",
          currentSegment: 0,
          maxExperiments: null,
          confidence: null,
        },
      },
    },
  };
}

async function writeRedirectedSession(cwd, workDir, config = {}) {
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await writeFile(
    join(cwd, ".auto", "config.json"),
    JSON.stringify({ workingDir: workDir, ...config }) + "\n",
  );
  await mkdir(join(workDir, ".auto"), { recursive: true });
  await writeFile(
    join(workDir, ".auto", "log.jsonl"),
    [
      JSON.stringify({
        type: "config",
        name: "Redirected research",
        metricName: "runtime_ms",
        metricUnit: "ms",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        commit: "abcdef0",
        metric: 10,
        metrics: {},
        status: "crash",
        description: "baseline",
        timestamp: Date.now(),
      }),
    ].join("\n") + "\n",
  );
}

async function writeSameCwdLog(cwd) {
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await writeFile(
    join(cwd, ".auto", "log.jsonl"),
    [
      JSON.stringify({
        type: "config",
        name: "Same-cwd research",
        metricName: "runtime_ms",
        metricUnit: "ms",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        commit: "abcdef0",
        metric: 10,
        metrics: {},
        status: "crash",
        description: "baseline",
        timestamp: Date.now(),
      }),
    ].join("\n") + "\n",
  );
}

test("setup turns receive the jump-climb strategy in the system prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-setup-prompt-"));

  try {
    const harness = createHarness({ cwd });
    const inactive = await harness.handlers.get("before_agent_start")(
      { systemPrompt: "base prompt" },
      harness.ctx,
    );
    assert.equal(inactive, undefined);

    await harness.commands.get("autoresearch").handler("start optimize runtime", harness.ctx);
    const active = await harness.handlers.get("before_agent_start")(
      { systemPrompt: "base prompt" },
      harness.ctx,
    );

    assert.ok(active.systemPrompt.startsWith("base prompt"));
    assertJumpClimbPrompt(active.systemPrompt);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resumed sessions keep the jump-climb strategy in the system prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-resume-prompt-"));

  try {
    await writeSameCwdLog(cwd);
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);

    const active = await harness.handlers.get("before_agent_start")(
      { systemPrompt: "compacted prompt" },
      harness.ctx,
    );

    assert.ok(active.systemPrompt.startsWith("compacted prompt"));
    assertJumpClimbPrompt(active.systemPrompt);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("same-cwd persisted logs still auto-activate autoresearch", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/repo", true),
    true,
  );
});

test("missing persisted logs never auto-activate autoresearch", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/repo", false),
    false,
  );
});

test("redirected workingDir logs require a pi-session activation", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true),
    false,
  );
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true, true),
    true,
  );
});

test("a recorded manual off keeps same-cwd sessions inactive despite a persisted log", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/repo", true, false),
    false,
  );
});

test("a recorded activation reactivates a redirected off decision on later start", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true, false),
    false,
  );
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true, true),
    true,
  );
});

test("session startup does not show a redirected workingDir dashboard without a session activation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));
  const workDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-workdir-"));

  try {
    await writeRedirectedSession(cwd, workDir);

    const harness = createHarness({
      cwd,
      initialActiveTools: AUTORESEARCH_TOOLS,
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(harness.widgets.at(-1)?.widget, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("session startup activates redirected workingDir dashboards when this pi session activated it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));
  const workDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-workdir-"));

  try {
    await writeRedirectedSession(cwd, workDir);

    const harness = createHarness({
      cwd,
      branch: [activationEntry(workDir)],
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(typeof harness.widgets.at(-1)?.widget, "function");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("session startup keeps redirected workingDir inactive when deactivation is latest", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));
  const workDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-workdir-"));

  try {
    await writeRedirectedSession(cwd, workDir);

    const harness = createHarness({
      cwd,
      branch: [activationEntry(workDir), activationEntry(workDir, false)],
      initialActiveTools: AUTORESEARCH_TOOLS,
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(harness.widgets.at(-1)?.widget, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("starting autoresearch binds redirected workingDir activation to the pi session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));
  const workDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-workdir-"));

  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(
      join(cwd, ".auto", "config.json"),
      JSON.stringify({ workingDir: workDir }) + "\n",
    );

    const harness = createHarness({ cwd });
    await harness.commands.get("autoresearch").handler("start optimize runtime", harness.ctx);

    assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());
    assert.equal(harness.appendedEntries.length, 1);
    assert.equal(harness.appendedEntries[0].customType, ACTIVATION_ENTRY);
    assert.equal(harness.appendedEntries[0].data.active, true);
    assert.equal(harness.appendedEntries[0].data.workDir, await realpath(workDir));
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("session startup keeps same-cwd sessions inactive when a manual off is recorded", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({
      cwd,
      branch: [activationEntry(cwd, false)],
      initialActiveTools: AUTORESEARCH_TOOLS,
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(harness.widgets.at(-1)?.widget, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/autoresearch pause records a manual off decision for same-cwd sessions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd, initialActiveTools: AUTORESEARCH_TOOLS });
    await harness.commands.get("autoresearch").handler("pause", harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.appendedEntries.length, 1);
    assert.equal(harness.appendedEntries[0].customType, ACTIVATION_ENTRY);
    assert.equal(harness.appendedEntries[0].data.active, false);
    assert.equal(harness.appendedEntries[0].data.workDir, await realpath(cwd));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/autoresearch clear leaves mode, deletes the log, and records a manual off decision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd, initialActiveTools: AUTORESEARCH_TOOLS });
    await harness.commands.get("autoresearch").handler("clear", harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(existsSync(join(cwd, ".auto", "log.jsonl")), false);
    assert.equal(harness.appendedEntries.length, 1);
    assert.equal(harness.appendedEntries[0].customType, ACTIVATION_ENTRY);
    assert.equal(harness.appendedEntries[0].data.active, false);
    assert.equal(harness.appendedEntries[0].data.workDir, await realpath(cwd));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bare text no longer starts the loop — shows help instead", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    const harness = createHarness({ cwd });
    await harness.commands.get("autoresearch").handler("optimize runtime", harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.sentMessages.length, 0);
    assert.match(harness.notifications.at(-1).message, /\/autoresearch start <goal>/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/autoresearch resume re-enters mode without a goal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    const harness = createHarness({ cwd });
    await harness.commands.get("autoresearch").handler("resume", harness.ctx);

    assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/autoresearch start without a goal shows usage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    const harness = createHarness({ cwd });
    await harness.commands.get("autoresearch").handler("start", harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.sentMessages.length, 0);
    assert.match(harness.notifications.at(-1).message, /\/autoresearch start <goal>/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("native Codex owns compaction while active autoresearch rehydrates from disk afterward", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-native-compact-"));
  try {
    await writeSameCwdLog(cwd);
    const nativeHarness = createHarness({ cwd, nativeCodexAvailable: true });
    await nativeHarness.handlers.get("session_start")?.({}, nativeHarness.ctx);

    const intercepted = await nativeHarness.handlers.get("session_before_compact")?.({
      preparation: { firstKeptEntryId: "entry-1", tokensBefore: 20_000 },
    }, nativeHarness.ctx);
    assert.equal(intercepted, undefined);

    await nativeHarness.handlers.get("session_compact")?.({
      compactionEntry: { details: { kind: "openai-codex-native-compaction" } },
    }, nativeHarness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 850));

    assert.equal(nativeHarness.sentMessages.length, 1);
    assert.match(nativeHarness.sentMessages[0].content, /Re-read \.auto\/prompt\.md/);
    assert.match(nativeHarness.sentMessages[0].content, /run_experiment \+ log_experiment/);
    assert.doesNotMatch(nativeHarness.sentMessages[0].content, /summary already contains/);
    await nativeHarness.handlers.get("session_shutdown")?.({}, nativeHarness.ctx);

    const fallbackHarness = createHarness({ cwd });
    await fallbackHarness.handlers.get("session_start")?.({}, fallbackHarness.ctx);
    const fallback = await fallbackHarness.handlers.get("session_before_compact")?.({
      preparation: { firstKeptEntryId: "entry-1", tokensBefore: 20_000 },
    }, fallbackHarness.ctx);
    assert.match(fallback.compaction.summary, /# Autoresearch Compaction Summary/);
    await fallbackHarness.handlers.get("session_shutdown")?.({}, fallbackHarness.ctx);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("deleted logs do not leave a stale autoresearch widget from session history", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    const harness = createHarness({
      cwd,
      branch: [staleLogExperimentEntry()],
      initialActiveTools: AUTORESEARCH_TOOLS,
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(harness.widgets.at(-1)?.widget, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
