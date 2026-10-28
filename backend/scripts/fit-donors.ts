// Fit GR4J to GRDC-Caravan's gauged basins on the app's own forcing, for the
// regional prior's donor set (issue #622 step 3; docs/model.md §2.10m,
// docs/deployment.md § Reference datasets, GR4J donors). Operator-run and
// offline, never by the app:
//
//   pnpm fit-donors --caravan <dir> --basins <basins.geojson> --out <donors.json[.gz]>
//       [--from 1981-01-01] [--to YYYY-MM-DD] [--product sat|rnl]
//       [--evaporation <dataset>] [--soils <dataset>] [--max-area <km²>]
//       [--only <id,…>] [--budget 1500] [--starts 5] [--seed 1]
//
//  --caravan  the unzipped GRDC_Caravan_extension_csv/ (Zenodo
//             10.5281/zenodo.15349031): attributes/grdc/attributes_other_grdc.csv
//             (outlet, area, country), attributes_hydroatlas_grdc.csv
//             (HydroATLAS's attributes) and timeseries/csv/grdc/<id>.csv
//             (the daily `streamflow`, mm/day; its ERA5-Land forcing is never read);
//  --basins   the basins' polygons as GeoJSON with a `gauge_id` property:
//             `ogr2ogr -f GeoJSON basins.geojson shapefiles/grdc/<file>.shp`.
//
// A donor (issue #622): a basin whose outlet is in region D1 (the copy's,
// mirror/grid.ts MIRROR_REGION), with under DONOR_MAX_DOR_PCT % upstream
// regulation (HydroATLAS dor_pc_pva, stored × 10), at most --max-area km²
// (default 10 000: a lumped GR4J over a larger basin says little about a
// catchment the app models), and at least DONOR_MIN_FLOW_YEARS of observed
// flow inside the window. Each is fitted with the engine's own calibrate()
// (KGE′, the typical bounds, x2 fixed at 0, the split-sample test run) on:
//
//  - rain: the area-weighted mean of the CHIRPS v3 cells the polygon covers
//    (each 0.05° cell by its area × the share inside, geo/gridShares.ts),
//    read from our rain data copy (MIRROR_URL), final days only, a cell with
//    no value (the sea) left out of the day's mean;
//  - PE: the evaporation grid's dPET monthly means over the polygon
//    (geo/evaporation.ts, the PE row Settings proposes), as settings.pe;
//  - never Caravan's ERA5-Land forcing: parameters absorb forcing bias
//    (especially x1), so a donor fitted on other rain would carry that bias
//    into every prior built from it.
//
// The soil grid's PAWC over the polygon is recorded when one is loaded
// (--soils, default the newest real one), for the soil x1 relation. The
// file holds only what was fitted (no flow), in the form
// geo/gr4jDonors.ts reads; refused basins are printed with their reason.
// It reads this checkout's database (MIGRATION_DATABASE_URL) for the grids.
import { loadDevEnv } from '../src/config/devEnv.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
	calibrate,
	ENGINE_VERSION,
	fromEpochDay,
	toEpochDay,
	type CalibrationReport,
	type Gr4jParams,
	type ModelInput,
	type NetworkNode
} from '@water-management/engine';
import pg from 'pg';
import { chcCell, decodeCellValue, type GridCell } from '../src/feeds/cellCache.js';
import { CHIRPS_CELL_DEG } from '../src/feeds/config.js';
import { evaporationDatasets, summariseEvaporation } from '../src/geo/evaporation.js';
import type { Geometry } from '../src/geo/geojson.js';
import { DONOR_MAX_DOR_PCT, DONOR_MIN_FLOW_YEARS, donorsToJson, GR4J_DONORS, type DonorRecord } from '../src/geo/gr4jDonors.js';
import { cellAreaM2, gridShares } from '../src/geo/gridShares.js';
import { soilDatasets, summariseSoil } from '../src/geo/soilGrid.js';
import { MIRROR_REGION, type Region } from '../src/mirror/grid.js';
import { readCells } from '../src/mirror/readCells.js';
import { mirrorStore } from '../src/mirror/source.js';
import type { MirrorStore } from '../src/mirror/store.js';

