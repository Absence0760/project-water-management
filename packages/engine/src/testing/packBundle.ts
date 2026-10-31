// A small evidence pack, as the backend hands it to buildPackBundle: real
// engine runs of a synthetic two-node catchment (two years of invented rain,
// one missing day), stored as storeRun stores them, and a manifest whose
// report names both runs and lists their inputs, changes and summaries. For
// the bundle's tests (evidence/bundle.test.ts) and scripts/reproduce-pack's.
// The SHA-256 is the caller's, so this stays free of Node APIs.
import { diffInputs, type RunInputsSnapshot } from '../compare';
import {
	AUTHORISED_PAIR_VERSION,
	authorisedMix,
	authorisedPairBoard,
	authorisedPairInputs,
	buildPackManifest,
	freshResultsDigest,
	localitySection,
	pairKinds,
	RUN_RESULTS_VERSION,
	runAuthorisedPair,
	type AuthorisedPairRecord,
	type EvidenceAuthorisedImpact,
	type PackBundleInput,
	type PackBundleRun
} from '../evidence';
import { applyScenario } from '../scenario/overrides';
import { applicationMask } from '../scenario/applicant';
import { replayAssessment, type BundleAssessmentMember, type BundleAssessmentReport, type PackBundleAssessment } from '../evidence/bundleAssessment';
import type { ScenarioOp } from '../scenario/ops';
import { localityMapSvg } from '../geo/localityMap';
import type { EvidenceAlternative, EvidenceReport, EvidenceRow } from '../evidence/types';
import { alternativeSummaryCell } from '../evidence/report';
import { damObservationsSection, damObservationsSectionV1, type EvidenceDamObservations, type EvidenceDamObservationsAny, type EvidenceDamObservationsV1 } from '../evidence/damObservations';
import { canonicalJson, seriesDigest } from '../manifest';
import type { ModelInput, ModelOutput, NetworkNode, RunSummary } from '../project';
import { Rng } from '../random';
import { runModelChecked } from '../run';
import { ENGINE_VERSION } from '../version';
import { runFutureYield, type FutureFactorCase, type FutureFactorTable, type FutureYieldResult } from '../evidence/future';
import { futureYieldSection } from '../evidence/report';

/** Farm one's dam in § 8's fixture: 200 000 m³ catching half its own runoff. */
export const FUTURE_FIXTURE_DAM: Partial<NetworkNode> = { damCapacityM3: 200_000, damInitialPct: 0.5, pctRunoffToDam: 0.5, damAreaFullM2: 40_000 };

/**
 * An invented factor table (evidence-23): `models` models (SYN-A …), each
 * drier and warmer under SSP5-8.5 and later, whole windows unless `partial`.
 */
export function fixtureFactorTable(models = 3, opts: { partial?: boolean } = {}): FutureFactorTable {
	const cases: FutureFactorCase[] = [];
	for (let i = 0; i < models; i++) {
		const model = `SYN-${String.fromCharCode(65 + i)}`;
		for (const ssp of ['ssp245', 'ssp585'] as const) {
			for (const horizon of ['mid', 'late'] as const) {
				const k = (ssp === 'ssp585' ? 2 : 1) * (horizon === 'late' ? 2 : 1);
				cases.push({
					model,
					ssp,
					horizon,
					rainFactorByMonth: Array.from({ length: 12 }, (_, m) => Math.round((1 - 0.03 * k - 0.01 * i + (m % 3) * 0.01) * 1e4) / 1e4),
					evapFactorByMonth: Array.from({ length: 12 }, (_, m) => Math.round((1 + 0.02 * k + 0.005 * i + (m % 2) * 0.005) * 1e4) / 1e4),
					years: { baseline: opts.partial ? 2 : 30, future: opts.partial ? 1 : 30 },
					warnings: []
				});
			}
		}
	}
	return {
		method: 'delta-1',
		windows: { baseline: { from: 1985, to: 2014 }, mid: { from: 2036, to: 2065 }, late: { from: 2066, to: 2095 } },
		cases,
		sources: [{ product: 'cmip6/SYN-A/historical', revision: 1, files: 6, filesSha256: 'a'.repeat(64), versions: ['v1.0'], licenses: ['CC0 1.0 Universal (synthetic fixture: invented values)'] }],
		citation: 'Synthetic fixture (invented models)',
		licence: 'CC0 1.0'
	};
}

