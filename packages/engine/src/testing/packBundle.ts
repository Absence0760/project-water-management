// A small evidence pack, as the backend hands it to buildPackBundle: real
// engine runs of a synthetic two-node catchment (two years of invented rain,
// one missing day), stored as storeRun stores them, and a manifest whose
// report names both runs and lists their inputs, changes and summaries. For
// the bundle's tests (evidence/bundle.test.ts) and scripts/reproduce-pack's.
// The SHA-256 is the caller's, so this stays free of Node APIs.
import { diffInputs, type RunInputsSnapshot } from '../compare';
import { buildPackManifest, localitySection, type PackBundleInput, type PackBundleRun } from '../evidence';
import { localityMapSvg } from '../geo/localityMap';
import type { EvidenceReport } from '../evidence/types';
import { canonicalJson, seriesDigest } from '../manifest';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModelChecked } from '../run';
import { ENGINE_VERSION } from '../version';

/** SHA-256 hex, synchronous (node:crypto in a test). */
export type SyncHash = (data: string | Uint8Array) => string;

export const PACK_FIXTURE_ID = '00000000-0000-4000-8000-00000000b001';
const START = '2001-10-01';
const OPS = [{ op: 'crop_area', nodeId: 'F1', cropId: 'c', areaM2: 600_000 }];

const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'x',
	name: 'x',
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 0,
	areaHiKm2: 0,
	areaLoKm2: 0,
	flowShareManual: null,
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
		series[kind] = { startDate: s.startDate, length: s.values.length, valuesSha256: hash(seriesDigest(values[kind]!)) };
	}
	return {
		runId,
		engineVersion: out.engineVersion,
		startDate: out.startDate,
		inputs: { settings: input.settings as RunInputsSnapshot['settings'], model: input.model, series, ...(scenario ? { scenario } : {}) },
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
export function packBundleFixture(hash: SyncHash, opts: { application?: boolean; locality?: boolean | { svgSha256: string } } = {}): PackBundleInput {
	const base = packFixtureInput();
	const baseline = storedRun(hash, '00000000-0000-4000-8000-0000000000a1', base, runModelChecked(structuredClone(base)));
	let application: PackBundleRun | null = null;
	if (opts.application !== false) {
		const app: ModelInput = { ...base, model: { ...base.model, cropAreas: base.model.cropAreas.map((a) => ({ ...a, areaM2: 600_000 })) } };
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
			baseline: { runId: baseline.runId, engineVersion: baseline.engineVersion },
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
		...(opts.locality ? { builtBy: ENGINE_VERSION, localityMap: fixtureLocality(hash, !!application, typeof opts.locality === 'object' ? opts.locality.svgSha256 : undefined) } : {})
	} as unknown as EvidenceReport;
	const manifest = buildPackManifest({ pack: { id: PACK_FIXTURE_ID, version: 1, supersedes: null }, project, report, engine: { version: ENGINE_VERSION, build: null } });
	// As the backend reads it back from jsonb.
	return { manifest: JSON.parse(JSON.stringify(manifest)), baseline, application };
}
