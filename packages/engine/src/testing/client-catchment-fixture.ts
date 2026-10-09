// Shared fixture loader for the client-catchment workbook regression suite
// (`../run.test.ts`) and its performance counterpart (`../run.perf.test.ts`).
// Both must build the exact same replay `ModelInput` — if the replay logic
// drifts between them, the perf test would end up timing something other
// than what the regression suite checks — so the loading and replay-setup
// code lives here once.
//
// Not part of the published `@water-management/engine/testing` subpath
// (package.json `exports` only lists `./testing/index.ts`): this file reaches
// `node:fs`, which the rest of that surface deliberately avoids since
// `checkAll` et al. also run in the browser via the frontend's autocal worker.
import type { ModelInput } from '../project';
import { toEpochDay } from '../calendar';

export interface Expected {
	startDate: string;
	days: number;
	catchment: Record<string, (number | null)[]>;
	nodes: Record<string, { kind: string } & Record<string, (number | null)[]>>;
	shortfalls: {
		periodStart: string;
		periodEnd: string;
		farms: ({ name: string; avgDemand: number; avgSupplied: number; avgEwrShortfall: number } & Partial<
			Record<ShortfallCol, number | null>
		>)[];
		/** The totals row; present once extract_project.py reads the curtailment columns. */
		totals?: Record<string, number | null>;
	} | null;
	/** [EWR shortfalls Pivot Data], written by the workbook's VBA (absent in older extracts). */
	ewrPivot?: { year: number; month: number; farm: string; volM3: number; daysNotMet: number }[] | null;
}
/** [Shortfalls] curtailment columns in expected.json (scripts/wbt-import SHORTFALLS_COLS). */
export type ShortfallCol =
	| 'deficit'
	| 'fractionSupplied'
	| 'target'
	| 'reduceGain'
	| 'reduceGainLs'
	| 'targetFraction'
	| 'totalChange'
	| 'totalChangeLs'
	| 'volumeLeft'
	| 'fractionOfDemandLeft';
export interface ImportedProject {
	/** The importers' EXTRACT_FORMAT; absent in an extract made before it existed. */
	extractFormat?: number;
	settings: ModelInput['settings'];
	model: ModelInput['model'];
	series: { kind: string; startDate: string; values: (number | null)[] }[];
}

/**
 * The meaning of project.json's stored fields this loader replays. Same number as
 * extract_project.py's EXTRACT_FORMAT and the browser importer's EXTRACT_FORMAT; bump all
 * three when an importer change alters what a stored field means (scripts/wbt-import/README.md,
 * "Extract format"). A stale extract otherwise fails as per-column engine diffs, not as itself.
 */
export const EXPECTED_EXTRACT_FORMAT = 1;

/**
 * Throws, naming the fix, when `project` was extracted by an older importer than this loader
 * expects, or by one that stamped nothing.
 */
export function assertExtractFormat(project: { extractFormat?: unknown }, dataDir: string): void {
	const found = project.extractFormat;
	if (found === EXPECTED_EXTRACT_FORMAT) return;
	const what =
		found === undefined ? 'has no extract-format stamp (made by an older importer)' : `is extract format ${String(found)}, the loader expects ${EXPECTED_EXTRACT_FORMAT}`;
	throw new Error(
		`The client-catchment extract in ${dataDir} ${what}. Re-extract it with scripts/wbt-import/extract_project.py ` +
			'(scripts/wbt-import/README.md, "Run"); the engine tests below would otherwise fail as engine drift.'
	);
}

export interface ClientCatchmentFixture {
	dataDir: string;
	project: ImportedProject;
	expected: Expected;
	/** The replay `ModelInput`, off the workbook's own quirks (see comments below); the suite feeds it `natural`. */
	modelInput: ModelInput;
	/** The workbook's own natural flow, for tests that isolate the network port from the rain model. */
	natural: number[];
	/** Days where CHIRPS stands in for blank catchment rain (B1). */
	chirpsFallback: Uint8Array;
}

// No @types/node in this package: reach node:fs through an untyped dynamic import.
type Fs = { existsSync(p: string): boolean; readFileSync(p: string, enc: string): string };

/**
 * Where the client-catchment extract may be, in order: `WBT_CLIENT_CATCHMENT_DIR`
 * (absolute, or relative to the working directory) when set, else
 * `data/client-catchment` from the repo root or a workspace. `pnpm seed:demo`
 * extracts each workbook to `data/client-<name>-app/`, a name the repo never
 * carries, so point the variable at the right one (docs/run-locally.md).
 */