/** § 8 as the report freezes it, for the fixture's two inputs. */
function fixtureFutureSection(base: ModelInput, app: ModelInput, tamper: (r: FutureYieldResult) => FutureYieldResult) {
	const result = tamper(runFutureYield({ baseline: base, application: app, nodeId: 'F1', ownedNodeIds: ['F1'], factors: fixtureFactorTable() }));
	return futureYieldSection({ result, createdAt: '2026-10-29T00:00:00.000Z', createdBy: 'Analyst' });
}

/** SHA-256 hex, synchronous (node:crypto in a test). */
export type SyncHash = (data: string | Uint8Array) => string;

export const PACK_FIXTURE_ID = '00000000-0000-4000-8000-00000000b001';
const START = '2001-10-01';
/** The fixture baseline's last day as the manifest records it (identity.baseline.endDate). */
const END = '2030-01-01';
const OPS = [{ op: 'crop_area', nodeId: 'F1', cropId: 'c', areaM2: 600_000 }];

const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'x',
	name: 'x',
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 0,
	pctUpstreamToDam: 0,
	pctRunoffToDam: 0,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	returnFlowFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

/** The baseline's input: a gauge below one farm, two years of rain with a missing day (null). */
export function packFixtureInput(): ModelInput {
	const rng = new Rng(3);
	const rain: (number | null)[] = Array.from({ length: 2 * 365 }, () => (rng.bool(0.25) ? Math.round(rng.logFloat(0.5, 60) * 10) / 10 : 0));
	rain[40] = null;
	return {
		settings: {
			runoffModel: 'gr4j',
			apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] as never,
			gr4j: { x1: 420, x2: 0, x3: 85, x4: 2.1, warmupDays: 90 },
			ewrPragmaticM3PerDay: new Array(12).fill(5000) as never
		},
		model: {
			nodes: [node({ id: 'G', name: 'Gauge', kind: 'gauge' }), node({ id: 'F1', name: 'Farm one', downstreamNodeId: 'G', areaKm2: 20 })],
			crops: [{ id: 'c', name: 'Maize', cropFactor: new Array(12).fill(0.8) }],
			cropAreas: [{ nodeId: 'F1', cropId: 'c', areaM2: 300_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: rain as number[] } }
	};
}

/** A run as the backend stores it: its input snapshot (model_run.inputs), input values, and its summary and daily outputs through JSON. */
function storedRun(hash: SyncHash, runId: string, input: ModelInput, out: ModelOutput, scenario?: Record<string, unknown>): PackBundleRun {
	const series: RunInputsSnapshot['series'] = {};
	const values: Record<string, (number | null)[]> = {};
	for (const [kind, s] of Object.entries(input.series)) {
		if (!s) continue;
		values[kind] = s.values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
		series[kind] = { startDate: s.startDate, length: s.values.length, valuesSha256: hash(seriesDigest(values[kind]!)), ...(s.seriesId ? { seriesId: s.seriesId } : {}) };
	}
	return {
		runId,
		engineVersion: out.engineVersion,
		startDate: out.startDate,
		inputs: {
			settings: input.settings as RunInputsSnapshot['settings'],
			model: input.model,
			series,
			...(input.seriesChoice ? { seriesChoice: input.seriesChoice } : {}),
			...(scenario ? { scenario } : {})
		},
		values,
		summary: JSON.parse(JSON.stringify(out.summary)),
		series: out.series.map((s) => ({ nodeId: s.nodeId, key: s.key, label: s.label, values: s.values.map((v) => (Number.isFinite(v) ? v : null)) }))
	};
}

/** § 1's locality map of the fixture (evidence-12): an invented boundary, Farm one's parcel, a river and the gauge, with its SVG's SHA-256. */
function fixtureLocality(hash: SyncHash, applicant: boolean, svgSha256?: string) {
	const sq = (lon: number, lat: number, d: number): [number, number][] => [
		[lon, lat],
		[lon + d, lat],
		[lon + d, lat + d],
		[lon, lat + d],
		[lon, lat]
	];
	const at = '2026-09-30T00:00:00.000Z';
	const loc = localitySection(
		[
			{ kind: 'catchment_boundary', name: '', nodeId: null, geometry: { type: 'Polygon', coordinates: [sq(21.3, -33.7, 0.1)] }, updatedAt: at, source: null },
			{ kind: 'farm_parcel', name: '', nodeId: 'F1', geometry: { type: 'Polygon', coordinates: [sq(21.32, -33.68, 0.03)] }, updatedAt: at, source: null },
			{ kind: 'river', name: '', nodeId: null, geometry: { type: 'LineString', coordinates: [[21.3, -33.6], [21.35, -33.65], [21.4, -33.7]] }, updatedAt: at, source: null },
			{ kind: 'gauge', name: '', nodeId: 'G', geometry: { type: 'Point', coordinates: [21.4, -33.7] }, updatedAt: at, source: null }
		],
		{ applicant, ownedNodeIds: ['F1'], ewrSiteNodeIds: [], models: [packFixtureInput().model] }
	)!;
	return { ...loc, svgSha256: svgSha256 ?? hash(localityMapSvg(loc).svg) };
}

