// The evidence pack's reproduction bundle (roadmap WP-3.14 item 11, issue #71;
// docs/evidence-pack.md § Reproduction): a ZIP an assessor re-runs with only
// the bundle and the repository at the pack's engine version, and gets the
// same results digest. Pure, like the rest of the engine: the SHA-256 is the
// caller's (`BundleHash`: node:crypto on the server and in
// scripts/reproduce-pack, WebCrypto in a browser), the zip is ../zip.
//
// What it holds (every entry but bundle.json is listed in bundle.json with its
// SHA-256; entries sorted by name, fixed timestamps, so the same pack gives
// the same bytes on the same zlib):
//
//   README.md                     how to reproduce it, the command and the engine
//   bundle.json                   the index: pack, engine, each run's results digest, every file's hash
//   manifest.json                 the pack's manifest as its RFC 8785 text: its SHA-256 IS the manifest hash
//   scenario.json                 the application's scenario as its run recorded it (application packs only)
//   runs/<run>/input.json         the run's stored input snapshot (settings, model, each series' dates and hash)
//   runs/<run>/results.json       the run's stored results: summary, and each daily output's hash
//   series/<sha256>.csv           each input series' values (date,value), named by the hash of its values
//
// <run> is `baseline` and, for an application pack, `application`.
//
// What ties it together: manifest.json hashes to the pack's manifest hash
// (which the public verify lookup returns); the manifest names both runs and
// lists every input series' hash, the baseline's settings and model, the
// application's input changes and both runs' summaries, so the inputs and
// stored results are checked against it. The results digest (runResultsText)
// covers the summary and every daily output, so a re-run that matches it
// reproduces the run exactly. checkPackBundle does all of it, and draws § 1's
// locality map again from the manifest (evidence-12) and compares its SHA-256.
import { fromEpochDay, toEpochDay } from '../calendar';
import { diffInputs, type RunInputsSnapshot } from '../compare';
import { canonicalJson, seriesDigest } from '../manifest';
import type { DailySeries, ModelInput } from '../project';
import { runModelChecked } from '../run';
import { ENGINE_VERSION } from '../version';
import { ZipArchive, zip, type ZipEntry } from '../zip';
import { LOCALITY_MAP_VERSION, localityMapSvg } from '../geo/localityMap';
import { packManifestText, packShortCode, type PackManifest } from './pack';

/** Bumped whenever the bundle's layout changes; bundle.json records it. */
export const PACK_BUNDLE_VERSION = 'bundle-1';
/** Bumped whenever runResultsText's shape changes; results.json records it. */
export const RUN_RESULTS_VERSION = 'results-1';

/** SHA-256 hex of a string (as UTF-8) or of bytes. */
export type BundleHash = (data: string | Uint8Array) => string | Promise<string>;

export type BundleRunName = 'baseline' | 'application';

/** A stored daily output of a run (run_series): values with non-finite days as null, as storeRun writes them. */
export interface BundleOutputSeries {
	nodeId: string | null;
	key: string;
	label: string | null;
	values: readonly (number | null)[];
}

/** One run of a pack, as the bundle needs it: its stored snapshot and input values, and its stored results. */
export interface PackBundleRun {
	runId: string;
	engineVersion: string;
	/** model_run.start_date: the first day of every daily output. */
	startDate: string;
	/** model_run.inputs, as stored (a scenario run's carries `scenario`). */
	inputs: RunInputsSnapshot & { scenario?: { opsSha256?: string; ops?: unknown } & Record<string, unknown> };
	/** Each input series' values by kind (loadRunInput, checked against the snapshot's hashes). */
	values: Record<string, readonly (number | null)[]>;
	/** model_run.summary, as stored. */
	summary: unknown;
	series: readonly BundleOutputSeries[];
}

export interface PackBundleInput {
	manifest: PackManifest;
	baseline: PackBundleRun;
	application: PackBundleRun | null;
}

/** A daily output in results.json: which one, and the SHA-256 of seriesDigest(values). */
export interface RunResultsSeries {
	nodeId: string | null;
	key: string;
	label: string | null;
	valuesSha256: string;
}

