import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { scoreLabel, scorePrecision, formatScore } from "../scores.ts";

const template = fs.readFileSync(new URL("../assets/template.html", import.meta.url), "utf8");
const script = template.match(/<script>([\s\S]*)<\/script>/)?.[1];

function createDashboardContext(canvasContext) {
  const elements = new Map();
  const element = () => ({
    addEventListener() {},
    classList: { add() {}, remove() {} },
    setAttribute() {},
    style: {},
    textContent: "",
    clientWidth: 1000,
    clientHeight: 420,
    getContext: () => canvasContext,
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

function dashboardValue(expression, canvasContext) {
  assert.ok(script, "dashboard script should be embedded in the template");
  const context = createDashboardContext(canvasContext);
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

function recordingCanvas() {
  const dots = [];
  const labels = [];
  return {
    dots, labels,
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    bezierCurveTo() {}, stroke() {}, fill() {}, save() {}, restore() {},
    measureText(text) { return { width: text.length * 6 }; },
    arc(x, y, radius) { dots.push({ x, y, radius }); },
    fillText(text, x, y) { labels.push({ text, x, y }); },
  };
}

for (const metrics of [
  [0.12, 0.11928, 0.11688, 0.1146],
  [1e-14, 1.2e-14, 2e-14],
  [1000000, 1000000.000001, 1000000.000002],
  [1, 500, 1000],
  [Number.MIN_VALUE, Number.MIN_VALUE * 2],
  [1, 1 + Number.EPSILON],
]) {
  test(`plot bounds use the raw range for ${metrics}`, () => {
    const result = JSON.parse(dashboardValue(`
      const metrics = ${JSON.stringify(metrics)};
      const bounds = computeMetricRange(metrics.map(metric => ({ metric })));
      const geo = buildChartGeometry(1000, 420, bounds);
      JSON.stringify({ bounds, span: geo.metricRange, ys: metrics.map(value => geo.metricToY(value)) });
    `));
    const min = Math.min(...metrics), max = Math.max(...metrics);
    assert.deepEqual(result.bounds, { min, max });
    assert.equal(result.span, max - min);
    result.ys.forEach((y, index) => {
      const expected = 16 + (1 - (metrics[index] - min) / (max - min)) * 374;
      assert.ok(Math.abs(y - expected) < 1e-8, `${y} should equal ${expected}`);
    });
  });
}

for (const renderer of ["renderChart", "shareDrawChart"]) {
  for (const direction of ["lower", "higher"]) {
    test(`${renderer} draws raw fractional positions and endpoint labels for ${direction}`, () => {
      const canvas = recordingCanvas();
      dashboardValue(`
        session.metricUnit = "ms";
        session.direction = ${JSON.stringify(direction)};
        session.runs = [0.12, 0.11928, 0.11688, 0.1146].map((metric, index) => ({ run: index + 1, metric, status: "keep" }));
        ${renderer === "renderChart" ? "renderChart()" : "shareDrawChart(document.getElementById('chart').getContext('2d'))"};
      `, canvas);
      const ys = [...new Set(canvas.dots.map(dot => dot.y))];
      const top = renderer === "renderChart" ? 16 : 345;
      const height = renderer === "renderChart" ? 374 : 240;
      assert.equal(ys.length, 4);
      [0.12, 0.11928, 0.11688, 0.1146].forEach((metric, index) => {
        const expected = top + (1 - (metric - 0.1146) / (0.12 - 0.1146)) * height;
        assert.ok(Math.abs(ys[index] - expected) < 1e-8);
      });
      const maxLabel = canvas.labels.find(label => label.text === "0.12ms");
      const minLabel = canvas.labels.find(label => label.text === "0.1146ms");
      assert.ok(maxLabel && minLabel);
      assert.ok(Math.abs(maxLabel.y - top) <= 5);
      assert.ok(Math.abs(minLabel.y - (top + height)) <= 5);
    });
  }

  test(`${renderer} centers equal values without inventing bounds`, () => {
    const canvas = recordingCanvas();
    const bounds = JSON.parse(dashboardValue(`
      session.runs = [{ metric: 0.12, status: "keep" }, { metric: 0.12, status: "keep" }];
      ${renderer === "renderChart" ? "renderChart()" : "shareDrawChart(document.getElementById('chart').getContext('2d'))"};
      JSON.stringify(computeMetricRange(session.runs));
    `, canvas));
    assert.deepEqual(bounds, { min: 0.12, max: 0.12 });
    assert.ok(canvas.dots.length >= 2);
    assert.ok(canvas.dots.every(dot => dot.y === (renderer === "renderChart" ? 203 : 465)));
    assert.equal(canvas.labels.filter(label => label.text === "0.12").length, 1);
  });

  test(`${renderer} rescales kept-only data without renumbering runs`, () => {
    const canvas = recordingCanvas();
    dashboardValue(`
      session.runs = [
        { metric: 0.12, status: "keep" },
        { metric: 100, status: "discard" },
        { metric: 0.11, status: "keep" },
      ];
      session.keptOnly = true;
      ${renderer === "renderChart" ? "renderChart()" : "shareDrawChart(document.getElementById('chart').getContext('2d'))"};
    `, canvas);
    const ys = [...new Set(canvas.dots.map(dot => dot.y))];
    assert.deepEqual(ys, renderer === "renderChart" ? [16, 390] : [345, 585]);
    assert.ok(canvas.labels.some(label => label.text === "0.12"));
    assert.ok(canvas.labels.some(label => label.text === "0.11"));
    if (renderer === "renderChart") {
      assert.ok(canvas.labels.some(label => label.text === "#1"));
      assert.ok(canvas.labels.some(label => label.text === "#3"));
      assert.ok(!canvas.labels.some(label => label.text === "#2"));
    }
  });
}

test("single points are centered and kept-only bounds exclude other metrics", () => {
  const result = JSON.parse(dashboardValue(`
    session.runs = [{ metric: 100, status: "discard" }, { metric: 0.12, status: "keep" }];
    session.keptOnly = true;
    const runs = graphRuns();
    const bounds = computeMetricRange(runs);
    const geo = buildChartGeometry(1000, 420, bounds);
    JSON.stringify({ bounds, span: geo.metricRange, points: computeChartPoints(geo, runs) });
  `));
  assert.deepEqual(result.bounds, { min: 0.12, max: 0.12 });
  assert.equal(result.span, 0);
  assert.equal(result.points[0].runIndex, 1);
  assert.equal(result.points[0].x, 982);
  assert.equal(result.points[0].y, 203);
});

test("empty and crash-only charts do not invent a metric range", () => {
  for (const runs of [[], [{ metric: 0, status: "crash" }]]) {
    const canvas = recordingCanvas();
    const result = dashboardValue(`
      session.runs = ${JSON.stringify(runs)};
      renderChart();
      shareDrawChart(document.getElementById('chart').getContext('2d'));
      computeMetricRange(session.runs);
    `, canvas);
    assert.equal(result, null);
    assert.deepEqual(canvas.dots, []);
  }
});

test("close-value axis labels stay distinct and fit the left margin", () => {
  const canvas = recordingCanvas();
  dashboardValue(`
    session.runs = [1, 1 + Number.EPSILON].map(metric => ({ metric, status: "keep" }));
    renderChart();
  `, canvas);
  const labels = canvas.labels.filter(label => !label.text.startsWith('#'));
  assert.ok(labels.length >= 2 && labels.length <= 5);
  assert.equal(new Set(labels.map(label => label.text)).size, labels.length);
  assert.ok(labels.some(label => label.text === "1.0000000000000002"));
  assert.ok(labels.every(label => label.x - canvas.measureText(label.text).width >= 0));
});

for (const [value, expected] of [
  [0.11928, '0.11928'], [0.11688, '0.11688'], [0.00001234, '1.234e-5'],
  [1.999, '1.999'], [1.9999999, '2'], [-123, '-123'], [-1234.5, '-1234.5'],
  [0, '0'], [-0, '0'], [1e-4, '0.0001'], [9.9999999e-5, '0.0001'],
  [1e9, '1e+9'], [999999999, '1e+9'], [Number.MIN_VALUE, '5e-324'],
  [Number.MAX_VALUE, '1.79769e+308'],
]) {
  test(`score labels agree across terminal and browser for ${value}`, () => {
    assert.equal(scoreLabel(value), expected);
    assert.equal(dashboardValue(`scoreLabel(${value})`), expected);
    assert.equal(formatScore(value, 'ms').replaceAll(',', ''), expected + 'ms');
  });
}

test('compared scores remain distinct without mixing missing or equal values', () => {
  for (const values of [[1, 1 + Number.EPSILON], [0.11928001, 0.11928002], [1e-14, 1.00000001e-14], [Number.MAX_VALUE, Number.MAX_VALUE / 2]]) {
    const precision = scorePrecision([...values, null, undefined, values[0]]);
    assert.equal(new Set(values.map(value => scoreLabel(value, precision))).size, values.length);
    const browser = JSON.parse(dashboardValue(`
      const values = ${JSON.stringify(values)};
      const precision = scorePrecision(values);
      JSON.stringify({ precision, labels: values.map(value => scoreLabel(value, precision)) });
    `));
    assert.equal(browser.precision, precision);
    assert.deepEqual(browser.labels, values.map(value => scoreLabel(value, precision)));
  }
  assert.equal(formatScore(-1234.5, 'ms'), '-1,234.5ms');
  assert.equal(formatScore(null, 'ms'), '—');
});

test('loaded scores keep their precision in cards, table values and tooltips after filtering', () => {
  const result = JSON.parse(dashboardValue(`
    applyParsedData({ metricUnit: 'ms', bestDirection: 'lower' }, [
      { metric: 1.0000000000000002, status: 'discard' },
      { metric: 1, status: 'keep' }
    ]);
    renderCards();
    const before = session.runs.map(metricDisplay);
    session.keptOnly = true;
    renderCards();
    JSON.stringify({ before, after: session.runs.map(metricDisplay),
      card: document.getElementById('baseline-best').textContent,
      tooltip: tooltipHeader(session.runs[0], 0) });
  `));
  assert.deepEqual(result.before, ['1.0000000000000002ms', '1ms']);
  assert.deepEqual(result.after, result.before);
  assert.equal(result.card, '1.0000000000000002ms → 1ms');
  assert.ok(result.tooltip.includes('1.0000000000000002ms'));
});

test('export fits long scores and delta without dropping distinguishing digits', () => {
  const canvas = recordingCanvas();
  const scales = [];
  canvas.translate = () => {};
  canvas.scale = (x, y) => scales.push([x, y]);
  canvas.measureText = text => ({ width: text.length * Number(canvas.font.match(/([\d.]+)px/)[1]) * 0.6 });
  const expectedScale = dashboardValue(`
    applyParsedData({ metricUnit: 'ms', bestDirection: 'lower' }, [
      { metric: 1.0000000000000004, status: 'keep' },
      { metric: 1.0000000000000002, status: 'keep' }
    ]);
    const ctx = document.getElementById('chart').getContext('2d');
    const available = SHARE_W - sharePad().left - sharePad().right;
    const factor = available / shareMetricWidth(ctx);
    shareDrawMetric(ctx);
    factor;
  `, canvas);
  assert.ok(expectedScale > 0 && expectedScale < 1);
  assert.deepEqual(scales, [[expectedScale, expectedScale]]);
  assert.ok(canvas.labels.some(label => label.text === '1.0000000000000004ms'));
  assert.ok(canvas.labels.some(label => label.text === '1.0000000000000002ms'));
});