/**
 * A pack's bundle input: an application pack (Farm one doubles its maize) by
 * default, or with `application: false` baseline evidence alone. With
 * `locality`, the report carries § 1's locality map (evidence-12) and its
 * SVG's SHA-256, or `locality.svgSha256` in its place (a wrong one).
 */
export function packBundleFixture(
	hash: SyncHash,
	opts: {
		application?: boolean;
		locality?: boolean | { svgSha256: string };
		seriesChoice?: boolean;
		/** § 7: true for evidence-24's (fixtureObservations), or this section (a tampered one, or an older pack's dam-obs-1). */
		observations?: boolean | EvidenceDamObservationsAny;
		/** § 8 (evidence-23): Farm one gets a dam, and the report the future yield of the fixture's factors (or this result, a tampered one). */
		future?: boolean | ((r: FutureYieldResult) => FutureYieldResult);
	} = {}
): PackBundleInput {
	const base = packFixtureInput();
	if (opts.future) base.model.nodes = base.model.nodes.map((n) => (n.id === 'F1' ? { ...n, ...FUTURE_FIXTURE_DAM } : n));
	// Two CHIRPS series, the one read the shorter (engine ≥ 1.90.0, issue #561): its runs warn, and the warning reads input.seriesChoice.
	if (opts.seriesChoice) {
		base.series.rain_chirps_mm = { startDate: START, values: Array.from({ length: 30 }, () => 1) };
		base.seriesChoice = { rain_chirps_mm: { name: 'CHIRPS boundary', others: [{ name: 'Rainfall CHIRPS', firstDay: START, lastDay: '2030-01-01' }] } };
	}
	const baseline = storedRun(hash, '00000000-0000-4000-8000-0000000000a1', base, runModelChecked(structuredClone(base)));
	let application: PackBundleRun | null = null;
	let app: ModelInput | null = null;
	if (opts.application !== false) {
		app = { ...base, model: { ...base.model, cropAreas: base.model.cropAreas.map((a) => ({ ...a, areaM2: 600_000 })) } };
		application = storedRun(hash, '00000000-0000-4000-8000-0000000000a2', app, runModelChecked(structuredClone(app)), {
			id: '00000000-0000-4000-8000-0000000000c1',
			baseRunId: baseline.runId,
			ops: OPS,
			opsSha256: hash(canonicalJson(OPS))
		});
	}
	const listed = (run: PackBundleRun, name: 'baseline' | 'application') =>
		Object.entries(run.inputs.series).map(([kind, s]) => ({ run: name, kind, startDate: s!.startDate, days: s!.length, sha256: s!.valuesSha256 ?? null }));
	const project = { id: '00000000-0000-4000-8000-0000000000f1', name: 'Catchment' };
	// The report as data: only what the bundle's check reads is filled in.
	const report = {
		version: 'evidence-1',
		mode: application ? 'application' : 'baseline',
		identity: {
			title: 'Catchment',
			project,
			baseline: { runId: baseline.runId, engineVersion: baseline.engineVersion, startDate: START, endDate: END },
			application: application
				? { runId: application.runId, engineVersion: application.engineVersion, scenarioId: '00000000-0000-4000-8000-0000000000c1', opsSha256: hash(canonicalJson(OPS)) }
				: null
		},
		issuable: true,
		refused: false,
		appendix: {
			baselineInputs: baseline.inputs,
			changes: application ? diffInputs(baseline.inputs, application.inputs, { a: baseline.values, b: application.values }) : [],
			series: [...listed(baseline, 'baseline'), ...(application ? listed(application, 'application') : [])]
		},
		summaries: { baseline: baseline.summary, application: application?.summary ?? null },
		...(opts.locality ? { builtBy: ENGINE_VERSION, localityMap: fixtureLocality(hash, !!application, typeof opts.locality === 'object' ? opts.locality.svgSha256 : undefined) } : {}),
		...(opts.observations ? { builtBy: ENGINE_VERSION, damObservations: opts.observations === true ? fixtureObservations() : opts.observations } : {}),
		...(opts.future && application ? { builtBy: ENGINE_VERSION, futureYield: fixtureFutureSection(base, app!, opts.future === true ? (r) => r : opts.future) } : {})
	} as unknown as EvidenceReport;
	const manifest = buildPackManifest({ pack: { id: PACK_FIXTURE_ID, version: 1, supersedes: null }, project, report, engine: { version: ENGINE_VERSION, build: null } });
	// As the backend reads it back from jsonb.
	return { manifest: JSON.parse(JSON.stringify(manifest)), baseline, application };
}