/** runs/<run>/results.json. */
export interface RunResultsFile {
	version: typeof RUN_RESULTS_VERSION;
	runId: string;
	engineVersion: string;
	startDate: string;
	summary: unknown;
	series: RunResultsSeries[];
}

/** bundle.json. */
export interface PackBundleIndex {
	version: typeof PACK_BUNDLE_VERSION;
	pack: { id: string; version: number; manifestSha256: string; shortCode: string };
	/** The engine that built the manifest (manifest.engine). */
	engine: { version: string; build: string | null };
	runs: Record<BundleRunName, { runId: string; engineVersion: string; resultsSha256: string } | null>;
	/** Every other entry of the zip, by name, with its SHA-256. */
	files: Record<string, string>;
}

/** A run's results as JSON storage keeps them: the summary through JSON (NaN → null, undefined dropped), a non-finite day as null. */
const asStored = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const storedValues = (values: readonly (number | null)[]): (number | null)[] => values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
const byNodeKey = (a: { nodeId: string | null; key: string }, b: { nodeId: string | null; key: string }) => {
	const x = `${a.nodeId ?? ''}\u0000${a.key}`;
	const y = `${b.nodeId ?? ''}\u0000${b.key}`;
	return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * The text whose SHA-256 is a run's **results digest**: RFC 8785 JSON of the
 * results version, the first day, the summary (as JSON storage keeps it) and,
 * sorted by node and key, each daily output's node, key and the SHA-256 of
 * its values' seriesDigest. Labels aren't in it (a rename isn't a different
 * result). Two runs with the same digest have the same summary and the same
 * value on every day of every output.
 */
export function runResultsText(r: { startDate: string; summary: unknown; series: readonly { nodeId: string | null; key: string; valuesSha256: string }[] }): string {
	return canonicalJson({
		version: RUN_RESULTS_VERSION,
		startDate: r.startDate,
		summary: asStored(r.summary),
		series: [...r.series].sort(byNodeKey).map((s) => ({ nodeId: s.nodeId, key: s.key, valuesSha256: s.valuesSha256 }))
	});
}

/** A run's results digest and each output's hash, from its summary and daily outputs (stored, or fresh from runModel). */
export async function runResultsDigest(
	r: { startDate: string; summary: unknown; series: readonly { nodeId: string | null; key: string; label?: string | null; values: readonly (number | null)[] }[] },
	hash: BundleHash
): Promise<{ sha256: string; series: RunResultsSeries[] }> {
	const series: RunResultsSeries[] = [];
	for (const s of [...r.series].sort(byNodeKey)) {
		series.push({ nodeId: s.nodeId, key: s.key, label: s.label ?? null, valuesSha256: await hash(seriesDigest(storedValues(s.values))) });
	}
	return { sha256: await hash(runResultsText({ startDate: r.startDate, summary: r.summary, series })), series };
}

/** An input series as CSV: `date,value`, one row a day from `startDate`, a missing day empty. Numbers as JavaScript writes them, so they read back exactly. */
export function seriesCsv(startDate: string, values: readonly (number | null)[]): string {
	const d0 = toEpochDay(startDate);
	const rows = ['date,value'];
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		rows.push(`${fromEpochDay(d0 + i)},${typeof v === 'number' && Number.isFinite(v) ? String(v) : ''}`);
	}
	return rows.join('\n') + '\n';
}

