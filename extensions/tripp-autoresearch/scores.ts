export function scoreLabel(value: number, precision = 6): string {
  const rounded = Number(value.toPrecision(precision));
  if (!Number.isFinite(rounded) && Number.isFinite(value)) return value.toExponential(precision - 1);
  if (rounded === 0) return "0";
  const magnitude = Math.abs(rounded);
  if (magnitude < 1e-4 || magnitude >= 1e9) return rounded.toExponential();
  return String(rounded);
}

export function scorePrecision(values: Array<number | null | undefined>): number {
  const distinct = [...new Set(values.filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value)))];
  for (let precision = 6; precision < 17; precision++) {
    if (new Set(distinct.map(value => scoreLabel(value, precision))).size === distinct.length) return precision;
  }
  return 17;
}

export function formatScore(value: number | null, unit: string, precision = 6): string {
  if (value === null) return "—";
  const label = scoreLabel(value, precision);
  if (label.includes("e")) return label + unit;
  const [integer, fraction] = label.split(".");
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction === undefined ? "" : "." + fraction) + unit;
}