/** The invented dam on Farm one and its rows: WOfS (5 dates: 2 wet, 1 dry, 2 inconclusive) and Sentinel-2 (4 dates, 1 shared with WOfS). */
const OBSERVATION_FIXTURE_DAMS = [
	{
		featureId: '00000000-0000-4000-8000-0000000000d1',
		name: 'Farm one dam',
		nodeId: 'F1',
		rows: [
			{ source: 'wofs' as const, date: '2020-01-05', wetAreaM2: 1800, pctObserved: 100 }, // wet
			{ source: 'wofs' as const, date: '2020-01-13', wetAreaM2: 900, pctObserved: 40 }, // one wet pixel: inconclusive
			{ source: 'wofs' as const, date: '2020-01-21', wetAreaM2: 0, pctObserved: 99.5 }, // dry
			{ source: 'wofs' as const, date: '2020-01-29', wetAreaM2: 2700, pctObserved: 30 }, // wet at any clear share
			{ source: 'wofs' as const, date: '2020-02-06', wetAreaM2: 0, pctObserved: 95 }, // no water on a 95 % view: inconclusive
			{ source: 's2' as const, date: '2020-01-10', wetAreaM2: 900, pctObserved: 100 }, // 9 pixels: wet
			{ source: 's2' as const, date: '2020-01-13', wetAreaM2: 0, pctObserved: 100 }, // dry, and takes the date WOfS couldn't call
			{ source: 's2' as const, date: '2020-01-20', wetAreaM2: 500, pctObserved: 20 }, // 5 pixels: inconclusive
			{ source: 's2' as const, date: '2021-02-01', wetAreaM2: 0, pctObserved: 99 } // dry
		]
	}
];

/**
 * Observed wet days (evidence-24, dam-obs-2) of one invented dam on Farm one, as the report freezes them:
 * Sentinel-2 4 dates (1 wet, 2 dry, 1 inconclusive), WOfS 5 (2, 1, 2), together 8 (3 wet, 3 dry, 2 inconclusive).
 */
export function fixtureObservations(): EvidenceDamObservations {
	return damObservationsSection(OBSERVATION_FIXTURE_DAMS, { applicant: true, ownNodeIds: ['F1'], startDate: START, endDate: END, models: [] })!;
}

/** The same dam as a pack drafted from evidence-21 to evidence-23 froze it (dam-obs-1, WOfS alone): 5 dates, 2 wet, 1 dry, 2 inconclusive. */
export function fixtureObservationsV1(): EvidenceDamObservationsV1 {
	return damObservationsSectionV1(OBSERVATION_FIXTURE_DAMS, { applicant: true, ownNodeIds: ['F1'], startDate: START, endDate: END, models: [] })!;
}

/** The headline fixture's registered volumes (synthetic): two takes on Farm one, one storage-only row (s21b, not a take). */
export const HEADLINE_ALLOCATIONS = [
	{ id: '00000000-0000-4000-8000-0000000000e1', nodeId: 'F1', waterSource: 'surface' as const, volumeM3PerYear: 40_000 },
	{ id: '00000000-0000-4000-8000-0000000000e2', nodeId: 'F1', waterSource: 'surface' as const, volumeM3PerYear: 25_000 },
	{ id: '00000000-0000-4000-8000-0000000000e3', nodeId: 'F1', waterSource: 'surface' as const, volumeM3PerYear: 0, storageM3: 9_000, waterUse: '21b' as const }
];
/** How each take was held as at the baseline (synthetic). */
export const HEADLINE_KINDS: Record<string, string> = { '00000000-0000-4000-8000-0000000000e1': 'licence', '00000000-0000-4000-8000-0000000000e2': 'registration' };
const HEADLINE_OPS: ScenarioOp[] = [{ op: 'cropArea.set', nodeId: 'F1', cropId: 'c', areaM2: 600_000 }];