/** Read seriesCsv's text back: the first day and the values. Throws on anything else (a gap in the dates, a bad number). */
export function parseSeriesCsv(text: string): { startDate: string | null; values: (number | null)[] } {
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	if (lines[0] !== 'date,value') throw new Error('its header is not "date,value"');
	const values: (number | null)[] = [];
	let first: number | null = null;
	for (let i = 1; i < lines.length; i++) {
		const m = /^(\d{4}-\d{2}-\d{2}),(.*)$/.exec(lines[i]!);
		if (!m) throw new Error(`row ${i + 1} is not "date,value"`);
		const day = toEpochDay(m[1]!);
		if (first === null) first = day;
		else if (day !== first + values.length) throw new Error(`row ${i + 1} (${m[1]}) doesn't follow the day before`);
		const cell = m[2]!;
		if (cell === '') values.push(null);
		else {
			const n = Number(cell);
			if (!Number.isFinite(n) || cell.trim() !== cell) throw new Error(`row ${i + 1} holds "${cell}", not a number`);
			values.push(n);
		}
	}
	return { startDate: first === null ? null : fromEpochDay(first), values };
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const RUNS: BundleRunName[] = ['baseline', 'application'];

/** The CSV of an input series is named by its hash, so runs that share a series share its file. */
export const bundleSeriesPath = (valuesSha256: string) => `series/${valuesSha256}.csv`;

function readme(m: PackManifest, index: Omit<PackBundleIndex, 'files'>, zipName: string): string {
	const runs = RUNS.filter((r) => index.runs[r]).map((r) => `- ${r}: run \`${index.runs[r]!.runId}\`, engine ${index.runs[r]!.engineVersion}, results digest \`${index.runs[r]!.resultsSha256}\``);
	const engines = [...new Set(RUNS.flatMap((r) => (index.runs[r] ? [index.runs[r]!.engineVersion] : [])))];
	return [
		`# Reproduction bundle: evidence pack ${index.pack.shortCode}`,
		'',
		`Pack \`${index.pack.id}\`, version ${index.pack.version}, for ${m.project.name}.`,
		`Manifest SHA-256: \`${index.pack.manifestSha256}\` (the SHA-256 of manifest.json).`,
		`Check it and the pack's status with the app's public verify lookup: \`/verify/${index.pack.shortCode}\`.`,
		'',
		'## Runs',
		'',
		...runs,
		'',
		'## Reproduce it',
		'',
		`You need this bundle and the water-management repository at the engine the runs were made with (${engines.join(', ')}).`,
		m.engine.build
			? `Check out the build that made the manifest: \`git checkout ${m.engine.build}\`.`
			: `Check out any commit whose \`packages/engine/src/version.ts\` sets \`ENGINE_VERSION = '${engines[0]}'\` (a change in the engine's behaviour always changes that version), for example the first one: \`git log --reverse --format=%H -S "ENGINE_VERSION = '${engines[0]}'" -- packages/engine/src/version.ts | head -1\`.`,
		'Then, with Node 24 and pnpm 10, from the repository root (give the path to where you saved this bundle):',
		'',
		'```',
		'pnpm install --frozen-lockfile',
		`pnpm reproduce:pack path/to/${zipName}`,
		'```',
		'',
		'It checks that every file matches its hash in bundle.json, that manifest.json hashes to the manifest hash, that the inputs and stored results are the ones the manifest lists, and then re-runs each run from its stored inputs and compares the results digest. It exits non-zero on any mismatch.',
		...(m.report.localityMap
			? ["It also draws § 1's locality map again from the map features in manifest.json and checks the SVG against the SHA-256 the manifest names (`figure:locality`)."]
			: []),
		'Add `--expect <manifest hash>` to also require the hash the verify lookup returned, and `--no-run` to check the files without re-running.',
		'',
		'## Files',
		'',
		'- `bundle.json`: the index (pack, engine, each run\'s results digest, every other file\'s SHA-256).',
		'- `manifest.json`: the pack\'s manifest, as its canonical (RFC 8785) text.',
		...(index.runs.application ? ['- `scenario.json`: the application\'s scenario as its run recorded it (ops, their hash, the base run).'] : []),
		'- `runs/<run>/input.json`: the run\'s stored inputs: settings, model, and each series\' first day, days and SHA-256.',
		'- `runs/<run>/results.json`: the run\'s stored summary and the SHA-256 of each daily output. The results digest is the SHA-256 of its canonical text (engine `runResultsText`).',
		'- `series/<sha256>.csv`: each input series\' values, `date,value`, a missing day empty; named by the SHA-256 of the values\' JSON array.',
		''
	].join('\n');
}

/**
 * Build a pack's reproduction bundle: the zip's bytes and its SHA-256. The
 * caller has checked the runs' inputs (loadRunInput) and read their stored
 * results. Deterministic: the same pack gives the same bytes on the same zlib.
 */
export async function buildPackBundle(input: PackBundleInput, hash: BundleHash): Promise<{ bytes: Uint8Array<ArrayBuffer>; sha256: string; index: PackBundleIndex }> {
	const m = input.manifest;
	const manifestText = packManifestText(m);
	const manifestSha256 = await hash(manifestText);
	const files = new Map<string, Uint8Array<ArrayBuffer>>();
	const put = (name: string, text: string) => files.set(name, enc.encode(text));
	put('manifest.json', manifestText);

	const runs: PackBundleIndex['runs'] = { baseline: null, application: null };
	for (const name of RUNS) {
		const run = input[name];
		if (!run) continue;
		put(`runs/${name}/input.json`, canonicalJson(run.inputs));
		for (const [kind, snap] of Object.entries(run.inputs.series ?? {})) {
			if (!snap) continue;
			const values = run.values[kind];
			if (!values || !snap.valuesSha256) throw new Error(`the ${name} run's ${kind} series has no stored values`);
			if ((await hash(seriesDigest(values))) !== snap.valuesSha256) throw new Error(`the ${name} run's ${kind} series fails its SHA-256 check`);
			put(bundleSeriesPath(snap.valuesSha256), seriesCsv(snap.startDate, values));
		}
		const digest = await runResultsDigest(run, hash);
		const results: RunResultsFile = {
			version: RUN_RESULTS_VERSION,
			runId: run.runId,
			engineVersion: run.engineVersion,
			startDate: run.startDate,
			summary: asStored(run.summary),
			series: digest.series
		};
		put(`runs/${name}/results.json`, canonicalJson(results));
		runs[name] = { runId: run.runId, engineVersion: run.engineVersion, resultsSha256: digest.sha256 };
	}
	if (input.application?.inputs.scenario) put('scenario.json', canonicalJson(input.application.inputs.scenario));

	const head = {
		version: PACK_BUNDLE_VERSION,
		pack: { id: m.pack.id, version: m.pack.version, manifestSha256, shortCode: packShortCode(manifestSha256) },
		engine: { version: m.engine.version, build: m.engine.build },
		runs
	} as const;
	put('README.md', readme(m, head, `pack-${head.pack.shortCode}.zip`));
	const names = [...files.keys()].sort();
	const index: PackBundleIndex = { ...head, files: {} };
	for (const n of names) index.files[n] = await hash(files.get(n)!);
	files.set('bundle.json', enc.encode(canonicalJson(index)));
	const entries: ZipEntry[] = [...files.keys()].sort().map((name) => ({ name, data: files.get(name)! }));
	const bytes = await zip(entries);
	return { bytes, sha256: await hash(bytes), index };
}

// ---------------------------------------------------------------------------
// Checking a bundle (scripts/reproduce-pack, and the server at issue)
// ---------------------------------------------------------------------------

export interface BundleCheck {
	/** `archive`, `files`, `manifest`, `runs`, `inputs:<run>`, `changes`, `scenario`, `results:<run>`, `reproduce:<run>`. */
	id: string;
	ok: boolean;
	detail: string;
}

export interface BundleCheckResult {
	/** Every check passed (and, with `rerun`, both runs reproduced). */
	ok: boolean;
	checks: BundleCheck[];
	/** The pack, when bundle.json could be read. */
	pack: PackBundleIndex['pack'] | null;
	/** The engine this code is, and the runs' engines: a re-run on another engine version is expected to differ. */
	engine: { here: string; runs: string[] };
}

export interface CheckPackBundleOptions {
	hash: BundleHash;
	/** Re-run each run with this engine and compare its results digest (default true). */
	rerun?: boolean;
	/** The manifest hash the bundle must carry (from the verify lookup, or the pack row). */
	expectManifestSha256?: string;
	/** Largest bundle read, unpacked (default BUNDLE_ZIP_LIMITS.maxTotalBytes). */
	maxTotalBytes?: number;
}

/**
 * What checkPackBundle reads of a bundle: sized to real bundles, so a hostile
 * one is refused before much is read (ZipArchive.read allocates an entry's
 * declared size before inflating it). A bundle has about a dozen fixed files
 * and one CSV per distinct input series (a few dozen); the largest entries are
 * the manifest (the whole evidence report) and a century of daily values as
 * CSV (~1.5 MB).
 */
export const BUNDLE_ZIP_LIMITS = { maxEntries: 2_000, maxEntryBytes: 128 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 } as const;

/** At most `n` names, then how many more, for a message. */
const someNames = (names: readonly string[], n = 10) => `${names.slice(0, n).join(', ')}${names.length > n ? ` and ${names.length - n} more` : ''}`;

/** Paths where two JSON values differ (at most `max`), for a mismatch message. */
function differingPaths(a: unknown, b: unknown, max = 8, path = '', out: string[] = []): string[] {
	if (out.length >= max) return out;
	const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
	if (obj(a) && obj(b)) {
		for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) differingPaths(a[k], b[k], max, path ? `${path}.${k}` : k, out);
		return out;
	}
	if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
		a.forEach((x, i) => differingPaths(x, b[i], max, `${path}[${i}]`, out));
		return out;
	}
	if (canonicalJson(asStored(a)) !== canonicalJson(asStored(b))) out.push(path || '(the whole value)');
	return out;
}

