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
// bundle-2 (issue #523 G2) adds `headline` to bundle.json: the results digests
// of the full-allocation pair behind page 1's headline board, which the
// manifest records with how each registered volume was held as at the
// baseline (authorisedPair.ts). The pair isn't stored as runs, so the check
// re-derives it (the baseline input at fullAllocation, scenario.json's ops on
// it), re-runs it, and compares the digests, the board and the mix. A
// bundle-1 bundle (a pack issued before) is checked as it was, and says the
// headline isn't included.
//
// bundle-3 (docs/followups.md § Cumulative impact) adds the cumulative
// assessment § 4's combined row reads, when the manifest cites one:
//
//   assessment/assessment.json            its members (ops and their hashes, origin, owned units), engine, base and background runs
//   assessment/report.json                its stored report (the baseline's table, its dam rows, the background's beside it)
//   assessment/background/input.json      the background run's stored input at full allocation (when it had one)
//
// and `assessment` to bundle.json. The check ties the stored report to the
// manifest's combined section and re-runs it (bundleAssessment.ts): each
// member alone and all together (combineScenarios), the dams' rows, and the
// background's. A bundle-1 or bundle-2 bundle is checked as it was, and says
// the combined row isn't included.
//
// bundle-3 also carries the mitigation alternatives page 1 sets beside the
// application (evidence-26, 298_scenario_alternatives), each assessed one as
// a run of its own:
//
//   runs/alternative-<n>/input.json     its stored input (the baseline's with its recorded ops)
//   runs/alternative-<n>/results.json   its stored results
//
// <n> its place among the manifest's alternatives (1 …), and `alternatives`
// in bundle.json. The check ties each to the manifest (its run, engine and
// ops hash; its input the baseline's with its ops applied; its page-1 cells
// that read the run's summary, alternativeSummaryCell: `alternative:<n>`)
// and re-runs it (`reproduce:alternative:<n>`).
//
// What ties it together: manifest.json hashes to the pack's manifest hash
// (which the public verify lookup returns); the manifest names both runs and
// lists every input series' hash, the baseline's settings and model, the
// application's input changes and both runs' summaries, so the inputs and
// stored results are checked against it. The results digest (runResultsText)
// covers the summary and every daily output, so a re-run that matches it
// reproduces the run exactly. checkPackBundle does all of it, and draws § 1's
// locality map again from the manifest (evidence-12) and compares its SHA-256,
// and counts the observed wet days again from the clear dates the manifest
// freezes (evidence-21; per source and together from evidence-24), and runs § 8's pairs again from its frozen climate
// change factors (evidence-23, `climate:delta`).
import { fromEpochDay, toEpochDay } from '../calendar';
import { diffInputs, type RunInputsSnapshot } from '../compare';
import { canonicalJson, seriesDigest } from '../manifest';
import type { DailySeries, ModelInput } from '../project';
import { runModelChecked } from '../run';
import { ENGINE_VERSION } from '../version';
import { ZipArchive, zip, type ZipEntry } from '../zip';
import { forecastRainSourceOf, runRainCredits, type RainCredit } from '../liability/disclaimer';
import { LOCALITY_MAP_VERSION, localityMapSvg } from '../geo/localityMap';
import { checkDamObservations, checkDamObservationsBySource, EVIDENCE_OBSERVED_SOURCES, EVIDENCE_OBSERVED_SOURCE_LABEL, isDamObservationsV1, DAM_OBSERVATIONS_VERSION } from './damObservations';
import { checkFutureYield, futureFactorTableError } from './future';
import { packManifestText, packShortCode, type PackManifest } from './pack';
import { ALTERNATIVE_SUMMARY_ROWS, alternativeSummaryCell } from './report';
import { applyScenario } from '../scenario/overrides';
import type { RunSummary } from '../project';
import { AUTHORISED_PAIR_VERSION, authorisedPairBoard, authorisedPairInputs, freshResultsDigest, mixFromRecord, runAuthorisedPair, type AuthorisedPairRecord } from './authorisedPair';
import type { ScenarioOp } from '../scenario/ops';
import type { ModelOutput } from '../project';
import type { CumulativeRow } from '../scenario/cumulative';
import {
	ASSESSMENT_BUNDLE_VERSION,
	backgroundInputProblems,
	combinedSectionProblems,
	isDamRow,
	replayAssessment,
	rowDifferences,
	type BundleAssessmentFile,
	type BundleAssessmentReport,
	type PackBundleAssessment,
	type PackBundleBackgroundRun
} from './bundleAssessment';

/**
 * Bumped whenever the bundle's layout changes; bundle.json records it. bundle-2: the headline pair's digests (#523 G2).
 * bundle-3: the combined row's cumulative assessment (assessment/, followups § Cumulative impact).
 */
export const PACK_BUNDLE_VERSION = 'bundle-3';
/** The layouts checkPackBundle reads: every one ever issued, so an older pack verifies as it did. */
export const PACK_BUNDLE_VERSIONS = ['bundle-1', 'bundle-2', 'bundle-3'] as const;
export type PackBundleVersion = (typeof PACK_BUNDLE_VERSIONS)[number];
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
	/** The cumulative assessment § 4's combined row reads (bundle-3); required when the manifest cites one, absent or null otherwise. */
	assessment?: PackBundleAssessment | null;
	/**
	 * The runs of the alternatives page 1 assesses (bundle-3, evidence-26): one per manifest alternative whose
	 * column is assessed (`notAssessed` null), in the manifest's order. Absent or [] when it cites none.
	 */
	alternatives?: PackBundleRun[] | null;
}

/** An alternative's run in the bundle: `runs/alternative-<n>/` (bundle-3), n its place among the manifest's alternatives, from 1. */
export const bundleAlternativeDir = (n: number) => `runs/alternative-${n}`;

/** The manifest's alternatives whose column is assessed, with their place (from 1): the ones the bundle carries a run of. */
export function assessedAlternatives(m: PackManifest): { n: number; runId: string; engineVersion: string; opsSha256: string; ops: ScenarioOp[]; label: string }[] {
	return (m.report.alternatives ?? []).flatMap((x, i) =>
		x.notAssessed ? [] : [{ n: i + 1, runId: x.runId, engineVersion: x.engineVersion, opsSha256: x.opsSha256, ops: x.ops.map((o) => o.op), label: x.label }]
	);
}

/** The bundle's assessment entries (bundle-3). */
export const BUNDLE_ASSESSMENT_FILE = 'assessment/assessment.json';
export const BUNDLE_ASSESSMENT_REPORT = 'assessment/report.json';
export const BUNDLE_BACKGROUND_INPUT = 'assessment/background/input.json';