/**
 * An application pack whose page-1 headline board against full authorised use
 * is built and records its pair (evidence-19, issue #523 G2), as the backend
 * builds it: registered volumes on Farm one, a real op (its maize doubled),
 * the pair re-derived from the baseline at full allocation and run, its board,
 * the full mix from the kinds as at the baseline, and the record. With
 * `legacy`, the board is built but carries no record (a board built before).
 */
export async function headlinePackFixture(hash: SyncHash, opts: { legacy?: boolean } = {}): Promise<PackBundleInput> {
	const base: ModelInput = { ...packFixtureInput(), model: { ...packFixtureInput().model, allocations: structuredClone(HEADLINE_ALLOCATIONS) } };
	const baseline = storedRun(hash, '00000000-0000-4000-8000-0000000000a1', base, runModelChecked(structuredClone(base)));
	const appInput = applyScenario(base, HEADLINE_OPS).input;
	const opsSha256 = hash(canonicalJson(HEADLINE_OPS));
	const scenarioId = '00000000-0000-4000-8000-0000000000c1';
	const application = storedRun(hash, '00000000-0000-4000-8000-0000000000a2', appInput, runModelChecked(structuredClone(appInput)), {
		id: scenarioId,
		baseRunId: baseline.runId,
		ops: HEADLINE_OPS,
		opsSha256
	});
	const pair = authorisedPairInputs(base, HEADLINE_OPS);
	const ran = runAuthorisedPair(pair);
	const outcomes = { yearClassMethod: 'auto' as const, siteNodeId: null };
	const board = authorisedPairBoard(pair.baseline, ran.background, ran.application, outcomes);
	const kinds = pairKinds(base, (id) => HEADLINE_KINDS[id]);
	const reproduction: AuthorisedPairRecord = {
		version: AUTHORISED_PAIR_VERSION,
		resultsVersion: RUN_RESULTS_VERSION,
		allocationMode: 'fullAllocation',
		opsSha256,
		baselineResultsSha256: await freshResultsDigest(ran.background, hash),
		applicationResultsSha256: await freshResultsDigest(ran.application, hash),
		...outcomes,
		kinds
	};
	const mix = authorisedMix(kinds.map((k) => ({ volumeM3PerYear: base.model.allocations!.find((a) => a.id === k.allocationId)!.volumeM3PerYear, authorisation: k.authorisation })));
	const authorised: EvidenceAuthorisedImpact = {
		status: 'ok',
		detail: null,
		board,
		mix,
		builtAt: '2026-10-12T00:00:00.000Z',
		engineVersion: ENGINE_VERSION,
		...(opts.legacy ? {} : { reproduction })
	};
	const listed = (run: PackBundleRun, name: 'baseline' | 'application') =>
		Object.entries(run.inputs.series).map(([kind, s]) => ({ run: name, kind, startDate: s!.startDate, days: s!.length, sha256: s!.valuesSha256 ?? null }));
	const project = { id: '00000000-0000-4000-8000-0000000000f1', name: 'Catchment' };
	const report = {
		version: 'evidence-20',
		mode: 'application',
		builtBy: ENGINE_VERSION,
		identity: {
			title: 'Catchment',
			project,
			baseline: { runId: baseline.runId, engineVersion: baseline.engineVersion, startDate: START, endDate: END },
			application: { runId: application.runId, engineVersion: application.engineVersion, scenarioId, opsSha256 }
		},
		issuable: true,
		refused: false,
		appendix: {
			baselineInputs: baseline.inputs,
			changes: diffInputs(baseline.inputs, application.inputs, { a: baseline.values, b: application.values }),
			series: [...listed(baseline, 'baseline'), ...listed(application, 'application')]
		},
		summaries: { baseline: baseline.summary, application: application.summary },
		licenceImpactAuthorised: authorised
	} as unknown as EvidenceReport;
	const manifest = buildPackManifest({ pack: { id: PACK_FIXTURE_ID, version: 1, supersedes: null }, project, report, engine: { version: ENGINE_VERSION, build: null } });
	return { manifest: JSON.parse(JSON.stringify(manifest)), baseline, application };
}