// ---------------------------------------------------------------------------
// Caravan's files
// ---------------------------------------------------------------------------

/** A CSV's rows as objects by header (quoted fields with commas and doubled quotes allowed). */
export function parseCsv(text: string): Record<string, string>[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else field += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') {
			row.push(field);
			field = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			field = '';
			if (row.length > 1 || row[0] !== '') rows.push(row);
			row = [];
		} else field += ch;
	}
	if (field !== '' || row.length) {
		row.push(field);
		rows.push(row);
	}
	const [head, ...body] = rows;
	if (!head) return [];
	return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** A basin as Caravan's attribute files describe it, in the donor's units. */
export interface CaravanBasin {
	id: string;
	lon: number;
	lat: number;
	areaKm2: number;
	country: string;
	attributes: DonorRecord['attributes'];
	/** dor_pc_pva ÷ 10, %; null when not given. */
	dorPct: number | null;
}

/** A HydroATLAS value: a number ≥ 0 (its no-data is −999 and the like), else null. */
const atlas = (v: string | undefined, scale = 1): number | null => {
	if (v === undefined || v.trim() === '') return null;
	const x = Number(v);
	return Number.isFinite(x) && x >= 0 ? x / scale : null;
};

/**
 * The basins of attributes_other_grdc.csv joined with
 * attributes_hydroatlas_grdc.csv by gauge_id. HydroATLAS's scaled integers are
 * converted: ari_ix_sav ÷ 100 (P/PET), slp_dg_sav ÷ 10 (degrees), dor_pc_pva ÷
 * 10 (%) (the BasinATLAS Catalog v1.0: "percent values are multiplied by
 * 10", and the same for slope; aridity × 100); cly_pc_sav, snd_pc_sav,
 * for_pc_sse (%) and pre_mm_syr (mm) as they are.
 */
export function caravanBasins(otherCsv: string, hydroatlasCsv: string): CaravanBasin[] {
	const atlasById = new Map(parseCsv(hydroatlasCsv).map((r) => [r.gauge_id!, r]));
	const out: CaravanBasin[] = [];
	for (const r of parseCsv(otherCsv)) {
		const id = r.gauge_id ?? '';
		const lon = Number(r.gauge_lon);
		const lat = Number(r.gauge_lat);
		const areaKm2 = Number(r.area);
		if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !Number.isFinite(lon) || !Number.isFinite(lat) || !(areaKm2 > 0)) continue;
		const h = atlasById.get(id) ?? {};
		const aridity = atlas(h.ari_ix_sav, 100);
		out.push({
			id,
			lon,
			lat,
			areaKm2,
			country: r.country ?? '',
			attributes: {
				aridity,
				mapMm: atlas(h.pre_mm_syr),
				slopeDeg: atlas(h.slp_dg_sav, 10),
				clayPct: atlas(h.cly_pc_sav),
				sandPct: atlas(h.snd_pc_sav),
				forestPct: atlas(h.for_pc_sse)
			},
			dorPct: atlas(h.dor_pc_pva, 10)
		});
	}
	return out;
}

export interface Selection {
	kept: CaravanBasin[];
	refused: { id: string; reason: string }[];
}

/** The basins that may be donors before any flow is read: outlet in the region, regulation under 5 %, area at most `maxAreaKm2`. */
export function selectCandidates(basins: readonly CaravanBasin[], opts: { region?: Region; maxAreaKm2?: number; only?: ReadonlySet<string> | null } = {}): Selection {
	const region = opts.region ?? MIRROR_REGION;
	const maxArea = opts.maxAreaKm2 ?? DEFAULT_MAX_AREA_KM2;
	const kept: CaravanBasin[] = [];
	const refused: Selection['refused'] = [];
	for (const b of basins) {
		if (opts.only && !opts.only.has(b.id)) continue;
		if (!(b.lon >= region.w && b.lon <= region.e && b.lat >= region.s && b.lat <= region.n)) continue;
		if (b.dorPct === null) refused.push({ id: b.id, reason: 'no degree of regulation (dor_pc_pva)' });
		else if (!(b.dorPct < DONOR_MAX_DOR_PCT)) refused.push({ id: b.id, reason: `regulated: ${b.dorPct.toFixed(1)} % (a donor is under ${DONOR_MAX_DOR_PCT} %)` });
		else if (b.areaKm2 > maxArea) refused.push({ id: b.id, reason: `${Math.round(b.areaKm2)} km², over --max-area ${maxArea}` });
		else kept.push(b);
	}
	return { kept, refused };
}