/** The assessment the manifest's § 4 combined row cites (evidence-11), or null. */
export function citedAssessment(m: PackManifest): { id: string; engineVersion: string | null } | null {
	return m.report.cumulative?.combined?.assessment ?? null;
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
	version: PackBundleVersion;
	pack: { id: string; version: number; manifestSha256: string; shortCode: string };
	/** The engine that built the manifest (manifest.engine). */
	engine: { version: string; build: string | null };
	runs: Record<BundleRunName, { runId: string; engineVersion: string; resultsSha256: string } | null>;
	/**
	 * bundle-2: the full-allocation pair behind page 1's headline board (not stored as runs; re-derived and
	 * re-run by the check), its results digests as the manifest records them; null when the pack has no such
	 * board, or one built before the pair was recorded. Absent from a bundle-1 bundle.
	 */
	headline?: { baselineResultsSha256: string; applicationResultsSha256: string } | null;
	/**
	 * bundle-3: the cumulative assessment § 4's combined row reads (its files under assessment/), its engine and its
	 * background run; null when the manifest cites none. Absent from a bundle-1 or bundle-2 bundle.
	 */
	assessment?: { id: string; engineVersion: string | null; backgroundRunId: string | null } | null;
	/**
	 * bundle-3: each assessed alternative's run (its place `n` among the manifest's alternatives, from 1), its
	 * engine and results digest; [] when the report cites none. Absent from an older bundle.
	 */
	alternatives?: { n: number; runId: string; engineVersion: string; resultsSha256: string }[];
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

/**
 * A bundled run's engine input from its stored snapshot and checked series:
 * the settings and model, and what the engine reads beside them, as the
 * backend's loadRunInput rebuilds it: `seriesChoice` (the CHIRPS series the
 * run read and the others, which a run warning reads; engine ≥ 1.90.0, issue
 * #561), a forecast run's `forecastRainSource` (its units' forecast days,
 * engine ≥ 1.85.0), the latter only as one of its values (`ecmwf_ens` from issue #604 R4-E), and `stations`
 * (the rainfall stations' names and MAPs, engine ≥ 1.91.0, issue #553), and `mapAreas` (the units whose area is from an
 * earlier outline of their polygon on the map, issue #646 F6: its warning reads them).
 */
export function bundleRunInput(snapshot: Pick<RunInputsSnapshot, 'settings' | 'model' | 'seriesChoice' | 'forecastRainSource' | 'stations' | 'mapAreas'>, series: Record<string, DailySeries>): ModelInput {
	const source = snapshot.forecastRainSource;
	const stations = snapshot.stations;
	return {
		settings: snapshot.settings,
		model: snapshot.model,
		series,
		...(snapshot.seriesChoice ? { seriesChoice: snapshot.seriesChoice } : {}),
		...(forecastRainSourceOf(source) ? { forecastRainSource: forecastRainSourceOf(source)! } : {}),
		// The rainfall stations' details (engine ≥ 1.91.0, issue #553): the station forcing reads their MAPs.
		...(stations && typeof stations === 'object' && !Array.isArray(stations) ? { stations } : {}),
		// The units whose area is from an earlier map outline (issue #646 F6): only their warning reads it.
		...(Array.isArray(snapshot.mapAreas) ? { mapAreas: snapshot.mapAreas } : {})
	} as ModelInput;
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

/**
 * The credits the bundle owes for the rain it carries (issue #604 R4-E,
 * docs/data-sources.md): a run's ERA5-Land and IMERG Late inputs are in
 * series/, and an ECMWF forecast in its forecast series, and AgERA5's and
 * NASA POWER's reference ET in its evap_et0_mm series (R5-E), so the README
 * names their sources word for word. Accessed: the baseline run's creation day.
 * Empty for a run on CHIRPS alone, whose README is as before.
 */
export function bundleRainCredits(input: Pick<PackBundleInput, 'manifest' | 'baseline' | 'application'>): RainCredit[] {
	const accessed = (input.manifest.report.identity?.baseline?.createdAt ?? '').slice(0, 10);
	const all = [input.baseline, input.application].flatMap((r) =>
		r ? runRainCredits({ summary: r.summary as Parameters<typeof runRainCredits>[0]['summary'], forecastRainSource: r.inputs.forecastRainSource, forecastRainEcmwf: r.inputs.forecastRainEcmwf, et0Products: r.inputs.et0Products }, accessed) : []
	);
	const out: RainCredit[] = [];
	for (const c of all) {
		const had = out.find((x) => x.product === c.product);
		if (!had) out.push({ ...c, lines: [...c.lines] });
		else for (const l of c.lines) if (!had.lines.includes(l)) had.lines.push(l);
	}
	return out;
}

function readme(m: PackManifest, index: Omit<PackBundleIndex, 'files'>, zipName: string, credits: readonly RainCredit[] = []): string {
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
		...(index.headline
			? [
					'',
					"The headline board against full authorised use (page 1) is over a pair of runs that isn't stored: the baseline's input with every holder at their registered volume (`allocationMode: fullAllocation`), and the application's ops (scenario.json) applied to it. The check re-derives and re-runs both:",
					'',
					`- full-allocation baseline: results digest \`${index.headline.baselineResultsSha256}\``,
					`- full-allocation application: results digest \`${index.headline.applicationResultsSha256}\``
				]
			: []),
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
		...(index.headline
			? ["It also re-derives the headline pair, re-runs it and checks both results digests, the board and the authorised volume's mix (from how each registered volume was held as at the baseline, which the manifest records) against the manifest (`headline`, `reproduce:headline`)."]
			: []),
		...(m.report.localityMap
			? ["It also draws § 1's locality map again from the map features in manifest.json and checks the SVG against the SHA-256 the manifest names (`figure:locality`)."]
			: []),
		...(m.report.damObservations
			? [
					isDamObservationsV1(m.report.damObservations)
						? "It also classifies the observed wet days again (wet, dry, inconclusive) from the dates the manifest freezes, over the baseline run's period it records (`observations:wofs`). Those dates are Digital Earth Africa WOfS (CC BY 4.0), summed inside each dam's outline; the scenes themselves aren't in the bundle."
						: "It also classifies the observed wet days again (wet, dry, inconclusive) from the dates the manifest freezes, over the baseline run's period it records: each source under its own rule (`observations:s2`, `observations:wofs`) and the dates either saw together (`observations:days`). Those dates are Sentinel-2 (contains modified Copernicus Sentinel data, processed by Digital Earth Africa) and Digital Earth Africa WOfS (CC BY 4.0), summed inside each dam's outline; the scenes themselves aren't in the bundle."
				]
			: []),
		...(index.alternatives?.length
			? [
					`It also checks each mitigation alternative page 1 sets beside the application (${index.alternatives.map((x) => `alternative ${x.n}, run \`${x.runId}\``).join('; ')}): its run, engine and ops hash are the manifest's, its input is the baseline's with its recorded ops, and its page-1 cells that read its run's summary (the Reserve, the EWR days and shortfall, the no-flow days, the outflow) are its stored results' (\`alternative:<n>\`); then re-runs it and compares its results digest (\`reproduce:alternative:<n>\`).`
				]
			: []),
		...(index.assessment
			? [
					`It also runs § 4's combined row again from the cumulative assessment it cites (\`${index.assessment.id}\`, engine ${index.assessment.engineVersion ?? 'unknown'}): the baseline, each application alone (an applicant's ops under the mask its own units give it) and all of them together (\`combineScenarios\`), and checks every row of the assessment's stored report, which the manifest's combined section is read from (\`assessment\`, \`reproduce:combined\`); each dam the applications touch, its firm yield and assurance of supply on every run (\`reproduce:dams\`, when the assessment has them)${index.assessment.backgroundRunId ? "; and the same again on its background at full allocation, from the background run's stored input (`inputs:background`, `reproduce:background`)" : ''}.`
				]
			: []),
		...(m.report.futureYield?.status === 'ok'
			? ["It also runs § 8's future yield again: every pair, the baseline and the application under each climate model's monthly change factors, from the factor table the manifest freezes, and checks every case and range against the manifest (`climate:delta`). The NEX-GDDP-CMIP6 files the factors came from aren't in the bundle; the manifest names each with its SHA-256."]
			: []),
		'Add `--expect <manifest hash>` to also require the hash the verify lookup returned, and `--no-run` to check the files without re-running.',
		'',
		'## Files',
		'',
		'- `bundle.json`: the index (pack, engine, each run\'s results digest, the headline pair\'s digests, every other file\'s SHA-256).',
		'- `manifest.json`: the pack\'s manifest, as its canonical (RFC 8785) text.',
		...(index.runs.application ? ['- `scenario.json`: the application\'s scenario as its run recorded it (ops, their hash, the base run).'] : []),
		'- `runs/<run>/input.json`: the run\'s stored inputs: settings, model, and each series\' first day, days and SHA-256.',
		'- `runs/<run>/results.json`: the run\'s stored summary and the SHA-256 of each daily output. The results digest is the SHA-256 of its canonical text (engine `runResultsText`).',
		'- `series/<sha256>.csv`: each input series\' values, `date,value`, a missing day empty; named by the SHA-256 of the values\' JSON array.',
		...(index.alternatives?.length
			? ['- `runs/alternative-<n>/input.json`, `runs/alternative-<n>/results.json`: each assessed alternative\'s stored inputs and results, as a run\'s above (<n> its place among page 1\'s alternatives).']
			: []),
		...(index.assessment
			? [
					"- `assessment/assessment.json`: the cumulative assessment § 4's combined row reads: its members in the order it ran them (each one's ops, their SHA-256, its origin and an applicant's own units), its engine, its baseline and background runs.",
					"- `assessment/report.json`: the assessment's stored report: the baseline's table with each dam's rows, and the background's beside it.",
					...(index.assessment.backgroundRunId ? ["- `assessment/background/input.json`: the background run's stored inputs: the baseline at full allocation (its series are the baseline's)."] : [])
				]
			: []),
		...(credits.length ? ['', '## Data credits', '', 'Some input series hold rain from these sources, credited as each asks:', '', ...credits.flatMap((c) => c.lines.map((l) => `- ${c.name}: ${l}`))] : []),
		''
	].join('\n');
}