/** The assessment fixture's ids (synthetic). */
export const ASSESSMENT_FIXTURE = {
	id: '00000000-0000-4000-8000-0000000000b9',
	background: '00000000-0000-4000-8000-0000000000a9',
	thisScenario: '00000000-0000-4000-8000-0000000000c1',
	other: '00000000-0000-4000-8000-0000000000c2'
} as const;
const ASSESSMENT_THIS_OPS: ScenarioOp[] = [{ op: 'cropArea.set', nodeId: 'F1', cropId: 'c', areaM2: 600_000 }];
const ASSESSMENT_OTHER_OPS: ScenarioOp[] = [{ op: 'cropArea.set', nodeId: 'F2', cropId: 'c', areaM2: 400_000 }];
const FULL_ALLOCATION_OPS: ScenarioOp[] = [{ op: 'settings.set', path: 'allocationMode', value: 'fullAllocation' }];

/**
 * An application pack whose § 4 combined row reads a cumulative assessment
 * (bundle-3): Farm one (with a dam, and registered volumes) doubles its maize
 * (this application, an applicant's, owning Farm one), Farm two grows more
 * (another applicant's); the assessment's stored report is the engine's own
 * re-run of it (bundleAssessment.ts replayAssessment, with Farm one's dam
 * rows), and with `background` its full-allocation background too. The
 * manifest's combined section is read from that report as report.ts reads it.
 */