export function clientCatchmentDirs(): string[] {
	const env = (globalThis as { process?: { cwd(): string; env: Record<string, string | undefined> } }).process;
	const cwd = env?.cwd() ?? '.';
	const override = env?.env.WBT_CLIENT_CATCHMENT_DIR;
	if (override) return [override.startsWith('/') ? override : `${cwd}/${override}`];
	return ['data/client-catchment', '../data/client-catchment', '../../data/client-catchment'].map((p) => `${cwd}/${p}`);
}

/**
 * Loads `data/client-catchment` (or `WBT_CLIENT_CATCHMENT_DIR`; from `scripts/wbt-import/extract_project.py`)
 * and builds the replay `ModelInput`, or returns `null` when the gitignored
 * fixture is absent (CI, a fresh clone) — callers `describe.skipIf(!fixture)`.
 */
export async function loadClientCatchmentFixture(): Promise<ClientCatchmentFixture | null> {
	const fsSpecifier = 'node:fs';
	const fs = (await import(/* @vite-ignore */ fsSpecifier)) as Fs;
	const dataDir = clientCatchmentDirs().find((p) => fs.existsSync(`${p}/expected.json`));
	if (!dataDir) return null;

	const project = JSON.parse(fs.readFileSync(`${dataDir}/project.json`, 'utf8')) as ImportedProject;
	const expected = JSON.parse(fs.readFileSync(`${dataDir}/expected.json`, 'utf8')) as Expected;
	assertExtractFormat(project, dataDir);

	// Q1 (engine ≥ 0.9.0): the engine puts pctUpstreamToDam of the upstream
	// inflow INTO the dam, as the column's label says; the workbook's formula
	// put it below the dam. The importer stores 1 − the workbook's value
	// (2026-10-02, docs/model.md §3 Q1), so the replay feeds it unchanged.
	// A dam on the river (100 % after that) takes no River to dam (engine ≥
	// 1.68.0); the client workbooks' on-river dams have none entered.
	// N3 (engine ≥ 0.14.0): effective rain carries over through a soil-water
	// store; the workbook has none. The replay switches it off (0 mm), which
	// is bit for bit the workbook's rule; the N3 test below runs it on.
	// B2 (engine ≥ 0.15.0): flagged zero-rain runs are treated as missing and
	// CHIRPS fills them; the workbook runs them dry. The replay keeps them as
	// recorded; the B2 test below runs the default.
	// B4 (engine ≥ 0.20.0): a multi-day accumulation's total is spread over the
	// days it covers; the workbook keeps it on the reading day. The replay
	// keeps it as recorded; the B4 test below runs the default.
	// Q5 (engine ≥ 0.16.0): a dam's minimum operating level stops irrigation.
	// The workbook's "min %" column is the transfer minimum, which each
	// transfer rule already carries; migration 006 sets every stored value to
	// 0 and the importer no longer fills it, so the replay does the same.
	// N2 (engine ≥ 0.16.0): dams lose evaporation and seepage and gain the rain
	// on their surface; the workbook's dams have none. The replay gives every
	// dam a surface of 0 m² and no seepage, which is bit for bit the
	// workbook's dam; the "N2:" test below runs the estimated areas.
	const modelInput: ModelInput = {
		// Natural flow is the workbook's own (`natural`, below): its recession
		// model was removed in engine 1.0.0 (issue #16), and runModelWith takes
		// the column in its place. A project.json from an older extract may
		// still name the legacy model; the replay says GR4J, so it doesn't warn.
		settings: {
			...project.settings,
			runoffModel: 'gr4j',
			effectiveRainStoreMm: 0,
			zeroRainRuns: { mode: 'asRecorded', keepDry: [], missing: [], accumulationMode: 'asRecorded', keepReadings: [], addAccumulations: [] }
		},
		model: {
			...project.model,
			nodes: project.model.nodes.map((n) => ({ ...n, damMinPct: 0, damAreaFullM2: 0, damSeepagePerDay: 0 }))
		},
		series: Object.fromEntries(project.series.map((s) => [s.kind, { startDate: s.startDate, values: s.values }]))
	};

	// B1: days where CHIRPS stands in for blank catchment rain. The engine
	// bias-corrects CHIRPS there; the workbook uses it raw.
	const chirpsFallback = (() => {
		const d0 = toEpochDay(expected.startDate);
		const at = (kind: string, t: number) => {
			const s = project.series.find((x) => x.kind === kind);
			if (!s) return null;
			const v = s.values[d0 + t - toEpochDay(s.startDate)];
			return typeof v === 'number' && Number.isFinite(v) ? v : null;
		};
		return Uint8Array.from({ length: expected.days }, (_, t) => (at('rain_catchment_mm', t) === null && at('rain_chirps_mm', t) !== null ? 1 : 0));
	})();

	// Feed the workbook's own natural flow so this isolates the network port from the rain model.
	const natural = expected.catchment.natural_flow!.map((v) => v ?? 0);

	return { dataDir, project, expected, modelInput, natural, chirpsFallback };
}