/** The headline board's pair record, when the manifest's board is built and records one (evidence-19). */
function headlineRecord(m: PackManifest): AuthorisedPairRecord | null {
	const lia = m.report.licenceImpactAuthorised;
	return lia?.status === 'ok' && lia.reproduction ? lia.reproduction : null;
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

	/** A run's input, its series and its results under `dir`; its results digest. */
	const putRun = async (dir: string, what: string, run: PackBundleRun) => {
		put(`${dir}/input.json`, canonicalJson(run.inputs));
		for (const [kind, snap] of Object.entries(run.inputs.series ?? {})) {
			if (!snap) continue;
			const values = run.values[kind];
			if (!values || !snap.valuesSha256) throw new Error(`the ${what} run's ${kind} series has no stored values`);
			if ((await hash(seriesDigest(values))) !== snap.valuesSha256) throw new Error(`the ${what} run's ${kind} series fails its SHA-256 check`);
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
		put(`${dir}/results.json`, canonicalJson(results));
		return digest.sha256;
	};
	const runs: PackBundleIndex['runs'] = { baseline: null, application: null };
	for (const name of RUNS) {
		const run = input[name];
		if (!run) continue;
		runs[name] = { runId: run.runId, engineVersion: run.engineVersion, resultsSha256: await putRun(`runs/${name}`, name, run) };
	}
	// The assessed alternatives' runs (bundle-3, evidence-26): exactly the manifest's, in its order.
	const wanted = assessedAlternatives(m);
	const given = input.alternatives ?? [];
	if (given.length !== wanted.length || given.some((r, i) => r.runId !== wanted[i]!.runId))
		throw new Error(`the bundle was given alternatives ${given.map((r) => r.runId).join(', ') || 'none'}; the manifest assesses ${wanted.map((w) => w.runId).join(', ') || 'none'}`);
	const alternatives: NonNullable<PackBundleIndex['alternatives']> = [];
	for (const [i, run] of given.entries()) {
		const n = wanted[i]!.n;
		alternatives.push({ n, runId: run.runId, engineVersion: run.engineVersion, resultsSha256: await putRun(bundleAlternativeDir(n), `alternative ${n}`, run) });
	}
	if (input.application?.inputs.scenario) put('scenario.json', canonicalJson(input.application.inputs.scenario));

	// The combined row's assessment (bundle-3): its members, its stored report, its background run's inputs.
	const cited = citedAssessment(m);
	const a = input.assessment ?? null;
	if (cited && !a) throw new Error(`the manifest's combined row cites assessment ${cited.id}, and the bundle wasn't given it`);
	if (a && a.id !== cited?.id) throw new Error(`the assessment given (${a.id}) isn't the one the manifest's combined row cites (${String(cited?.id ?? null)})`);
	if (a) {
		const file: BundleAssessmentFile = {
			version: ASSESSMENT_BUNDLE_VERSION,
			id: a.id,
			name: a.name,
			engineVersion: a.engineVersion,
			baseRunId: a.baseRunId,
			backgroundRunId: a.backgroundRunId,
			members: a.members.map((x) => ({ id: x.id, scenarioId: x.scenarioId, name: x.name, origin: x.origin, ops: x.ops, opsSha256: x.opsSha256, ownedNodeIds: [...x.ownedNodeIds] }))
		};
		put(BUNDLE_ASSESSMENT_FILE, canonicalJson(file));
		put(BUNDLE_ASSESSMENT_REPORT, canonicalJson(asStored(a.report)));
		if ((a.background?.runId ?? null) !== a.backgroundRunId) throw new Error("the assessment's background run isn't the one given");
		if (a.background) {
			put(BUNDLE_BACKGROUND_INPUT, canonicalJson(a.background.inputs));
			for (const [kind, snap] of Object.entries(a.background.inputs.series ?? {})) {
				if (!snap) continue;
				const values = a.background.values[kind];
				if (!values || !snap.valuesSha256) throw new Error(`the background run's ${kind} series has no stored values`);
				if ((await hash(seriesDigest(values))) !== snap.valuesSha256) throw new Error(`the background run's ${kind} series fails its SHA-256 check`);
				put(bundleSeriesPath(snap.valuesSha256), seriesCsv(snap.startDate, values));
			}
		}
	}

	const pair = headlineRecord(m);
	const head = {
		version: PACK_BUNDLE_VERSION,
		pack: { id: m.pack.id, version: m.pack.version, manifestSha256, shortCode: packShortCode(manifestSha256) },
		engine: { version: m.engine.version, build: m.engine.build },
		runs,
		headline: input.application && pair ? { baselineResultsSha256: pair.baselineResultsSha256, applicationResultsSha256: pair.applicationResultsSha256 } : null,
		assessment: a ? { id: a.id, engineVersion: a.engineVersion, backgroundRunId: a.backgroundRunId } : null,
		alternatives
	} as const;
	put('README.md', readme(m, head, `pack-${head.pack.shortCode}.zip`, bundleRainCredits(input)));
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
	/** `archive`, `files`, `manifest`, `runs`, `inputs:<run>`, `changes`, `scenario`, `results:<run>`, `headline`, `reproduce:<run>`, `reproduce:headline`, `figure:locality`, `observations:wofs` (§ 7, evidence-21), `observations:s2` and `observations:days` (§ 7, evidence-24), `climate:delta` (§ 8, evidence-23), `assessment`, `inputs:background`, `reproduce:combined`, `reproduce:dams` and `reproduce:background` (§ 4's combined row, bundle-3). */
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
	/**
	 * The headline board's pair (issue #523 G2): `checked` when the bundle records it (and, with `rerun`, it
	 * was re-run), `older` for a bundle-1 bundle or a board built before the pair was recorded, `none` for a
	 * baseline pack or one with no headline board, null when the bundle couldn't be read that far.
	 */
	headline: 'checked' | 'older' | 'none' | null;
	/**
	 * § 4's combined row (bundle-3): `checked` when the bundle carries the assessment it cites (and, with `rerun`,
	 * it was re-run), `older` for a bundle-1 or bundle-2 bundle of a pack whose combined row cites one, `none`
	 * when it cites none, null when the bundle couldn't be read that far.
	 */
	combined: 'checked' | 'older' | 'none' | null;
}

/**
 * A re-run the server runs as its own job (bundleParts.ts, pack_reproduce_part): one run, the headline pair,
 * § 8's pairs, the combined row's assessment (its dams' firm yields aside), or its background.
 */
export type BundlePartKey = 'run:baseline' | 'run:application' | `alternative:${number}` | 'headline' | 'climate' | 'combined' | 'background';

/** What the combined row's assessment looks like once checked, for the server's dam parts (bundleParts.ts). */
export interface BundleAssessmentContext {
	base: ModelInput;
	file: BundleAssessmentFile;
	report: BundleAssessmentReport;
}

export interface CheckPackBundleOptions {
	hash: BundleHash;
	/** Re-run each run with this engine and compare its results digest (default true). */
	rerun?: boolean;
	/**
	 * Only these re-runs (the server's fan-out, bundleParts.ts); absent, every one (`pnpm reproduce:pack`). With
	 * it, `combined` leaves the dams' firm-yield searches to their own parts: its `reproduce:dams` covers the
	 * assurance rows and which dams, and the parts' yields are folded in after (foldPackBundleReruns).
	 */
	parts?: readonly BundlePartKey[];
	/** Called with the checked assessment's inputs, when its static checks pass (the server's dam parts). */
	onAssessment?: (ctx: BundleAssessmentContext) => void;
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
/** Whether a check re-runs `part`: never with `rerun: false`, every part without `parts`, else the listed ones. */
const wantsPart = (opts: Pick<CheckPackBundleOptions, 'rerun' | 'parts'>, part: BundlePartKey) => opts.rerun !== false && (!opts.parts || opts.parts.includes(part));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Check a reproduction bundle: every file against bundle.json, the manifest
 * against its hash, the inputs and stored results against the manifest, and
 * (unless `rerun: false`) re-run each run from its inputs with this engine and
 * compare the results digest. Never throws for a bad bundle: each problem is a
 * failing check.
 */
export async function checkPackBundle(bytes: Uint8Array<ArrayBuffer>, opts: CheckPackBundleOptions): Promise<BundleCheckResult> {
	const checks: BundleCheck[] = [];
	try {
		return await checkBundle(bytes, opts, checks);
	} catch (e) {
		// A file that passed its hash but isn't what its name says (JSON that
		// doesn't parse, a manifest or input missing a part): the bundle is
		// malformed, a failing check like any other, never an exception.
		checks.push({ id: 'structure', ok: false, detail: `the bundle is malformed: ${message(e)}` });
		return { ok: false, checks, pack: null, engine: { here: ENGINE_VERSION, runs: [] }, headline: null, combined: null };
	}
}

/** bundle.json's `pack` as a bundle names it: anything else is a malformed bundle. */
function packRefProblem(pack: unknown): string | null {
	const p = pack as Partial<PackBundleIndex['pack']> | null;
	if (typeof p !== 'object' || p === null) return "its bundle.json doesn't name the pack";
	if (typeof p.id !== 'string' || !Number.isInteger(p.version) || typeof p.shortCode !== 'string' || typeof p.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.manifestSha256))
		return "its bundle.json's pack lacks an id, a version, a short code or a 64-hex manifest hash";
	return null;
}

async function checkBundle(bytes: Uint8Array<ArrayBuffer>, opts: CheckPackBundleOptions, checks: BundleCheck[]): Promise<BundleCheckResult> {
	const { hash } = opts;
	const add = (id: string, ok: boolean, detail: string) => (checks.push({ id, ok, detail }), ok);
	const want = (k: BundlePartKey) => wantsPart(opts, k);
	let headline: BundleCheckResult['headline'] = null;
	let combined: BundleCheckResult['combined'] = null;
	const result = (pack: BundleCheckResult['pack'], runs: string[]): BundleCheckResult => ({
		ok: checks.length > 0 && checks.every((c) => c.ok),
		checks,
		pack,
		engine: { here: ENGINE_VERSION, runs },
		headline,
		combined
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
		if (!(PACK_BUNDLE_VERSIONS as readonly unknown[]).includes(index.version))
			throw new Error(`its bundle.json is version ${String(index.version)}; this code reads ${PACK_BUNDLE_VERSIONS.slice(0, -1).join(', ')} and ${PACK_BUNDLE_VERSIONS.at(-1)}`);
		const packProblem = packRefProblem(index.pack);
		if (packProblem) throw new Error(packProblem);
		if (typeof index.runs !== 'object' || index.runs === null || !index.runs.baseline) throw new Error("its bundle.json doesn't name the baseline run");
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

	// The observed wet days (evidence-21): classified again from the dates the manifest freezes, over the baseline run's period as the manifest records it.
	// dam-obs-2 (evidence-24) is checked per source and for the dates together; dam-obs-1 (evidence-21 to -23, WOfS alone) as it was.
	const obs = manifest.report.damObservations;
	if (obs) {
		const b = manifest.report.identity?.baseline;
		const ctx = { period: { startDate: String(b?.startDate), endDate: String(b?.endDate) }, builtBy: manifest.report.builtBy };
		const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
		if (obs.version === DAM_OBSERVATIONS_VERSION) {
			let by: ReturnType<typeof checkDamObservationsBySource> | null = null;
			let failure = '';
			try {
				by = checkDamObservationsBySource(obs, ctx);
			} catch (e) {
				failure = `the observed wet days can't be counted from the manifest: ${message(e)}`;
			}
			const period = `over the baseline run's period (${obs.startDate} to ${obs.endDate})`;
			for (const source of EVIDENCE_OBSERVED_SOURCES) {
				const problems = by?.[source] ?? [failure];
				const n = problems.length ? 0 : obs.dams.reduce((k, d) => k + d.sources[source].observedDates, 0);
				add(
					`observations:${source}`,
					problems.length === 0,
					problems.join('; ') || `the ${EVIDENCE_OBSERVED_SOURCE_LABEL[source]} dates of ${plural(obs.dams.length, 'dam')} ${period} classify again from the manifest's ${plural(n, 'observed date')}`
				);
			}
			const problems = by?.days ?? [failure];
			const n = problems.length ? 0 : obs.dams.reduce((k, d) => k + d.observedDates, 0);
			add('observations:days', problems.length === 0, problems.join('; ') || `the ${plural(n, 'date')} either source saw ${period} count again from the manifest's dates, each read by the sharper source that calls it`);
		} else {
			try {
				const problems = checkDamObservations(obs, ctx);
				const observed = isDamObservationsV1(obs) && Array.isArray(obs.dams) ? obs.dams.reduce((n, d) => n + d.observedDates, 0) : 0;
				add(
					'observations:wofs',
					problems.length === 0,
					problems.join('; ') ||
						`the observed wet days of ${plural(obs.dams.length, 'dam')} over the baseline run's period (${obs.startDate} to ${obs.endDate}) classify again from the manifest's ${plural(observed, 'observed date')}`
				);
			} catch (e) {
				add('observations:wofs', false, `the observed wet days can't be counted from the manifest: ${message(e)}`);
			}
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
					...(s.origin !== undefined ? { origin: s.origin } : {}),
					// The stored series it was read from (engine ≥ 1.102.0): settings.flowMissing and the like name it.
					...(typeof s.seriesId === 'string' ? { seriesId: s.seriesId } : {})
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
		inputs[r] = { snapshot, values, input: ok ? bundleRunInput(snapshot, series) : null };
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

	// Re-run each run from its inputs, and compare. The baseline's fresh run is the combined row's baseline column too.
	const freshRuns: Partial<Record<BundleRunName, ModelOutput>> = {};
	if (opts.rerun !== false) {
		for (const r of RUNS) {
			const named = index.runs[r];
			if (!named || !want(`run:${r}`)) continue;
			const input = inputs[r]?.input;
			const stored = results[r];
			if (!input || !stored) {
				add(`reproduce:${r}`, false, 'not re-run: its inputs or stored results failed a check above');
				continue;
			}
			const again = await reproduceRun(input, stored, named, hash);
			if (again.fresh) freshRuns[r] = again.fresh;
			add(`reproduce:${r}`, again.ok, again.detail);
		}
	}

	// The alternatives page 1 assesses (bundle-3, evidence-26): each tied to the manifest, then re-run.
	await checkAlternatives(index, manifest, text, inputs.baseline ?? null, results.baseline ?? null, opts, add, runEngines);

	// The headline board's full-allocation pair (bundle-2, #523 G2): recorded in the manifest, re-derived and re-run here.
	if (index.runs.application) {
		headline = await checkHeadline(index, manifest, inputs.baseline?.input ?? null, inputs.application?.snapshot.scenario ?? null, opts, add);
	}

	// § 4's combined row (bundle-3): the cumulative assessment it cites, tied to the manifest and re-run.
	combined = await checkAssessment(index, manifest, text, inputs.baseline ?? null, freshRuns.baseline ?? null, opts, add, runEngines);

	// § 8, Future yield (evidence-23): every pair run again from the factors the manifest freezes, on the bundle's own inputs.
	const fy = manifest.report.futureYield;
	if (fy && fy.status === 'ok') {
		const tableError = futureFactorTableError(fy.factors);
		const named = `${fy.cases.length} case${fy.cases.length === 1 ? '' : 's'} (${fy.models.length} model${fy.models.length === 1 ? '' : 's'} × ${new Set(fy.cases.map((c) => c.ssp)).size} SSPs × ${new Set(fy.cases.map((c) => c.horizon)).size} horizons), method ${fy.method}`;
		if (tableError) add('climate:delta', false, `the frozen factor table can't be read: ${tableError}`);
		else if (!want('climate')) add('climate:delta', true, `the manifest freezes the factors of ${named}; not re-run`);
		else if (!inputs.baseline?.input || !inputs.application?.input) add('climate:delta', false, 'not re-run: the baseline or application inputs failed a check above');
		else {
			const problems = checkFutureYield(fy, { baseline: inputs.baseline.input, application: inputs.application.input }, manifest.report.builtBy);
			add('climate:delta', problems.length === 0, problems.join('; ') || `every pair of ${named} run again with engine ${ENGINE_VERSION} from the frozen factors gives the manifest's § 8`);
		}
	}
	return result(index.pack, runEngines);
}

/** An older pack's headline: checked as it was, said so. */
export const HEADLINE_NOT_INCLUDED = 'headline not included (older pack)';

async function checkHeadline(
	index: PackBundleIndex,
	manifest: PackManifest,
	baseline: ModelInput | null,
	scenario: { opsSha256?: string; ops?: unknown } | null,
	opts: CheckPackBundleOptions,
	add: (id: string, ok: boolean, detail: string) => boolean
): Promise<BundleCheckResult['headline']> {
	const { hash } = opts;
	const lia = manifest.report.licenceImpactAuthorised ?? null;
	const rec = headlineRecord(manifest);
	if (index.version === 'bundle-1') {
		add('headline', true, `${HEADLINE_NOT_INCLUDED}: its bundle (bundle-1) predates the record of the full-authorised-use pair, so the headline board is not re-run`);
		return 'older';
	}
	if (!rec) {
		if (index.headline) {
			add('headline', false, "bundle.json names a headline pair the manifest doesn't record");
			return 'none';
		}
		if (lia?.status === 'ok') {
			add('headline', true, `${HEADLINE_NOT_INCLUDED}: its headline board was built before the full-authorised-use pair was recorded, so it is not re-run`);
			return 'older';
		}
		add('headline', true, `no headline board to re-run (${lia ? `the board is ${lia.status}` : 'the report has none'})`);
		return 'none';
	}
	const identity = manifest.report.identity;
	const problems: string[] = [];
	if (rec.version !== AUTHORISED_PAIR_VERSION) problems.push(`the pair's record is ${String(rec.version)}; this code reads ${AUTHORISED_PAIR_VERSION}: check out the engine that built the report (${manifest.report.builtBy})`);
	if (rec.resultsVersion !== RUN_RESULTS_VERSION) problems.push(`its digests are of ${String(rec.resultsVersion)}; this code computes ${RUN_RESULTS_VERSION}`);
	if (rec.allocationMode !== 'fullAllocation') problems.push(`it was derived at allocation mode ${String(rec.allocationMode)}, not fullAllocation`);
	if (!index.headline || index.headline.baselineResultsSha256 !== rec.baselineResultsSha256 || index.headline.applicationResultsSha256 !== rec.applicationResultsSha256)
		problems.push("bundle.json's headline digests aren't the ones the manifest records");
	if ((rec.opsSha256 ?? null) !== (identity.application?.opsSha256 ?? null)) problems.push("the pair applied other ops than the application's (its ops hash isn't the manifest's)");
	if (lia?.engineVersion && lia.engineVersion !== identity.baseline.engineVersion) problems.push(`the pair ran on engine ${lia.engineVersion}, the baseline on ${identity.baseline.engineVersion}`);
	// The mix, from the baseline input's registered volumes and how each was held as at the baseline (the record's kinds).
	if (!baseline) problems.push("the mix can't be checked: the baseline's inputs failed a check above");
	else {
		const mix = mixFromRecord(baseline, rec.kinds);
		const frozen = lia?.mix ?? null;
		if (mix === 'mismatch') problems.push("the record's kinds aren't the baseline input's registered volumes (one each)");
		else if (frozen && 'folded' in frozen && frozen.folded) problems.push('the manifest carries only a folded mix');
		else if (!sameJson(mix, frozen)) problems.push(`the mix from the baseline's volumes and the recorded kinds isn't the manifest's (${differingPaths(mix, frozen).join(', ')})`);
	}
	const named = `full-allocation pair: baseline ${rec.baselineResultsSha256}, application ${rec.applicationResultsSha256}`;
	add('headline', problems.length === 0, problems.join('; ') || `the manifest records the ${named}; the mix of ${rec.kinds.length} registered volume${rec.kinds.length === 1 ? '' : 's'} as at the baseline is the manifest's`);
	if (!wantsPart(opts, 'headline')) return 'checked';

	// Re-derive the pair from the bundle's inputs and re-run it.
	const ops = scenario?.ops;
	if (!baseline || !Array.isArray(ops)) {
		add('reproduce:headline', false, 'not re-run: the baseline input or the scenario failed a check above');
		return 'checked';
	}
	const pair = authorisedPairInputs(baseline, ops as ScenarioOp[]);
	if (pair.problems.length) {
		add('reproduce:headline', false, `the application's ops don't all apply to the baseline at full allocation: ${pair.problems.slice(0, 5).join('; ')}`);
		return 'checked';
	}
	let ran;
	try {
		ran = runAuthorisedPair(pair);
	} catch (e) {
		add('reproduce:headline', false, `this engine (${ENGINE_VERSION}) refuses the full-allocation pair: ${message(e)}`);
		return 'checked';
	}
	const why: string[] = [];
	const b = await freshResultsDigest(ran.background, hash);
	const a = await freshResultsDigest(ran.application, hash);
	if (b !== rec.baselineResultsSha256) why.push(`the full-allocation baseline's results digest is ${b}, not ${rec.baselineResultsSha256}`);
	if (a !== rec.applicationResultsSha256) why.push(`the full-allocation application's results digest is ${a}, not ${rec.applicationResultsSha256}`);
	const board = authorisedPairBoard(pair.baseline, ran.background, ran.application, { yearClassMethod: rec.yearClassMethod, siteNodeId: rec.siteNodeId });
	if (!sameJson(board, lia?.board ?? null)) why.push(`the board built again isn't the manifest's (${differingPaths(board, lia?.board ?? null).join(', ')})`);
	const engineNote = identity.baseline.engineVersion !== ENGINE_VERSION ? ` The baseline was run with engine ${identity.baseline.engineVersion}; this is ${ENGINE_VERSION}: check out that engine (README.md).` : '';
	add(
		'reproduce:headline',
		why.length === 0,
		why.length === 0 ? `re-derived and re-run with engine ${ENGINE_VERSION}: both results digests and the headline board are the same` : `re-derived and re-run with engine ${ENGINE_VERSION}: ${why.join('; ')}.${engineNote}`
	);
	return 'checked';
}

/** An older bundle's combined row: checked as it was, said so. */
export const COMBINED_NOT_INCLUDED = 'combined row not included (older bundle)';

/**
 * § 4's combined row (bundle-3): the assessment it cites is the bundle's,
 * its members' ops hash to theirs, and the manifest's combined section is
 * what its stored report gives (`assessment`); its background run's input is
 * the baseline at full allocation (`inputs:background`); and, with the re-run,
 * the assessment run again on this engine gives every stored row
 * (`reproduce:combined`, `reproduce:dams`, `reproduce:background`).
 */
async function checkAssessment(
	index: PackBundleIndex,
	manifest: PackManifest,
	text: ReadonlyMap<string, string>,
	baseline: { snapshot: PackBundleRun['inputs']; input: ModelInput | null; values: Record<string, (number | null)[]> } | null,
	baselineOut: ModelOutput | null,
	opts: CheckPackBundleOptions,
	add: (id: string, ok: boolean, detail: string) => boolean,
	runEngines: string[]
): Promise<BundleCheckResult['combined']> {
	const { hash } = opts;
	const cited = citedAssessment(manifest);
	if (index.version !== 'bundle-3') {
		if (!cited) return 'none';
		add('assessment', true, `${COMBINED_NOT_INCLUDED}: its bundle (${index.version}) predates the combined row's assessment, so § 4's combined row is not re-run`);
		return 'older';
	}
	const named = index.assessment ?? null;
	const carried = text.has(BUNDLE_ASSESSMENT_FILE) || text.has(BUNDLE_ASSESSMENT_REPORT) || text.has(BUNDLE_BACKGROUND_INPUT);
	if (!cited) {
		if (named || carried) add('assessment', false, "the bundle carries an assessment the manifest's combined row doesn't cite");
		return 'none';
	}
	if (!named || !text.has(BUNDLE_ASSESSMENT_FILE) || !text.has(BUNDLE_ASSESSMENT_REPORT)) {
		add('assessment', false, `the manifest's combined row cites assessment ${cited.id}, which the bundle doesn't carry`);
		return 'checked';
	}
	const file = JSON.parse(text.get(BUNDLE_ASSESSMENT_FILE)!) as BundleAssessmentFile;
	const report = JSON.parse(text.get(BUNDLE_ASSESSMENT_REPORT)!) as BundleAssessmentReport;
	if (!Array.isArray(file.members) || !Array.isArray(report.rows) || !Array.isArray(report.scenarios)) throw new Error(`${BUNDLE_ASSESSMENT_FILE} or ${BUNDLE_ASSESSMENT_REPORT} lacks its members, rows or scenarios`);
	if (file.engineVersion) runEngines.push(file.engineVersion);
	const identity = manifest.report.identity;
	const problems: string[] = [];
	if (file.version !== ASSESSMENT_BUNDLE_VERSION) problems.push(`${BUNDLE_ASSESSMENT_FILE} is version ${String(file.version)}; this code reads ${ASSESSMENT_BUNDLE_VERSION}`);
	if (file.id !== cited.id || named.id !== cited.id) problems.push(`it is assessment ${String(file.id)}; the manifest's combined row cites ${cited.id}`);
	if ((file.engineVersion ?? null) !== (cited.engineVersion ?? null) || (named.engineVersion ?? null) !== (cited.engineVersion ?? null))
		problems.push(`it ran on engine ${String(file.engineVersion)}; the manifest names ${String(cited.engineVersion)}`);
	if (file.baseRunId !== identity.baseline.runId) problems.push(`its baseline run is ${String(file.baseRunId)}, not the pack's ${identity.baseline.runId}`);
	const bgId = file.backgroundRunId ?? null;
	if ((named.backgroundRunId ?? null) !== bgId || (report.background?.run?.id ?? null) !== bgId) problems.push("its background run isn't the one bundle.json and its stored report name");
	if (!!bgId !== text.has(BUNDLE_BACKGROUND_INPUT)) problems.push(bgId ? `it has a background run and no ${BUNDLE_BACKGROUND_INPUT}` : `it has no background run and a ${BUNDLE_BACKGROUND_INPUT}`);
	for (const m of file.members) {
		if (m.origin !== 'team' && m.origin !== 'applicant') problems.push(`"${m.name}" has origin ${String(m.origin)}`);
		if (!Array.isArray(m.ops) || !Array.isArray(m.ownedNodeIds)) {
			problems.push(`"${m.name}" lacks its ops or owned units`);
			continue;
		}
		const sha = await hash(canonicalJson(m.ops));
		if (sha !== m.opsSha256) problems.push(`"${m.name}"'s ops hash to ${sha}, not the ${String(m.opsSha256)} recorded`);
	}
	const c = manifest.report.cumulative?.combined;
	if (c) problems.push(...combinedSectionProblems(c, file, report));
	const what = `assessment "${file.name}" of ${file.members.length} application${file.members.length === 1 ? '' : 's'}`;
	const staticOk = add('assessment', problems.length === 0, problems.join('; ') || `${what}: the members' ops hash to theirs, and the manifest's combined row is what its stored report gives`);

	// Its background at full allocation (295): the baseline's input with the background's ops, the baseline's series.
	let bgInput: ModelInput | null = null;
	if (bgId && text.has(BUNDLE_BACKGROUND_INPUT)) {
		const snap = JSON.parse(text.get(BUNDLE_BACKGROUND_INPUT)!) as PackBundleBackgroundRun['inputs'];
		const bp: string[] = [];
		if (!baseline?.input) bp.push("not checked: the baseline's inputs failed a check above");
		else {
			const baseSeries = Object.fromEntries(Object.entries(baseline.snapshot.series ?? {}).flatMap(([k, v]) => (v ? [[k, v.valuesSha256 ?? null]] : [])));
			bp.push(...backgroundInputProblems(baseline.input, identity.baseline.runId, snap, baseSeries));
			const sc = snap.scenario;
			const sha = await hash(canonicalJson(sc?.ops ?? []));
			if (sc && sha !== sc.opsSha256) bp.push(`its ops hash to ${sha}, not the ${String(sc.opsSha256)} it records`);
			if (!bp.length) {
				// Its series are the baseline's (checked above), each with its own snapshot's first day and provenance.
				const series: Record<string, DailySeries> = {};
				for (const [kind, s] of Object.entries(snap.series ?? {})) {
					if (!s) continue;
					series[kind] = {
						startDate: s.startDate,
						values: baseline.values[kind]!,
						...(s.provenance !== undefined ? { provenance: s.provenance } : {}),
						...(s.origin !== undefined ? { origin: s.origin } : {}),
						...(typeof s.seriesId === 'string' ? { seriesId: s.seriesId } : {})
					};
				}
				bgInput = bundleRunInput(snap, series);
			}
		}
		add('inputs:background', bp.length === 0, bp.join('; ') || "the background run's input is the baseline's at full allocation: its ops change only the mode and registered volumes, and its series are the baseline's");
	}
	if (staticOk && baseline?.input) opts.onAssessment?.({ base: baseline.input, file, report });
	if (!wantsPart(opts, 'combined') && !wantsPart(opts, 'background')) return 'checked';
	// The server's fan-out: the dams' firm yields are their own parts, folded in after (bundleParts.ts).
	const damSearch = !opts.parts;

	const engineNote =
		file.engineVersion && file.engineVersion !== ENGINE_VERSION ? ` The assessment ran on engine ${file.engineVersion}; this is ${ENGINE_VERSION}: check out that engine (README.md).` : '';
	const compare = (id: string, stored: readonly CumulativeRow[], fresh: readonly CumulativeRow[], extra: string[], ok: string) => {
		const why = [...extra, ...rowDifferences(stored, fresh)];
		add(id, why.length === 0, why.length === 0 ? ok : `re-run with engine ${ENGINE_VERSION}: ${why.slice(0, 8).join('; ')}.${engineNote}`);
	};
	const stillOk = staticOk && !!baseline?.input;
	const withDams = report.dams !== undefined;
	if (!wantsPart(opts, 'combined')) {
		// Not this part's (the server's fan-out runs it in another job).
	} else if (!stillOk) {
		add('reproduce:combined', false, 'not re-run: the assessment or the baseline inputs failed a check above');
		if (withDams) add('reproduce:dams', false, 'not re-run: the assessment or the baseline inputs failed a check above');
	} else {
		let fresh: ReturnType<typeof replayAssessment> | null = null;
		try {
			fresh = replayAssessment(baseline!.input!, file.members, { dams: withDams ? (damSearch ? true : 'reliability') : false, baseline: baselineOut });
		} catch (e) {
			add('reproduce:combined', false, `re-run with engine ${ENGINE_VERSION}: ${message(e)}.${engineNote}`);
			if (withDams) add('reproduce:dams', false, `not re-run: ${message(e)}`);
		}
		if (fresh) {
			const sc = sameJson(fresh.scenarios, report.scenarios) ? [] : ["the scenarios aren't the stored report's"];
			compare(
				'reproduce:combined',
				report.rows.filter((r) => !isDamRow(r)),
				fresh.rows.filter((r) => !isDamRow(r)),
				sc,
				`the baseline, each of the ${file.members.length} applications alone and all of them together, re-run with engine ${ENGINE_VERSION}, give every row of the stored report`
			);
			if (withDams) {
				const meta = sameJson(fresh.dams ?? null, report.dams ?? null) ? [] : ["the dams touched, or whether their yields rest on the registered volumes, aren't the stored report's"];
				// Without the searches (the server's fan-out), the assurance rows and which dams; the firm yields are folded in from their parts.
				const rows = (r: CumulativeRow) => isDamRow(r) && (damSearch || r.metric === 'dam_reliability');
				const n = report.dams!.nodeIds.length;
				compare(
					'reproduce:dams',
					report.rows.filter(rows),
					fresh.rows.filter(rows),
					meta,
					damSearch
						? `the firm yield and assurance of supply of ${n === 1 ? 'the dam' : `each of the ${n} dams`} the applications touch, on every run, are the stored report's`
						: `the assurance of supply of ${n === 1 ? 'the dam' : `each of the ${n} dams`} the applications touch, on every run, is the stored report's`
				);
			}
		}
	}
	if (bgId && wantsPart(opts, 'background')) {
		const stored = report.background?.report;
		if (!stillOk || !bgInput || !stored) add('reproduce:background', false, "not re-run: the assessment or the background run's input failed a check above");
		else {
			try {
				const fresh = replayAssessment(bgInput, file.members, { dams: false, what: 'At full allocation' });
				compare(
					'reproduce:background',
					stored.rows,
					fresh.rows,
					sameJson(fresh.scenarios, stored.scenarios) ? [] : ["the scenarios aren't the stored background's"],
					`the background at full allocation, each application alone and all together on it, re-run with engine ${ENGINE_VERSION}, give every row of its stored table`
				);
			} catch (e) {
				add('reproduce:background', false, `re-run with engine ${ENGINE_VERSION}: ${message(e)}.${engineNote}`);
			}
		}
	}
	return 'checked';
}

/** Re-run one run from its input with this engine and compare its results digest with the stored one; never throws. */
async function reproduceRun(
	input: ModelInput,
	stored: RunResultsFile,
	named: { engineVersion: string; resultsSha256: string },
	hash: BundleHash
): Promise<{ ok: boolean; detail: string; fresh: ModelOutput | null }> {
	let fresh: ModelOutput;
	try {
		fresh = runModelChecked(structuredClone(input));
	} catch (e) {
		return { ok: false, detail: `this engine (${ENGINE_VERSION}) refuses the run's input: ${message(e)}`, fresh: null };
	}
	const again = await runResultsDigest({ startDate: fresh.startDate, summary: fresh.summary, series: fresh.series }, hash);
	if (again.sha256 === named.resultsSha256) return { ok: true, detail: `re-run with engine ${ENGINE_VERSION}: results digest ${again.sha256}, the same`, fresh };
	const why: string[] = [];
	if (fresh.startDate !== stored.startDate) why.push(`it starts on ${fresh.startDate}, not ${stored.startDate}`);
	const paths = differingPaths(stored.summary, fresh.summary);
	if (paths.length) why.push(`summary differs at ${paths.join(', ')}`);
	// An output by its key, and its node when it has one ("simulated_outflow", "dam_volume at node n1").
	const name = (s: { nodeId: string | null; key: string }) => (s.nodeId === null ? s.key : `${s.key} at hydrological unit ${s.nodeId}`);
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
	return { ok: false, detail: `re-run with engine ${ENGINE_VERSION}: results digest ${again.sha256}, not ${named.resultsSha256}: ${why.join('; ') || 'the digests differ'}.${engineNote}`, fresh };
}

/** A missing cell value and a change with no run read alike: the report writes null for both. */
const cellRun = (c: { change: { run: number | null } | null } | undefined) => c?.change?.run ?? null;

/**
 * The alternatives page 1 assesses (bundle-3, evidence-26), each as
 * `alternative:<n>`: the bundle carries exactly the manifest's assessed
 * alternatives' runs; each one's run, engine and ops hash are the manifest's,
 * its ops are the ones it records and hash to it, it ran on the pack's
 * baseline, and its input is the baseline's with those ops applied (its
 * settings, model and each series); its stored results give the digest
 * bundle.json names; and every page-1 cell that reads its run's summary
 * (alternativeSummaryCell) is what its stored summary gives. With the re-run,
 * `reproduce:alternative:<n>` re-runs its input and compares its digest. A
 * bundle-1 or bundle-2 bundle carries none and adds no check.
 */
async function checkAlternatives(
	index: PackBundleIndex,
	manifest: PackManifest,
	text: ReadonlyMap<string, string>,
	baseline: { snapshot: PackBundleRun['inputs']; input: ModelInput | null; values: Record<string, (number | null)[]> } | null,
	baselineResults: RunResultsFile | null,
	opts: CheckPackBundleOptions,
	add: (id: string, ok: boolean, detail: string) => boolean,
	runEngines: string[]
): Promise<void> {
	if (index.version !== 'bundle-3') return;
	const { hash } = opts;
	const wanted = assessedAlternatives(manifest);
	const named = index.alternatives ?? [];
	const carried = [...text.keys()].filter((k) => k.startsWith('runs/alternative-'));
	if (!wanted.length) {
		if (named.length || carried.length) add('alternatives', false, "the bundle carries an alternative's run the manifest doesn't assess");
		return;
	}
	const identity = manifest.report.identity;
	for (const w of wanted) {
		const id = `alternative:${w.n}`;
		const dir = bundleAlternativeDir(w.n);
		const entry = named.find((x) => x.n === w.n);
		if (!entry || !text.has(`${dir}/input.json`) || !text.has(`${dir}/results.json`)) {
			add(id, false, `page 1 assesses alternative ${w.n} (“${w.label}”), whose run the bundle doesn't carry`);
			continue;
		}
		runEngines.push(entry.engineVersion);
		const snapshot = JSON.parse(text.get(`${dir}/input.json`)!) as PackBundleRun['inputs'];
		const stored = JSON.parse(text.get(`${dir}/results.json`)!) as RunResultsFile;
		const problems: string[] = [];
		if (entry.runId !== w.runId || stored.runId !== w.runId) problems.push(`its run is ${String(entry.runId)}, the manifest names ${w.runId}`);
		if (entry.engineVersion !== w.engineVersion || stored.engineVersion !== w.engineVersion) problems.push(`its engine is ${String(entry.engineVersion)}, the manifest names ${w.engineVersion}`);
		// Its ops: the ones the run recorded, the manifest's, hashing to the hash both name.
		const sc = snapshot.scenario;
		const ops = Array.isArray(sc?.ops) ? (sc!.ops as ScenarioOp[]) : null;
		if (!sc || !ops) problems.push('its input records no scenario ops');
		else {
			const sha = await hash(canonicalJson(ops));
			if (sha !== sc.opsSha256 || sha !== w.opsSha256) problems.push(`its ops hash to ${sha}; the run records ${String(sc.opsSha256)}, the manifest ${w.opsSha256}`);
			if (!sameJson(ops, w.ops)) problems.push("its ops aren't the ones the manifest lists");
			if ((sc as { baseRunId?: string }).baseRunId !== identity.baseline.runId) problems.push(`it ran on base run ${String((sc as { baseRunId?: string }).baseRunId)}, not the pack's baseline ${identity.baseline.runId}`);
		}
		// Its series, each against its hash; then its input against the baseline's with its ops applied.
		const series: Record<string, DailySeries> = {};
		for (const [kind, snap] of Object.entries(snapshot.series ?? {})) {
			if (!snap) continue;
			const csv = snap.valuesSha256 ? text.get(bundleSeriesPath(snap.valuesSha256)) : undefined;
			if (csv === undefined) {
				problems.push(`${kind}: no values file`);
				continue;
			}
			try {
				const parsed = parseSeriesCsv(csv);
				if (parsed.values.length !== snap.length || (snap.length > 0 && parsed.startDate !== snap.startDate)) throw new Error(`it has ${parsed.values.length} days from ${parsed.startDate}, not ${snap.length} from ${snap.startDate}`);
				if ((await hash(seriesDigest(parsed.values))) !== snap.valuesSha256) throw new Error('its values fail their SHA-256 check');
				series[kind] = {
					startDate: snap.startDate,
					values: parsed.values,
					...(snap.provenance !== undefined ? { provenance: snap.provenance } : {}),
					...(snap.origin !== undefined ? { origin: snap.origin } : {}),
					...(typeof snap.seriesId === 'string' ? { seriesId: snap.seriesId } : {})
				};
			} catch (e) {
				problems.push(`${kind}: ${message(e)}`);
			}
		}
		if (!baseline?.input) problems.push("its input can't be checked: the baseline's inputs failed a check above");
		else if (ops) {
			const applied = applyScenario(baseline.input, ops);
			if (applied.problems.length) problems.push(`its ops don't apply to the baseline (${applied.problems.slice(0, 3).join('; ')})`);
			else {
				if (!sameJson(applied.input.settings, snapshot.settings)) problems.push(`its settings aren't the baseline's with its ops applied (${differingPaths(applied.input.settings, snapshot.settings).join(', ')})`);
				if (!sameJson(applied.input.model, snapshot.model)) problems.push(`its model isn't the baseline's with its ops applied (${differingPaths(applied.input.model, snapshot.model).join(', ')})`);
				for (const [kind, s] of Object.entries(applied.input.series)) {
					if (!s) continue;
					const sha = await hash(seriesDigest(s.values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))));
					if (sha !== (snapshot.series?.[kind]?.valuesSha256 ?? null)) problems.push(`its ${kind} series isn't the baseline's with its ops applied`);
				}
			}
		}
		// Its stored results: the digest bundle.json names, and the page-1 cells that read the run's summary.
		if (stored.version !== RUN_RESULTS_VERSION) problems.push(`results.json is version ${String(stored.version)}; this code reads ${RUN_RESULTS_VERSION}`);
		const sha = await hash(runResultsText(stored));
		if (sha !== entry.resultsSha256) problems.push(`its results digest is ${sha}, not the ${entry.resultsSha256} bundle.json names`);
		const i = w.n - 1;
		let cells = 0;
		if (!baselineResults) problems.push("its page-1 cells can't be checked: the baseline's stored results failed a check above");
		else
			for (const row of manifest.report.rows) {
				if (!ALTERNATIVE_SUMMARY_ROWS.has(row.id)) continue;
				const cell = row.alternatives?.[i];
				const want = alternativeSummaryCell(row, baselineResults.summary as RunSummary, stored.summary as RunSummary);
				if (!want) continue;
				cells++;
				if (!sameJson(cell?.value ?? null, want.value) || !sameJson(cellRun(cell), want.run))
					problems.push(`its ${row.id}${row.subject ? ` (${row.subject})` : ''} cell on page 1 is ${String(cell?.value ?? null)} (change ${String(cellRun(cell))}); its stored results give ${String(want.value)} (change ${String(want.run)})`);
			}
		const ok = add(
			id,
			problems.length === 0,
			problems.join('; ') ||
				`alternative ${w.n} (“${w.label}”): run ${w.runId} on the pack's baseline, its ops the manifest's, its input the baseline's with them applied; its ${cells} page-1 cell${cells === 1 ? '' : 's'} read from the run are its stored results'; results digest ${sha}`
		);
		if (!wantsPart(opts, `alternative:${w.n}`)) continue;
		if (!ok || !Object.keys(series).length) {
			add(`reproduce:alternative:${w.n}`, false, 'not re-run: its inputs or stored results failed a check above');
			continue;
		}
		const again = await reproduceRun(bundleRunInput(snapshot, series), stored, entry, hash);
		add(`reproduce:alternative:${w.n}`, again.ok, again.detail);
	}
}