export const DEFAULT_MAX_AREA_KM2 = 10_000;

/** A Caravan timeseries file's `streamflow` (mm/day; empty = no value) from its first date. Refuses a gap in the dates. */
export function streamflowFromCsv(text: string): { startDate: string; mmPerDay: (number | null)[] } {
	const rows = parseCsv(text);
	if (!rows.length || !('streamflow' in rows[0]!) || !('date' in rows[0]!)) throw new Error('no date and streamflow columns');
	const startDate = rows[0]!.date!;
	const e0 = toEpochDay(startDate);
	const mmPerDay = rows.map((r, i) => {
		if (toEpochDay(r.date!) !== e0 + i) throw new Error(`the dates jump at ${r.date}`);
		const v = r.streamflow!.trim() === '' ? null : Number(r.streamflow);
		return v !== null && Number.isFinite(v) && v >= 0 ? v : null;
	});
	return { startDate, mmPerDay };
}

// ---------------------------------------------------------------------------
// Our forcing
// ---------------------------------------------------------------------------

/** The CHIRPS cells a polygon covers and each one's weight (its area on the ellipsoid × the share inside). */
export function basinCells(g: Geometry, maxCells = 20_000): { cells: GridCell[]; weights: number[] } | { problem: string } {
	// CHC's 0.05° grid has its corners on multiples of 0.05 (from −180, 60), so the grid frame is the degree frame.
	const shares = gridShares(g, CHIRPS_CELL_DEG, maxCells, undefined, 'CHIRPS');
	if ('problem' in shares) return shares;
	const cells: GridCell[] = [];
	const weights: number[] = [];
	for (const s of shares.cells) {
		const west = s.col * CHIRPS_CELL_DEG;
		const south = s.row * CHIRPS_CELL_DEG;
		cells.push(chcCell(south + CHIRPS_CELL_DEG / 2, west + CHIRPS_CELL_DEG / 2));
		weights.push(cellAreaM2(west, south, CHIRPS_CELL_DEG) * s.share);
	}
	if (!cells.length) return { problem: 'the polygon covers no CHIRPS cell' };
	return { cells, weights };
}

/**
 * Each day's area-weighted mean over the cells, from a readCells answer: a
 * day not read as final is null (the series ends before it), a cell with no
 * value (NaN, the sea) is left out of that day's mean, and a day no cell has
 * a value for is null.
 */
export function arealRain(read: string, values: readonly (readonly (number | null)[])[], weights: readonly number[]): (number | null)[] {
	return [...read].map((r, i) => {
		if (r !== 'f') return null;
		let sum = 0;
		let w = 0;
		for (let c = 0; c < values.length; c++) {
			const v = decodeCellValue(values[c]![i] ?? null);
			if (v === null || Number.isNaN(v)) continue;
			sum += weights[c]! * v;
			w += weights[c]!;
		}
		return w > 0 ? sum / w : null;
	});
}

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

/**
 * A donor as the engine models it: one land unit of the basin's area (no
 * crops, no dam) draining to its gauge, so the simulated outflow is GR4J's
 * natural flow; the observed record is Caravan's streamflow in m³/s
 * (mm/day × km² × 1000 ÷ 86 400); PE the monthly row, Oct … Sep.
 */
