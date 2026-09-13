export type DeltaPath = Array<string | number>;
export type DeltaOperation =
	| { op: "set"; path: DeltaPath; value: unknown }
	| { op: "delete"; path: DeltaPath }
	| { op: "append"; path: DeltaPath; values: unknown[] }
	| { op: "truncate"; path: DeltaPath; length: number };

const unsafe = new Set(["__proto__", "constructor", "prototype"]);
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>) => Object.keys(value).filter(key => value[key] !== undefined);
const safePath = (path: unknown): path is DeltaPath => Array.isArray(path) && path.length <= 64 && path.every(segment =>
	typeof segment === "number" ? Number.isSafeInteger(segment) && segment >= 0 : typeof segment === "string" && !unsafe.has(segment));
export const cloneJson = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;

function changes(before: unknown, after: unknown, path: DeltaPath, output: DeltaOperation[]) {
	if (before === after) return;
	if (Array.isArray(before) && Array.isArray(after)) {
		const shared = Math.min(before.length, after.length);
		for (let index = 0; index < shared; index++) changes(before[index], after[index], [...path, index], output);
		if (after.length > before.length) output.push({ op: "append", path, values: cloneJson(after.slice(before.length)) });
		else if (after.length < before.length) output.push({ op: "truncate", path, length: after.length });
		return;
	}
	if (plainObject(before) && plainObject(after)) {
		const beforeKeys = new Set(keys(before));
		for (const key of keys(after)) {
			if (beforeKeys.delete(key)) changes(before[key], after[key], [...path, key], output);
			else output.push({ op: "set", path: [...path, key], value: cloneJson(after[key]) });
		}
		for (const key of beforeKeys) output.push({ op: "delete", path: [...path, key] });
		return;
	}
	output.push({ op: "set", path, value: cloneJson(after) });
}

export function createDelta(before: unknown, after: unknown): DeltaOperation[] {
	const output: DeltaOperation[] = [];
	changes(before, after, [], output);
	return output;
}

function target(root: unknown, path: DeltaPath): unknown {
	let value = root;
	for (const segment of path) {
		if (typeof segment === "number") {
			if (!Array.isArray(value) || segment >= value.length) throw new Error("array path does not exist");
			value = value[segment];
		} else {
			if (!plainObject(value) || !Object.hasOwn(value, segment)) throw new Error("object path does not exist");
			value = value[segment];
		}
	}
	return value;
}

function parent(root: unknown, path: DeltaPath): { value: unknown; key: string | number } {
	if (!path.length) throw new Error("root replacement is not supported");
	return { value: target(root, path.slice(0, -1)), key: path.at(-1)! };
}

export function applyDelta<T>(before: T, operations: unknown): T {
	if (!Array.isArray(operations) || operations.length > 100_000) throw new Error("invalid operation list");
	let root: unknown = cloneJson(before);
	for (const candidate of operations) {
		if (!plainObject(candidate) || !safePath(candidate.path) || !["set", "delete", "append", "truncate"].includes(String(candidate.op))) throw new Error("invalid delta operation");
		const operation = candidate as unknown as DeltaOperation;
		if (operation.op === "set") {
			if (!operation.path.length) { root = cloneJson(operation.value); continue; }
			const location = parent(root, operation.path);
			if (typeof location.key === "number") {
				if (!Array.isArray(location.value) || location.key >= location.value.length) throw new Error("array set path does not exist");
				location.value[location.key] = cloneJson(operation.value);
			} else {
				if (!plainObject(location.value)) throw new Error("object set path does not exist");
				location.value[location.key] = cloneJson(operation.value);
			}
		} else if (operation.op === "delete") {
			const location = parent(root, operation.path);
			if (typeof location.key !== "string" || !plainObject(location.value) || !Object.hasOwn(location.value, location.key)) throw new Error("object delete path does not exist");
			delete location.value[location.key];
		} else {
			const array = target(root, operation.path);
			if (!Array.isArray(array)) throw new Error("array operation path does not exist");
			if (operation.op === "append") {
				if (!Array.isArray(operation.values)) throw new Error("invalid append values");
				array.push(...cloneJson(operation.values));
			} else {
				if (!Number.isSafeInteger(operation.length) || operation.length < 0 || operation.length > array.length) throw new Error("invalid truncate length");
				array.length = operation.length;
			}
		}
	}
	return root as T;
}