const sameJson = (a: unknown, b: unknown) => canonicalJson(asStored(a)) === canonicalJson(asStored(b));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Check a reproduction bundle: every file against bundle.json, the manifest
 * against its hash, the inputs and stored results against the manifest, and
 * (unless `rerun: false`) re-run each run from its inputs with this engine and
 * compare the results digest. Never throws for a bad bundle: each problem is a
 * failing check.
 */
export async function checkPackBundle(bytes: Uint8Array<ArrayBuffer>, opts: CheckPackBundleOptions): Promise<BundleCheckResult> {
	const { hash } = opts;
	const checks: BundleCheck[] = [];
	const add = (id: string, ok: boolean, detail: string) => (checks.push({ id, ok, detail }), ok);
	const result = (pack: BundleCheckResult['pack'], runs: string[]): BundleCheckResult => ({
		ok: checks.length > 0 && checks.every((c) => c.ok),
		checks,
		pack,
		engine: { here: ENGINE_VERSION, runs }
	});

	// The archive and its index.
	const text = new Map<string, string>();
	let index: PackBundleIndex;
	try {
		const archive = await ZipArchive.open(bytes, { ...BUNDLE_ZIP_LIMITS, ...(opts.maxTotalBytes !== undefined ? { maxTotalBytes: opts.maxTotalBytes } : {}) });
		// Sets, built once: `names` makes a new array on each read, and a lookup per entry must not be a scan.
		const inArchive = new Set(archive.names);
		if (!inArchive.has('bundle.json')) throw new Error('it has no bundle.json');
		index = JSON.parse(dec.decode(await archive.read('bundle.json'))) as PackBundleIndex;
		if (index.version !== PACK_BUNDLE_VERSION) throw new Error(`its bundle.json is version ${String(index.version)}; this code reads ${PACK_BUNDLE_VERSION}`);
		const listed = Object.keys(index.files ?? {});
		if (listed.length > BUNDLE_ZIP_LIMITS.maxEntries) throw new Error(`its bundle.json lists ${listed.length} files, more than a bundle holds (${BUNDLE_ZIP_LIMITS.maxEntries})`);
		const inIndex = new Set(listed);
		const unlisted = [...inArchive].filter((n) => n !== 'bundle.json' && !inIndex.has(n));
		const missing = listed.filter((n) => !inArchive.has(n));
		if (unlisted.length || missing.length)
			throw new Error(
				[unlisted.length ? `entries bundle.json doesn't list: ${someNames(unlisted)}` : '', missing.length ? `listed entries missing: ${someNames(missing)}` : ''].filter(Boolean).join('; ')
			);
		for (const need of ['manifest.json', 'README.md', 'runs/baseline/input.json', 'runs/baseline/results.json']) if (!inIndex.has(need)) throw new Error(`it has no ${need}`);
		add('archive', true, `${inArchive.size} entries, all listed in bundle.json`);
		const bad: string[] = [];
		for (const name of listed) {
			const data = await archive.read(name);
			if ((await hash(data)) !== index.files[name]) bad.push(name);
			else if (name.endsWith('.json') || name.endsWith('.csv') || name.endsWith('.md')) text.set(name, dec.decode(data));
		}
		if (!add('files', bad.length === 0, bad.length ? `these don't match their SHA-256 in bundle.json: ${someNames(bad)}` : `each of the ${listed.length} files matches its SHA-256`)) return result(index.pack ?? null, []);
	} catch (e) {
		add('archive', false, `the bundle can't be read: ${message(e)}`);
		return result(null, []);
	}

	const json = <T>(name: string): T => JSON.parse(text.get(name)!) as T;
	const runEngines = RUNS.flatMap((r) => (index.runs?.[r] ? [index.runs[r]!.engineVersion] : []));

	// The manifest: its hash is the pack's.
	let manifest: PackManifest;
	{
		const mText = text.get('manifest.json')!;
		const sha = await hash(mText);
		manifest = JSON.parse(mText) as PackManifest;
		const problems: string[] = [];
		if (sha !== index.pack.manifestSha256) problems.push(`manifest.json hashes to ${sha}, not the ${index.pack.manifestSha256} bundle.json names`);
		if (opts.expectManifestSha256 && sha !== opts.expectManifestSha256.toLowerCase()) problems.push(`manifest.json hashes to ${sha}, not the expected ${opts.expectManifestSha256}`);
		if (packManifestText(manifest) !== mText) problems.push('manifest.json is not in its canonical (RFC 8785) form');
		if (manifest.pack?.id !== index.pack.id || manifest.pack?.version !== index.pack.version) problems.push('manifest.json names another pack or version than bundle.json');
		if (!add('manifest', problems.length === 0, problems.join('; ') || `manifest.json hashes to the pack's manifest hash ${sha}`)) return result(index.pack, runEngines);
	}

	// § 1's locality map (evidence-12): drawn again from the manifest's features, the SVG hashes to the one it names.
	const loc = manifest.report.localityMap;
	if (loc) {
		const builtBy = manifest.report.builtBy;
		try {
			if (loc.version !== LOCALITY_MAP_VERSION) add('figure:locality', false, `the locality map was drawn with ${String(loc.version)}; this code draws ${LOCALITY_MAP_VERSION}: check out the engine that built the report (${builtBy})`);
			else {
				const sha = await hash(localityMapSvg(loc).svg);
				add(
					'figure:locality',
					sha === loc.svgSha256,
					sha === loc.svgSha256
						? `the locality map drawn again from the manifest's ${loc.features.length} map features hashes to ${sha}, the SHA-256 the manifest names`
						: `the locality map drawn again hashes to ${sha}, not the ${String(loc.svgSha256)} the manifest names (the report was built by engine ${builtBy}; this is ${ENGINE_VERSION})`
				);
			}
		} catch (e) {
			add('figure:locality', false, `the locality map can't be drawn from the manifest: ${message(e)}`);
		}
	}

	// The runs are the manifest's.
	const identity = manifest.report.identity;
	{
		const problems: string[] = [];
		if (index.runs.baseline?.runId !== identity.baseline.runId) problems.push(`the baseline run is ${String(index.runs.baseline?.runId)}, the manifest names ${identity.baseline.runId}`);
		if ((index.runs.application?.runId ?? null) !== (identity.application?.runId ?? null))
			problems.push(`the application run is ${String(index.runs.application?.runId ?? null)}, the manifest names ${String(identity.application?.runId ?? null)}`);
		if (index.runs.baseline && index.runs.baseline.engineVersion !== identity.baseline.engineVersion) problems.push('the baseline run\'s engine is not the one the manifest names');
		if (index.runs.application && index.runs.application.engineVersion !== identity.application?.engineVersion) problems.push('the application run\'s engine is not the one the manifest names');
		for (const r of RUNS) if (index.runs[r] && !(text.has(`runs/${r}/input.json`) && text.has(`runs/${r}/results.json`))) problems.push(`the ${r} run's input.json or results.json is missing`);
		if (!add('runs', problems.length === 0, problems.join('; ') || `the ${index.runs.application ? 'baseline and application runs are' : 'baseline run is'} the manifest's`)) return result(index.pack, runEngines);
	}

	// Inputs: each series file against its hash and the manifest's list; the baseline's settings and model against the manifest.
	const inputs: Partial<Record<BundleRunName, { snapshot: PackBundleRun['inputs']; input: ModelInput | null; values: Record<string, (number | null)[]> }>> = {};
	for (const r of RUNS) {
		if (!index.runs[r]) continue;
		const snapshot = json<PackBundleRun['inputs']>(`runs/${r}/input.json`);
		const problems: string[] = [];
		const series: Record<string, DailySeries> = {};
		const values: Record<string, (number | null)[]> = {};
		const listed = manifest.report.appendix.series.filter((s) => s.run === r);
		const mine = Object.entries(snapshot.series ?? {}).filter(([, v]) => !!v);
		if (listed.length !== mine.length) problems.push(`it has ${mine.length} input series; the manifest lists ${listed.length}`);
		for (const [kind, snap] of mine) {
			const s = snap!;
			const want = listed.find((x) => x.kind === kind);
			if (!want || want.startDate !== s.startDate || want.days !== s.length || want.sha256 !== (s.valuesSha256 ?? null)) {
				problems.push(`${kind} isn't the series the manifest lists`);
				continue;
			}
			const file = s.valuesSha256 ? bundleSeriesPath(s.valuesSha256) : null;
			const csv = file ? text.get(file) : undefined;
			if (!file || csv === undefined) {
				problems.push(`${kind}: no ${file ?? 'values file'}`);
				continue;
			}
			try {
				const parsed = parseSeriesCsv(csv);
				if (parsed.values.length !== s.length || (s.length > 0 && parsed.startDate !== s.startDate)) throw new Error(`it has ${parsed.values.length} days from ${parsed.startDate}, not ${s.length} from ${s.startDate}`);
				if ((await hash(seriesDigest(parsed.values))) !== s.valuesSha256) throw new Error('its values fail their SHA-256 check');
				values[kind] = parsed.values;
				series[kind] = {
					startDate: s.startDate,
					values: parsed.values,
					...(s.provenance !== undefined ? { provenance: s.provenance } : {}),
					...(s.origin !== undefined ? { origin: s.origin } : {})
				};
			} catch (e) {
				problems.push(`${kind} (${file}): ${message(e)}`);
			}
		}
		if (r === 'baseline') {
			const want = manifest.report.appendix.baselineInputs;
			if (!sameJson(snapshot.settings, want.settings)) problems.push(`its settings aren't the manifest's (${differingPaths(snapshot.settings, want.settings).join(', ')})`);
			if (!sameJson(snapshot.model, want.model)) problems.push(`its model isn't the manifest's (${differingPaths(snapshot.model, want.model).join(', ')})`);
		}
		const ok = add(`inputs:${r}`, problems.length === 0, problems.join('; ') || `${mine.length === 1 ? '1 input series matches its hash' : `${mine.length} input series match their hashes`} and the manifest${r === 'baseline' ? ', and so do the settings and model' : ''}`);
		inputs[r] = { snapshot, values, input: ok ? ({ settings: snapshot.settings, model: snapshot.model, series } as ModelInput) : null };
	}

	// The application: its inputs are the baseline's with the changes the manifest lists, from the scenario it names.
	if (index.runs.application && inputs.baseline && inputs.application) {
		try {
			const changes = diffInputs(inputs.baseline.snapshot, inputs.application.snapshot, { a: inputs.baseline.values, b: inputs.application.values });
			add(
				'changes',
				sameJson(changes, manifest.report.appendix.changes),
				sameJson(changes, manifest.report.appendix.changes)
					? `the application's inputs differ from the baseline's by the ${changes.length} change${changes.length === 1 ? '' : 's'} the manifest lists`
					: `the application's inputs don't differ from the baseline's as the manifest lists (${changes.length} changes here, ${manifest.report.appendix.changes.length} in the manifest)`
			);
		} catch (e) {
			add('changes', false, `the input changes can't be computed: ${message(e)}`);
		}
		const recorded = inputs.application.snapshot.scenario;
		const file = text.get('scenario.json');
		const problems: string[] = [];
		if (!recorded || file === undefined) problems.push('the application run records no scenario, or scenario.json is missing');
		else {
			if (!sameJson(JSON.parse(file), recorded)) problems.push("scenario.json isn't the scenario the application run recorded");
			const opsSha = await hash(canonicalJson(recorded.ops ?? []));
			if (opsSha !== recorded.opsSha256) problems.push(`its ops hash to ${opsSha}, not the ${String(recorded.opsSha256)} recorded`);
			if (recorded.opsSha256 !== identity.application?.opsSha256) problems.push("its ops hash isn't the one the manifest names");
		}
		add('scenario', problems.length === 0, problems.join('; ') || "the scenario's ops hash to the hash the manifest names");
	} else if (text.has('scenario.json')) add('scenario', false, 'a baseline pack carries a scenario.json');

	// Stored results: the summary is the manifest's, and the digest is the one bundle.json names.
	const results: Partial<Record<BundleRunName, RunResultsFile>> = {};
	for (const r of RUNS) {
		const named = index.runs[r];
		if (!named) continue;
		const file = json<RunResultsFile>(`runs/${r}/results.json`);
		const problems: string[] = [];
		const want = manifest.report.summaries[r];
		if (file.version !== RUN_RESULTS_VERSION) problems.push(`results.json is version ${String(file.version)}; this code reads ${RUN_RESULTS_VERSION}`);
		if (file.runId !== named.runId) problems.push('results.json names another run');
		if (!sameJson(file.summary, want)) problems.push(`its summary isn't the one the manifest carries (${differingPaths(file.summary, want).join(', ')})`);
		const sha = await hash(runResultsText(file));
		if (sha !== named.resultsSha256) problems.push(`its results digest is ${sha}, not the ${named.resultsSha256} bundle.json names`);
		if (add(`results:${r}`, problems.length === 0, problems.join('; ') || `the stored summary is the manifest's; results digest ${sha}`)) results[r] = file;
	}

	// Re-run each run from its inputs, and compare.
	if (opts.rerun !== false) {
		for (const r of RUNS) {
			const named = index.runs[r];
			if (!named) continue;
			const input = inputs[r]?.input;
			const stored = results[r];
			if (!input || !stored) {
				add(`reproduce:${r}`, false, 'not re-run: its inputs or stored results failed a check above');
				continue;
			}
			let fresh;
			try {
				fresh = runModelChecked(structuredClone(input));
			} catch (e) {
				add(`reproduce:${r}`, false, `this engine (${ENGINE_VERSION}) refuses the run's input: ${message(e)}`);
				continue;
			}
			const again = await runResultsDigest({ startDate: fresh.startDate, summary: fresh.summary, series: fresh.series }, hash);
			if (again.sha256 === named.resultsSha256) {
				add(`reproduce:${r}`, true, `re-run with engine ${ENGINE_VERSION}: results digest ${again.sha256}, the same`);
				continue;
			}
			const why: string[] = [];
			if (fresh.startDate !== stored.startDate) why.push(`it starts on ${fresh.startDate}, not ${stored.startDate}`);
			const paths = differingPaths(stored.summary, fresh.summary);
			if (paths.length) why.push(`summary differs at ${paths.join(', ')}`);
			// An output by its key, and its node when it has one ("simulated_outflow", "dam_volume at node n1").
			const name = (s: { nodeId: string | null; key: string }) => (s.nodeId === null ? s.key : `${s.key} at node ${s.nodeId}`);
			const was = new Map(stored.series.map((s) => [name(s), s.valuesSha256]));
			const now = new Map(again.series.map((s) => [name(s), s.valuesSha256]));
			const changed = [...was.keys()].filter((k) => now.has(k) && now.get(k) !== was.get(k));
			const gone = [...was.keys()].filter((k) => !now.has(k));
			const added = [...now.keys()].filter((k) => !was.has(k));
			const some = (names: string[]) => `${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`;
			if (changed.length) why.push(`${changed.length === 1 ? '1 daily output differs' : `${changed.length} daily outputs differ`} (${some(changed)})`);
			if (gone.length) why.push(`${gone.length === 1 ? '1 stored output is' : `${gone.length} stored outputs are`} not produced (${some(gone)})`);
			if (added.length) why.push(`${added.length === 1 ? '1 output is' : `${added.length} outputs are`} not stored (${some(added)})`);
			const engineNote = named.engineVersion !== ENGINE_VERSION ? ` The run was made with engine ${named.engineVersion}; this is ${ENGINE_VERSION}: check out that engine (README.md).` : '';
			add(`reproduce:${r}`, false, `re-run with engine ${ENGINE_VERSION}: results digest ${again.sha256}, not ${named.resultsSha256}: ${why.join('; ') || 'the digests differ'}.${engineNote}`);
		}
	}
	return result(index.pack, runEngines);
}