export function assessmentPackFixture(hash: SyncHash, opts: { background?: boolean; dams?: number } = {}): PackBundleInput {
	const base = packFixtureInput();
	// With `dams` above 1, more farms with a dam (D2 …), each a little more maize in the other application: more dams touched.
	const extra = Array.from({ length: Math.max(0, (opts.dams ?? 1) - 1) }, (_, i) => `D${i + 2}`);
	base.model.nodes = [
		...base.model.nodes.map((n) => (n.id === 'F1' ? { ...n, ...FUTURE_FIXTURE_DAM } : n)),
		node({ id: 'F2', name: 'Farm two', downstreamNodeId: 'G', areaKm2: 10, sortOrder: 1 }),
		...extra.map((id, i) => node({ id, name: `Dam farm ${id}`, downstreamNodeId: 'G', areaKm2: 5, sortOrder: 2 + i, ...FUTURE_FIXTURE_DAM }))
	];
	base.model.cropAreas = [...base.model.cropAreas, { nodeId: 'F2', cropId: 'c', areaM2: 200_000 }, ...extra.map((nodeId) => ({ nodeId, cropId: 'c', areaM2: 50_000 }))];
	const otherOps: ScenarioOp[] = [...ASSESSMENT_OTHER_OPS, ...extra.map((nodeId) => ({ op: 'cropArea.set' as const, nodeId, cropId: 'c', areaM2: 80_000 }))];
	base.model.allocations = structuredClone(HEADLINE_ALLOCATIONS);
	const baselineOut = runModelChecked(structuredClone(base));
	const baseline = storedRun(hash, '00000000-0000-4000-8000-0000000000a1', base, baselineOut);
	const members: BundleAssessmentMember[] = [
		{ id: ASSESSMENT_FIXTURE.thisScenario, scenarioId: ASSESSMENT_FIXTURE.thisScenario, name: 'Farm one maize', origin: 'applicant', ops: ASSESSMENT_THIS_OPS, opsSha256: hash(canonicalJson(ASSESSMENT_THIS_OPS)), ownedNodeIds: ['F1'] },
		{ id: ASSESSMENT_FIXTURE.other, scenarioId: ASSESSMENT_FIXTURE.other, name: 'Farm two maize', origin: 'applicant', ops: otherOps, opsSha256: hash(canonicalJson(otherOps)), ownedNodeIds: ['F2', ...extra] }
	];
	const appInput = applyScenario(base, ASSESSMENT_THIS_OPS, { mask: applicationMask(base, ['F1']) }).input;
	const application = storedRun(hash, '00000000-0000-4000-8000-0000000000a2', appInput, runModelChecked(structuredClone(appInput)), {
		id: ASSESSMENT_FIXTURE.thisScenario,
		baseRunId: baseline.runId,
		ops: ASSESSMENT_THIS_OPS,
		opsSha256: members[0]!.opsSha256
	});
	const report: BundleAssessmentReport = replayAssessment(base, members, { dams: true, baseline: baselineOut });
	let background: PackBundleAssessment['background'] = null;
	if (opts.background) {
		const bgInput = applyScenario(base, FULL_ALLOCATION_OPS).input;
		const bgRun = storedRun(hash, ASSESSMENT_FIXTURE.background, bgInput, runModelChecked(structuredClone(bgInput)), {
			baseRunId: baseline.runId,
			ops: FULL_ALLOCATION_OPS,
			opsSha256: hash(canonicalJson(FULL_ALLOCATION_OPS))
		});
		background = { runId: bgRun.runId, inputs: bgRun.inputs, values: bgRun.values };
		report.background = {
			label: 'Existing authorised use (full allocation)',
			run: { id: bgRun.runId, label: 'Full allocation' },
			report: replayAssessment(bgInput, members, { dams: false, what: 'At full allocation' })
		};
	}
	const stored = JSON.parse(JSON.stringify(report)) as BundleAssessmentReport;
	const measure = (r: BundleAssessmentReport['rows'][number] | undefined) =>
		r ? { baseline: r.baseline, combined: r.combined, change: r.combinedChange, sumOfSingles: r.sumOfSingles, interaction: r.interaction } : null;
	const outlet = (rows: BundleAssessmentReport['rows'], metric: string) => rows.find((r) => r.metric === metric && r.isOutlet);
	const ewr = outlet(stored.rows, 'ewr_days_not_met');
	const reserve = outlet(stored.rows, 'reserve_months_met');
	const engineVersion = ENGINE_VERSION;
	const combined = {
		applications: members.map((m, i) => ({
			scenarioId: m.scenarioId,
			scenarioName: m.name,
			status: 'submitted',
			outcome: null,
			isThis: i === 0,
			ewrDays: ewr?.singleChanges[i] ?? null,
			reserveMonths: reserve?.singleChanges[i] ?? null
		})),
		assessment: { id: ASSESSMENT_FIXTURE.id, name: 'Both farms', createdAt: '2026-10-30T00:00:00.000Z', createdBy: 'Analyst', engineVersion },
		conflicts: [],
		problems: [],
		ewrDays: measure(ewr),
		reserveMonths: measure(reserve),
		warnings: stored.warnings,
		notAssessed: null,
		dams: (stored.dams?.nodeIds ?? []).map((id) => {
			const row = (metric: string) => stored.rows.find((r) => r.metric === metric && r.siteNodeId === id);
			return { nodeId: id, name: row('dam_firm_yield')!.site, firmYield: measure(row('dam_firm_yield')), reliability: measure(row('dam_reliability')), verdict: { firmYield: null, reliability: null }, onVolumes: stored.dams!.onVolumes };
		}),
		background: stored.background
			? { label: stored.background.label, runLabel: stored.background.run.label, ewrDays: measure(outlet(stored.background.report.rows, 'ewr_days_not_met')), reserveMonths: measure(outlet(stored.background.report.rows, 'reserve_months_met')) }
			: null
	};
	const listed = (run: PackBundleRun, name: 'baseline' | 'application') =>
		Object.entries(run.inputs.series).map(([kind, s]) => ({ run: name, kind, startDate: s!.startDate, days: s!.length, sha256: s!.valuesSha256 ?? null }));
	const project = { id: '00000000-0000-4000-8000-0000000000f1', name: 'Catchment' };
	const evidence = {
		version: 'evidence-26',
		mode: 'application',
		builtBy: ENGINE_VERSION,
		identity: {
			title: 'Catchment',
			project,
			baseline: { runId: baseline.runId, engineVersion: baseline.engineVersion, startDate: START, endDate: END },
			application: { runId: application.runId, engineVersion: application.engineVersion, scenarioId: ASSESSMENT_FIXTURE.thisScenario, opsSha256: members[0]!.opsSha256 }
		},
		issuable: true,
		refused: false,
		appendix: {
			baselineInputs: baseline.inputs,
			changes: diffInputs(baseline.inputs, application.inputs, { a: baseline.values, b: application.values }),
			series: [...listed(baseline, 'baseline'), ...listed(application, 'application')]
		},
		summaries: { baseline: baseline.summary, application: application.summary },
		cumulative: { applications: [], combined, counted: 0, truncated: false, total: { ewrDays: null, reservePp: null }, withThis: null }
	} as unknown as EvidenceReport;
	const manifest = buildPackManifest({ pack: { id: PACK_FIXTURE_ID, version: 1, supersedes: null }, project, report: evidence, engine: { version: ENGINE_VERSION, build: null } });
	return {
		manifest: JSON.parse(JSON.stringify(manifest)),
		baseline,
		application,
		assessment: {
			id: ASSESSMENT_FIXTURE.id,
			name: 'Both farms',
			engineVersion,
			baseRunId: baseline.runId,
			backgroundRunId: background?.runId ?? null,
			members,
			report: stored,
			background
		}
	};
}

/** The alternatives fixture's runs (synthetic): Farm one's maize at 450 000 m² and at 500 000 m² instead of the application's 600 000. */
export const ALTERNATIVE_FIXTURE_AREAS = [450_000, 500_000] as const;

