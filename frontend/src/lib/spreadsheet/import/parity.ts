// Test support: compare the TypeScript importer's output with the Python
// importer's (the parity tests). Not imported by app code.

/**
 * The first difference between two JSON values as a path and a reason, or
 * null when they are identical: same keys in the same order, numbers equal by
 * Object.is (so bit-identical; Python's 0 and 0.0 both parse to 0).
 */
export function jsonDiff(actual: unknown, expected: unknown, path = '$'): string | null {
	if (typeof expected === 'number' || typeof actual === 'number') {
		return Object.is(actual, expected) ? null : `${path}: ${String(actual)} !== ${String(expected)}`;
	}
	if (expected === null || typeof expected !== 'object' || actual === null || typeof actual !== 'object') {
		return actual === expected ? null : `${path}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`;
	}
	if (Array.isArray(expected) !== Array.isArray(actual)) return `${path}: array vs object`;
	if (Array.isArray(expected)) {
		const a = actual as unknown[];
		if (a.length !== expected.length) return `${path}: length ${a.length} !== ${expected.length}`;
		for (let i = 0; i < a.length; i++) {
			const d = jsonDiff(a[i], expected[i], `${path}[${i}]`);
			if (d) return d;
		}
		return null;
	}
	const ak = Object.keys(actual as object);
	const ek = Object.keys(expected as object);
	if (ak.join('\u0000') !== ek.join('\u0000')) return `${path}: keys [${ak.join(', ')}] !== [${ek.join(', ')}]`;
	for (const k of ek) {
		const d = jsonDiff((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${path}.${k}`);
		if (d) return d;
	}
	return null;
}

/**
 * The Python importer's note lines that belong in the TypeScript notes: all
 * of them except "no Element sheet for …", which is about expected.json (the
 * regression fixture the TypeScript importer doesn't build, D17).
 */
export function projectNotes(lines: string[]): string[] {
	return lines.filter((l) => l && !/^no Element sheet for .*; not in expected\.json$/.test(l));
}