export function donorInput(opts: { startDate: string; rainMm: (number | null)[]; flowMmPerDay: (number | null)[]; peMonthlyMm: number[]; areaKm2: number; peSource: string }): ModelInput {
	const toM3s = (opts.areaKm2 * 1000) / 86_400;
	return {
		settings: {
			runoffModel: 'gr4j',
			apanMm: opts.peMonthlyMm as never,
			pe: { kind: 'monthly', mm: opts.peMonthlyMm as never, source: opts.peSource.slice(0, 600) },
			gr4j: { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 }
		},
		model: {
			nodes: [node({ id: 'G', name: 'Gauge', kind: 'gauge' }), node({ id: 'B', name: 'Basin', downstreamNodeId: 'G', areaKm2: opts.areaKm2 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: opts.startDate, values: opts.rainMm },
			flow_observed_m3s: { startDate: opts.startDate, values: opts.flowMmPerDay.map((q) => (q === null ? null : q * toM3s)) }
		}
	} as ModelInput;
}

/** Observed days ÷ 365.25. */
export const flowYears = (flow: readonly (number | null)[]): number => flow.filter((q) => q !== null).length / 365.25;

export interface FitOptions {
	budget?: number;
	starts?: number;
	seed?: number;
}

/** The engine's own fit of one donor: KGE′, typical bounds, x2 fixed (calibrate's default free set). */
export function fitDonor(input: ModelInput, opts: FitOptions = {}): { params: Gr4jParams; kgeFit: number | null; kgeValidation: number | null; report: CalibrationReport } {
	const report = calibrate(input, { objective: 'kgePrime', bounds: 'typical', budget: opts.budget ?? 1500, starts: opts.starts ?? 5, seed: opts.seed ?? 1, validate: true });
	const p = report.params;
	return {
		params: { x1: p.x1!, x2: p.x2 ?? 0, x3: p.x3!, x4: p.x4! },
		kgeFit: report.fit.scores.kgePrime,
		kgeValidation: report.splitSample?.validation.scores.kgePrime ?? null,
		report
	};
}

/** The fit's method in words, stored with the set. */
export function fitMethod(o: { product: string; from: string; to: string; evaporation: string; budget: number; starts: number; seed: number; maxAreaKm2: number }): string {
	return (
		`GR4J (engine ${ENGINE_VERSION}) calibrated per basin with calibrate(): KGE′, Perrin’s typical bounds, x2 fixed at 0, ${o.starts} starts of ${o.budget} runs, seed ${o.seed}. ` +
		`Rain: CHIRPS v3 ${o.product} from our copy, area-weighted over the basin, ${o.from} to ${o.to} (final days only). PE: the evaporation grid “${o.evaporation}” (dPET monthly means) over the basin. ` +
		`Donors: GRDC-Caravan basins in region D1 with at least ${DONOR_MIN_FLOW_YEARS} years of flow in that window, under ${DONOR_MAX_DOR_PCT} % regulation (HydroATLAS dor_pc_pva) and at most ${o.maxAreaKm2} km². Caravan’s ERA5-Land forcing is not used.`
	);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface FitDonorsArgs {
	caravan: string;
	basins: string;
	out: string;
	from: string;
	to: string | null;
	product: 'sat' | 'rnl';
	evaporation: string | null;
	soils: string | null;
	maxAreaKm2: number;
	only: Set<string> | null;
	budget: number;
	starts: number;
	seed: number;
}

const FLAGS = ['--caravan', '--basins', '--out', '--from', '--to', '--product', '--evaporation', '--soils', '--max-area', '--only', '--budget', '--starts', '--seed'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseFitDonorsArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): FitDonorsArgs | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const unknown = argv.find((a) => a.startsWith('--') && !FLAGS.includes(a));
	if (unknown) return `unknown option ${unknown}`;
	const path = (p: string) => resolve(env.INIT_CWD ?? process.cwd(), p);
	const caravan = flag('--caravan');
	const basins = flag('--basins');
	const out = flag('--out');
	if (!caravan) return 'give the unzipped GRDC_Caravan_extension_csv directory with --caravan';
	if (!basins) return 'give the basins’ polygons as GeoJSON with --basins (ogr2ogr -f GeoJSON from shapefiles/grdc/)';
	if (!out || !/\.json(\.gz)?$/i.test(out)) return 'give the donor file to write with --out (.json or .json.gz)';
	const from = flag('--from') ?? '1981-01-01';
	const to = flag('--to');
	if (!ISO.test(from) || (to !== null && (!ISO.test(to) || to < from))) return '--from and --to are YYYY-MM-DD, --to not before --from';
	const product = flag('--product') ?? 'sat';
	if (product !== 'sat' && product !== 'rnl') return '--product is sat or rnl (the copy’s CHIRPS v3 finals)';
	const int = (name: string, dflt: number, lo: number, hi: number) => {
		const v = flag(name);
		if (v === null) return dflt;
		const n = Number(v);
		return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
	};
	const budget = int('--budget', 1500, 100, 100_000);
	const starts = int('--starts', 5, 1, 10);
	const seed = int('--seed', 1, 0, 2 ** 31 - 1);
	const maxAreaKm2 = int('--max-area', DEFAULT_MAX_AREA_KM2, 1, 1_000_000);
	if (budget === null || starts === null || seed === null || maxAreaKm2 === null) return '--budget (100–100000), --starts (1–10), --seed and --max-area (km²) are whole numbers';
	const onlyText = flag('--only');
	const only = onlyText === null ? null : new Set(onlyText.split(',').map((s) => s.trim()).filter(Boolean));
	return { caravan: path(caravan), basins: path(basins), out: path(out), from, to, product, evaporation: flag('--evaporation'), soils: flag('--soils'), maxAreaKm2, only, budget, starts, seed };
}

/** The polygons of a GeoJSON FeatureCollection by their gauge_id. */
export function basinPolygons(doc: unknown): Map<string, Geometry> {
	const out = new Map<string, Geometry>();
	const features = (doc as { features?: unknown[] })?.features;
	for (const f of Array.isArray(features) ? features : []) {
		const ft = f as { properties?: Record<string, unknown>; geometry?: Geometry };
		const id = ft.properties?.gauge_id;
		if (typeof id === 'string' && (ft.geometry?.type === 'Polygon' || ft.geometry?.type === 'MultiPolygon')) out.set(id, ft.geometry);
	}
	return out;
}

/** One basin's rain over the window from the copy, trimmed to its final days. */
export async function basinRain(store: MirrorStore, product: 'sat' | 'rnl', g: Geometry, window: { start: string; end: string }): Promise<{ startDate: string; rainMm: (number | null)[] } | { problem: string }> {
	const cells = basinCells(g);
	if ('problem' in cells) return cells;
	const got = await readCells(store, product, cells.cells, window);
	const rain = arealRain(got.cells.read, got.cells.values, cells.weights);
	const first = rain.findIndex((v) => v !== null);
	if (first < 0) return { problem: 'the copy holds no final day of the window over it' };
	let last = rain.length - 1;
	while (rain[last] === null) last--;
	return { startDate: fromEpochDay(toEpochDay(window.start) + first), rainMm: rain.slice(first, last + 1) };
}

/** The flow over [startDate, startDate + days), null outside the record. */
export function flowOver(flow: { startDate: string; mmPerDay: (number | null)[] }, startDate: string, days: number): (number | null)[] {
	const off = toEpochDay(startDate) - toEpochDay(flow.startDate);
	return Array.from({ length: days }, (_, i) => flow.mmPerDay[off + i] ?? null);
}

async function run(args: FitDonorsArgs, url: string): Promise<void> {
	const dir = args.caravan;
	const basins = caravanBasins(
		readFileSync(join(dir, 'attributes/grdc/attributes_other_grdc.csv'), 'utf8'),
		readFileSync(join(dir, 'attributes/grdc/attributes_hydroatlas_grdc.csv'), 'utf8')
	);
	const { kept, refused } = selectCandidates(basins, { maxAreaKm2: args.maxAreaKm2, only: args.only });
	const polygons = basinPolygons(JSON.parse(readFileSync(args.basins, 'utf8')));
	const store = mirrorStore();
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const evap = (await evaporationDatasets(client as never)).filter((d) => d.kind === 'et0' && (args.evaporation ? d.dataset === args.evaporation : !d.synthetic))[0];
		if (!evap) throw new Error(args.evaporation ? `no reference-ET evaporation dataset "${args.evaporation}" is loaded` : 'no real reference-ET evaporation grid (dPET) is loaded: pnpm import:evaporation first, or name one with --evaporation');
		const soil = (await soilDatasets(client)).filter((d) => (args.soils ? d.dataset === args.soils : !d.synthetic))[0] ?? null;
		if (args.soils && !soil) throw new Error(`no soil grid "${args.soils}" is loaded`);
		const to = args.to ?? fromEpochDay(Math.floor(Date.now() / 86_400_000));
		const donors: DonorRecord[] = [];
		for (const [i, b] of kept.entries()) {
			const say = (m: string) => console.error(`[${i + 1}/${kept.length}] ${b.id}: ${m}`);
			const g = polygons.get(b.id);
			if (!g) {
				refused.push({ id: b.id, reason: 'no polygon in --basins' });
				continue;
			}
			const flow = streamflowFromCsv(readFileSync(join(dir, `timeseries/csv/grdc/${b.id}.csv`), 'utf8'));
			const rain = await basinRain(store, args.product, g, { start: args.from, end: to });
			if ('problem' in rain) {
				refused.push({ id: b.id, reason: rain.problem });
				continue;
			}
			const q = flowOver(flow, rain.startDate, rain.rainMm.length);
			const years = flowYears(q);
			if (years < DONOR_MIN_FLOW_YEARS) {
				refused.push({ id: b.id, reason: `${years.toFixed(1)} years of flow in the window (a donor has ${DONOR_MIN_FLOW_YEARS})` });
				continue;
			}
			const pe = await summariseEvaporation(client as never, evap, g);
			if ('problem' in pe) {
				refused.push({ id: b.id, reason: `PE: ${pe.problem}` });
				continue;
			}
			const pawc = soil ? await summariseSoil(client, soil, g) : null;
			say(`fitting on ${years.toFixed(1)} years`);
			const fit = fitDonor(donorInput({ startDate: rain.startDate, rainMm: rain.rainMm, flowMmPerDay: q, peMonthlyMm: pe.monthlyMm, areaKm2: b.areaKm2, peSource: evap.source }), args);
			if (fit.kgeFit === null) {
				refused.push({ id: b.id, reason: 'the fit has no KGE′ (too few scored days)' });
				continue;
			}
			donors.push({
				id: b.id,
				lon: b.lon,
				lat: b.lat,
				areaKm2: b.areaKm2,
				attributes: b.attributes,
				dorPct: b.dorPct!,
				pawcMm: pawc && !('problem' in pawc) ? pawc.pawcMm : null,
				flowYears: Math.round(years * 100) / 100,
				params: fit.params,
				kgeFit: fit.kgeFit,
				kgeValidation: fit.kgeValidation
			});
			say(`x1 ${fit.params.x1.toFixed(0)}, x3 ${fit.params.x3.toFixed(0)}, x4 ${fit.params.x4.toFixed(2)}, KGE′ ${fit.kgeFit.toFixed(2)}`);
		}
		const meta = {
			source: `GRDC-Caravan v0.6 daily streamflow (Zenodo 10.5281/zenodo.15349031) and HydroATLAS v1.0 attributes; GR4J fitted on CHIRPS v3 (${args.product}, our copy) and ${evap.dataset} PE`,
			version: `GRDC-Caravan 0.6; HydroATLAS 1.0; engine ${ENGINE_VERSION}`,
			method: fitMethod({ product: args.product, from: args.from, to, evaporation: evap.dataset, budget: args.budget, starts: args.starts, seed: args.seed, maxAreaKm2: args.maxAreaKm2 }),
			attribution: GR4J_DONORS.attribution,
			engineVersion: ENGINE_VERSION
		};
		const json = donorsToJson(meta, donors);
		writeFileSync(args.out, /\.gz$/i.test(args.out) ? gzipSync(json) : json);
		for (const r of refused) console.log(`refused ${r.id}: ${r.reason}`);
		console.log(`${donors.length} donor(s) written to ${args.out}; ${refused.length} basin(s) in the region refused`);
	} finally {
		await client.end();
	}
}

const USAGE =
	'usage: pnpm fit-donors --caravan <dir> --basins <basins.geojson> --out <donors.json[.gz]> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--product sat|rnl] [--evaporation <dataset>] [--soils <dataset>] [--max-area <km²>] [--only <id,…>] [--budget n] [--starts n] [--seed n]';

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const args = parseFitDonorsArgs(process.argv.slice(2));
	if (typeof args === 'string') {
		console.error(`${args}\n${USAGE}`);
		process.exit(2);
	}
	const url = process.env.MIGRATION_DATABASE_URL;
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	run(args, url).then(
		() => process.exit(0),
		(err: Error) => {
			console.error(err.message);
			process.exit(1);
		}
	);
}