/**
 * An application pack whose page 1 sets mitigation alternatives beside it
 * (evidence-26, 298_scenario_alternatives; bundle-3): the default pack, and
 * `count` (1 or 2) alternatives, each a scenario run of the baseline with its
 * own ops (Farm one's maize at a smaller area), and page-1 rows whose
 * alternative cells read the runs' summaries as report.ts does
 * (alternativeSummaryCell). With `unassessed`, the last alternative's column
 * is not assessed (another baseline), so the bundle carries no run of it.
 */
export function alternativesPackFixture(hash: SyncHash, opts: { count?: number; unassessed?: boolean } = {}): PackBundleInput {
	const p = packBundleFixture(hash);
	const base = packFixtureInput();
	const runs: PackBundleRun[] = [];
	const listed: EvidenceAlternative[] = [];
	ALTERNATIVE_FIXTURE_AREAS.slice(0, opts.count ?? 1).forEach((areaM2, i) => {
		const ops: ScenarioOp[] = [{ op: 'cropArea.set', nodeId: 'F1', cropId: 'c', areaM2 }];
		const input = applyScenario(base, ops).input;
		const scenarioId = `00000000-0000-4000-8000-0000000000d${i + 1}`;
		const run = storedRun(hash, `00000000-0000-4000-8000-0000000000b${i + 1}`, input, runModelChecked(structuredClone(input)), {
			id: scenarioId,
			baseRunId: p.baseline.runId,
			ops,
			opsSha256: hash(canonicalJson(ops))
		});
		const unassessed = opts.unassessed && i === (opts.count ?? 1) - 1;
		if (!unassessed) runs.push(run);
		listed.push({
			label: `Smaller field ${i + 1}`,
			runId: run.runId,
			runLabel: '',
			engineVersion: run.engineVersion,
			createdAt: '2026-10-30T00:00:00.000Z',
			createdBy: 'Applicant',
			scenarioId,
			scenarioName: `Smaller field ${i + 1}`,
			opsSha256: hash(canonicalJson(ops)),
			ops: ops.map((op, index) => ({ index, class: 'proposal' as const, op })),
			proposals: 1,
			assumptions: 0,
			allocationMode: null,
			pairedId: null,
			notAssessed: unassessed ? 'Not assessed: this alternative ran on another baseline than the application.' : null
		});
	});
	const report = structuredClone(p.manifest.report) as EvidenceReport;
	const baseSummary = p.baseline.summary as RunSummary;
	const appSummary = p.application!.summary as RunSummary;
	const subjects: { id: EvidenceRow['id']; subject: string | null }[] = [
		...(baseSummary.ewrAssurance ?? []).map((s) => ({ id: 'reserve' as const, subject: s.name })),
		{ id: 'ewrDays', subject: null },
		{ id: 'shortfall', subject: null },
		{ id: 'noFlowDays', subject: null },
		{ id: 'outflowMar', subject: null },
		{ id: 'applicantSupply', subject: null }
	];
	report.alternatives = listed;
	report.rows = subjects.map(({ id, subject }): EvidenceRow => {
		const app = alternativeSummaryCell({ id, subject }, baseSummary, appSummary);
		return {
			id,
			label: id,
			basis: '',
			subject,
			unit: '',
			higherIsWorse: true,
			baseline: null,
			application: app?.value ?? null,
			change: app ? { run: app.run, band: null, bandNote: 'no band', worse: null } : null,
			notAssessed: null,
			note: null,
			alternatives: listed.map((alt) => {
				if (alt.notAssessed) return { value: null, change: null, notAssessed: alt.notAssessed, note: null };
				const run = runs.find((r) => r.runId === alt.runId)!;
				// A row that reads more than the summary (the applicant's own supply): an invented value the check leaves alone.
				const c = alternativeSummaryCell({ id, subject }, baseSummary, run.summary as RunSummary) ?? { value: 42, run: 1 };
				return { value: c.value, change: { run: c.run, band: null, bandNote: 'no band', worse: null }, notAssessed: null, note: null };
			})
		};
	});
	const project = { id: '00000000-0000-4000-8000-0000000000f1', name: 'Catchment' };
	const manifest = buildPackManifest({ pack: { id: PACK_FIXTURE_ID, version: 1, supersedes: null }, project, report, engine: { version: ENGINE_VERSION, build: null } });
	return { ...p, manifest: JSON.parse(JSON.stringify(manifest)), alternatives: runs };
}
