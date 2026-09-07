import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const template = fs.readFileSync(new URL("../assets/template.html", import.meta.url), "utf8");
const script = template.match(/<script>([\s\S]*)<\/script>/)?.[1];

function createDashboardContext() {
  const elements = new Map();
  const element = () => ({
    addEventListener() {},
    classList: { add() {}, remove() {} },
    setAttribute() {},
    style: {},
    textContent: "",
  });

  return vm.createContext({
    console,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
    },
    location: { protocol: "file:" },
    window: {
      addEventListener() {},
    },
  });
}

function newBestIndices(direction, metrics) {
  assert.ok(script, "dashboard script should be embedded in the template");
  const context = createDashboardContext();
  vm.runInContext(script, context);

  const runs = JSON.stringify(metrics.map(metric => ({ metric })));
  const expression = `
    session.direction = ${JSON.stringify(direction)};
    JSON.stringify(Array.from(newBestRunIndices(${runs})));
  `;
  return JSON.parse(vm.runInContext(expression, context));
}

function dashboardValue(expression) {
  assert.ok(script, "dashboard script should be embedded in the template");
  const context = createDashboardContext();
  vm.runInContext(script, context);
  return vm.runInContext(expression, context);
}

test("chart line selects only strict lower-is-better records", () => {
  assert.deepEqual(newBestIndices("lower", [10, 12, 8, 8, 0, 7]), [0, 2, 5]);
});

test("chart line selects only strict higher-is-better records", () => {
  assert.deepEqual(newBestIndices("higher", [10, 9, 11, 11, 0, 15]), [0, 2, 5]);
});

test("kept-only graph mode filters chart runs and preserves source indices", () => {
  const result = dashboardValue(`
    session.runs = [
      { run: 1, metric: 10, status: "keep" },
      { run: 2, metric: 9, status: "discard" },
      { run: 3, metric: 8, status: "keep" },
      { run: 4, metric: 7, status: "discard" },
      { run: 5, metric: 6, status: "discard" },
      { run: 6, metric: 5, status: "keep" },
    ];
    session.keptOnly = true;
    const runs = graphRuns();
    const geo = buildChartGeometry(1000, 420, computeMetricRange(runs));
    const points = computeChartPoints(geo, runs);
    JSON.stringify({
      graphRuns: runs.map(run => run.run),
      chartRunIndices: points.map(point => point.runIndex),
      chartX: points.map(point => Number(point.x.toFixed(1))),
    });
  `);

  assert.deepEqual(JSON.parse(result), {
    graphRuns: [1, 3, 6],
    chartRunIndices: [0, 2, 5],
    chartX: [56, 426.4, 982],
  });
});

test("web and exported charts use taller plots", () => {
  const webHeight = Number(template.match(/\.chart-wrap \{ height: (\d+)px/)?.[1]);
  const exportHeight = dashboardValue(
    "SHARE_H - shareSettings.chartBottomOffset - shareSettings.chartTop",
  );

  assert.equal(webHeight, 420);
  assert.equal(exportHeight, 240);
});

test("dashboard labels are concise and human readable", () => {
  const labels = JSON.parse(dashboardValue(`
    session.direction = "lower";
    session.runs = [{ status: "keep" }, { status: "checks_failed" }];
    JSON.stringify({
      direction: directionLabel(),
      kept: statusLabel("keep"),
      checksFailed: statusLabel("checks_failed"),
      summary: shareSummaryText(),
    });
  `));

  assert.deepEqual(labels, {
    direction: "Lower is better",
    kept: "kept",
    checksFailed: "checks failed",
    summary: "2 runs · 1 kept · Lower is better",
  });
});

test("dashboard uses flat colors without gradients", () => {
  assert.doesNotMatch(template, /gradient/i);
});
