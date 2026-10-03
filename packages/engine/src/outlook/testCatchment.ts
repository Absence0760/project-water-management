// A small invented catchment for the seasonal outlook's tests (synthetic:
// no real farm, name or value). Two farms with dams on summer-irrigated
// vines drain to a gauged outlet; winter rain, the wetness of each year drawn
// from a seeded generator, so the analogue years differ.
import type { Monthly } from '../calendar';
import { toEpochDay } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';

const flat = (v: number) => new Array(12).fill(v) as unknown as Monthly;

function node(over: Partial<NetworkNode> & Pick<NetworkNode, 'id' | 'name' | 'kind'>): NetworkNode {
	return {
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
		irrigationEfficiency: 0.8,
		returnFlowFraction: 0.1,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

export interface TestCatchmentOptions {
	/** First day of the record (default 2000-10-01). */
	start?: string;
	/** Last day of the record (default 2013-09-30: 13 water years). */
	end?: string;
	seed?: number;
	/** Pragmatic EWR at the outlet, m³/day in every month (default 300). */
	ewrM3Day?: number;
	/** A daily A-pan series as well as the monthly means. */
	dailyApan?: boolean;
	/**
	 * Record-wide statistics in play (engine ≥ 1.1.0, the snapshot's pinned
	 * ones): invasive trees on Farm A (the land-cover low-flow threshold) and
	 * a Reserve rule table at the outlet read against the run's own natural
	 * duration curves. Invented values.
	 */
	recordWide?: boolean;
}

/** Winter-rainfall daily rain: a year's wetness × a seasonal chance of rain × a lognormal-ish depth. */
function rain(rng: Rng, start: number, days: number): number[] {
	// Chance of a rain day by calendar month (Jan … Dec): wet May–September.
	const pWet = [0.08, 0.08, 0.12, 0.2, 0.35, 0.45, 0.5, 0.45, 0.35, 0.2, 0.12, 0.08];
	const out: number[] = new Array(days);
	let wetness = 1;
	for (let t = 0; t < days; t++) {
		const date = new Date((start + t) * 86_400_000);
		const m = date.getUTCMonth();
		if (m === 9 && date.getUTCDate() === 1) wetness = rng.float(0.35, 1.7);
		if (t === 0) wetness = rng.float(0.35, 1.7);
		out[t] = rng.bool(pWet[m]! * Math.min(wetness, 1.3)) ? Math.round(rng.logFloat(0.5, 40) * wetness * 10) / 10 : 0;
	}
	return out;
}

export function testCatchment(options: TestCatchmentOptions = {}): ModelInput {
	const start = toEpochDay(options.start ?? '2000-10-01');
	const end = toEpochDay(options.end ?? '2013-09-30');
	const days = end - start + 1;
	const rng = new Rng(options.seed ?? 7);
	const values = rain(rng, start, days);
	// Monthly A-pan, water-year order (Oct … Sep), mm a month.
	const apanMm = [180, 220, 260, 270, 220, 190, 120, 80, 50, 50, 70, 110] as unknown as Monthly;
	const input: ModelInput = {
		settings: {
			apanMm,
			ewrPragmaticM3PerDay: flat(options.ewrM3Day ?? 300),
			chirpsBiasCorrection: 'none',
			runoffModel: 'gr4j',
			gr4j: { x1: 300, x2: 0, x3: 80, x4: 1.5, warmupDays: 365 },
			calibration: { catchmentAreaKm2: 40 } as never
		},
		model: {
			// The dams' areas are entered (a 3 m mean depth), so the outlook tests' figures don't move with the
			// engine's estimate for an unknown area (7.2 × capacity^0.77 since engine 1.63.0).
			nodes: [
				node({ id: 'g', name: 'Outlet', kind: 'gauge', sortOrder: 0 }),
				node({ id: 'a', name: 'Farm A', kind: 'farm', sortOrder: 1, downstreamNodeId: 'g', areaKm2: 22, areaHiKm2: 18, areaLoKm2: 4, pctUpstreamToDam: 1, pctRunoffToDam: 0.8, damCapacityM3: 300_000, damInitialPct: 0.6, damMinPct: 0.05, damAreaFullM2: 300_000 / 3 }),
				node({ id: 'b', name: 'Farm B', kind: 'farm', sortOrder: 2, downstreamNodeId: 'g', areaKm2: 18, areaHiKm2: 14, areaLoKm2: 4, pctUpstreamToDam: 1, pctRunoffToDam: 0.7, damCapacityM3: 150_000, damInitialPct: 0.6, damMinPct: 0.05, damAreaFullM2: 150_000 / 3 })
			],
			// Vines, water-year order (Oct … Sep).
			crops: [{ id: 'v', name: 'Vines', cropFactor: [0.4, 0.6, 0.7, 0.7, 0.6, 0.5, 0.3, 0, 0, 0, 0, 0.2] }],
			cropAreas: [
				{ nodeId: 'a', cropId: 'v', areaM2: 700_000 },
				{ nodeId: 'b', cropId: 'v', areaM2: 450_000 }
			],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: options.start ?? '2000-10-01', values } }
	};
	if (options.recordWide) {
		input.model.landCover = [{ id: 'lc1', nodeId: 'a', coverClass: 'invasive', areaKm2: 3, densityPct: 0.6, factors: null }];
		const points = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
		// m³/s at the outlet, falling with the % point; wetter months (May–Sep, water-year index 7–11) ask for more.
		const row = (w: number) => points.map((p) => (w >= 7 ? 0.024 : 0.009) * (1 - p / 110));
		input.settings.ewrRules = [{ siteNodeId: null, source: 'invented', component: 'total', unit: 'm3s', points, ewr: Array.from({ length: 12 }, (_, w) => row(w)), naturalSource: 'run', natural: null, scale: 1 }];
	}
	if (options.dailyApan) {
		const monthLen = [31, 30, 31, 31, 28, 31, 30, 31, 30, 31, 31, 30];
		const ev: (number | null)[] = new Array(days);
		for (let t = 0; t < days; t++) {
			const m = new Date((start + t) * 86_400_000).getUTCMonth() + 1;
			const wy = (m + 2) % 12;
			// Around the monthly mean, with a gap now and then (the monthly mean fills it).
			ev[t] = rng.bool(0.03) ? null : Math.round((apanMm[wy]! / monthLen[wy]!) * rng.float(0.6, 1.4) * 10) / 10;
		}
		input.series.evap_apan_mm = { startDate: options.start ?? '2000-10-01', values: ev };
	}
	return input;
}
