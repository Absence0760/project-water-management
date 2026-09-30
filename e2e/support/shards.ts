// Timing-balanced CI shards (e2e/README.md § CI). Playwright's own --shard
// cuts the suite into equal *counts* of tests in file order, so one shard gets
// the slow a11y and phone-layout tests and takes four times as long as
// another. Instead each CI shard runs `playwright test --test-list <file>`,
// with the lists packed from the per-test durations committed in
// shard-timings.json (refreshed by `pnpm gen:e2e:timings` from a main run).
//
// Pure: no I/O, so shards.test.ts can pin the packing. shard-list.ts and
// shard-timings.ts are the CLIs around it.

/** Playwright's JSON reporter, the parts read here. `--list` has no results. */
export interface JsonReport {
	suites?: JsonSuite[];
}
interface JsonSuite {
	title: string;
	file: string;
	suites?: JsonSuite[];
	specs?: { title: string; file: string; tests: { results?: { duration: number; status: string }[] }[] }[];
}

export interface ListedTest {
	/** Relative to the test dir, as `--test-list` and the reporter write it. */
	file: string;
	/** Describe titles then the test's own title (the file itself not included). */
	titles: string[];
}

/** `--test-list`'s line for a test, also its key in shard-timings.json. */
export const SEP = ' › ';
export function testKey(t: ListedTest): string {
	return [t.file, ...t.titles].join(SEP);
}

/**
 * Titles `--test-list` would misread: it splits a line on "›" and trims each
 * piece, so a title holding "›" or starting or ending in whitespace would
 * name no test, and that test would silently run on no shard.
 */
export function unlistableTitles(tests: ListedTest[]): string[] {
	return tests
		.filter((t) => t.titles.some((x) => x.includes('›') || x !== x.trim() || x === ''))
		.map(testKey);
}

function walk(suite: JsonSuite, titles: string[], visit: (file: string, titles: string[], results: { duration: number; status: string }[]) => void) {
	for (const child of suite.suites ?? []) walk(child, [...titles, child.title], visit);
	for (const spec of suite.specs ?? []) {
		for (const t of spec.tests) visit(spec.file, [...titles, spec.title], t.results ?? []);
	}
}

/** Every test in a report, in report order (one project, so one entry per test). */
export function testsIn(report: JsonReport): ListedTest[] {
	const out: ListedTest[] = [];
	for (const file of report.suites ?? []) walk(file, [], (f, titles) => out.push({ file: f, titles }));
	return out;
}

/**
 * Per-test durations (ms, rounded to 100 so a refresh diffs quietly) from a
 * finished run's merged report (a skipped test has none), and how many
 * shards reported each test, skipped or not: a test on no shard or on two is
 * a planning bug, which the report job checks with ranOnce.
 */
export function timingsFrom(report: JsonReport): { timings: Record<string, number>; runs: Map<string, number> } {
	const timings: Record<string, number> = {};
	const runs = new Map<string, number>();
	for (const file of report.suites ?? []) {
		walk(file, [], (f, titles, results) => {
			const key = testKey({ file: f, titles });
			const ran = results.filter((r) => r.status !== 'skipped');
			runs.set(key, (runs.get(key) ?? 0) + results.length);
			if (ran.length) timings[key] = Math.round(ran.reduce((a, r) => a + r.duration, 0) / ran.length / 100) * 100;
		});
	}
	return { timings: Object.fromEntries(Object.entries(timings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), runs };
}

/** Tests listed that ran on no shard, or on more than one. */
export function ranOnce(listed: ListedTest[], runs: Map<string, number>): { missing: string[]; repeated: string[] } {
	const missing: string[] = [];
	const repeated: string[] = [];
	for (const t of listed) {
		const n = runs.get(testKey(t)) ?? 0;
		if (n === 0) missing.push(testKey(t));
		else if (n > 1) repeated.push(testKey(t));
	}
	return { missing, repeated };
}

/**
 * A file whose tests must stay on one shard: `describe.configure({ mode:
 * 'serial' })` (later tests use earlier ones' state) or `'default'` (one
 * worker, in order), anywhere in it. Playwright's own sharding keeps such a
 * group whole; keeping the whole file is the simple superset of that.
 */
export function keepsTogether(source: string): boolean {
	return /describe\.configure\(\s*\{[^}]*mode:\s*['"](serial|default)['"]/.test(source);
}

export interface Shard {
	tests: ListedTest[];
	/** Planned test time, ms (the sum over its tests; two workers share it). */
	ms: number;
}

/**
 * Packs the tests into `total` shards by planned duration: largest unit first
 * onto the lightest shard (LPT), a unit being one test, or a whole file that
 * keepsTogether. A test with no timing yet (new since the last refresh) is
 * planned at the median, so a stale timings file costs balance, never a
 * test. Deterministic for the same tests and timings, which every shard
 * relies on: each one plans the whole suite and keeps only its own list.
 * Each shard's tests stay in listed order.
 */
export function planShards(tests: ListedTest[], timings: Record<string, number>, total: number, together: (file: string) => boolean): Shard[] {
	if (!Number.isInteger(total) || total < 1) throw new Error(`shard total must be a positive integer, got ${total}`);
	const known = tests.map((t) => timings[testKey(t)]).filter((d): d is number => d !== undefined).sort((a, b) => a - b);
	const fallback = known.length ? known[Math.floor(known.length / 2)]! : 1000;
	const cost = (t: ListedTest) => timings[testKey(t)] ?? fallback;

	const order = new Map(tests.map((t, i) => [testKey(t), i]));
	const units: { key: string; tests: ListedTest[]; ms: number }[] = [];
	const byFile = new Map<string, (typeof units)[number]>();
	for (const t of tests) {
		if (together(t.file)) {
			let u = byFile.get(t.file);
			if (!u) {
				u = { key: t.file, tests: [], ms: 0 };
				byFile.set(t.file, u);
				units.push(u);
			}
			u.tests.push(t);
			u.ms += cost(t);
		} else {
			units.push({ key: testKey(t), tests: [t], ms: cost(t) });
		}
	}
	units.sort((a, b) => b.ms - a.ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

	const shards: Shard[] = Array.from({ length: total }, () => ({ tests: [], ms: 0 }));
	for (const u of units) {
		let best = 0;
		for (let i = 1; i < total; i++) if (shards[i]!.ms < shards[best]!.ms) best = i;
		shards[best]!.tests.push(...u.tests);
		shards[best]!.ms += u.ms;
	}
	for (const s of shards) s.tests.sort((a, b) => order.get(testKey(a))! - order.get(testKey(b))!);
	return shards;
}

/** The `--test-list` file for one shard. */
export function testListFile(shard: Shard): string {
	return shard.tests.map(testKey).join('\n') + '\n';
}
