import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import { DEMAND_PCT_FLOOR_M3_DAY } from '../network/curtailment';
import { EWR_BINDING_SERIES } from '../network/bindingSeries';
import { parseTransferRuleKey } from '../network/transferSeries';
import { isRiverOfftake } from '../network/offtake';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import { runModel, runModelWith } from '../run';
import { randomInput } from '../testing/fuzz';
import { analyseSeason, catchmentView, farmProjection, seasonStart, windowSummary, yearBefore, type ProjectionRun } from './farmProjection';

const flat = (v: number) => new Array(12).fill(v) as unknown as Monthly;

/** A saved run as the backend hands it to the projection: stored values, a missing day as null. */
function asRun(input: ModelInput, out: ModelOutput): ProjectionRun {
	const byKey = new Map(out.series.map((s) => [`${s.nodeId ?? ''}|${s.key}`, s.values.map((v) => (Number.isFinite(v) ? v : null))]));
	return {
		startDate: out.startDate,
		endDate: out.endDate,
		nodes: input.model.nodes,
		transfers: input.model.transfers,
		// Crops under their own irrigation efficiency (engine 0.43.0) set a farm's consumptive share.
		crops: input.model.crops,
		cropAreas: input.model.cropAreas,
		apanMm: input.settings?.apanMm,
		// A unit with demand objects (engine 1.7.0) takes its consumptive share from its stored return flow.
		...(input.model.demandObjects ? { demandObjects: input.model.demandObjects } : {}),
		series: (nodeId, key) => byKey.get(`${nodeId ?? ''}|${key}`)
	};
}

function farm(id: string, down: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: 5,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 1,
		pctRunoffToDam: 1,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 0.75,
		lossReturnFraction: 0.5,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}
const gauge = (id: string, down: string | null): NetworkNode => ({ ...farm(id, down ?? ''), kind: 'gauge', downstreamNodeId: down });

/**
 * Outlet ← Dam (a dam farm with a 20 % stop level) ← Hill (no dam, upstream),
 * and Flats (a dam farm with no stop level) straight into the outlet. Two
 * dry-ish years from 2021-10-01 to 2023-12-31, with a wet spell each
 * summer, so every farm is short some days and the reserve binds.
 */
function scenario(opts: { startDate?: string; days?: number } = {}) {
	const startDate = opts.startDate ?? '2021-10-01';
	const days = opts.days ?? 822; // to 2023-12-31
	const nodes = [
		gauge('outlet', null),
		farm('dam', 'outlet', { name: 'Dam farm', damCapacityM3: 200_000, damInitialPct: 0.6, damMinPct: 0.2 }),
		farm('hill', 'dam', { name: 'Hill farm' }),
		farm('flats', 'outlet', { name: 'Flats farm', damCapacityM3: 80_000, damInitialPct: 0.5, damMinPct: 0 })
	];
	const crop = { id: 'maize', name: 'Maize', cropFactor: new Array(12).fill(0.9) };
	const input: ModelInput = {
		settings: { ewrPragmaticM3PerDay: flat(2500), apanMm: flat(220) },
		model: {
			nodes,
			crops: [crop],
			cropAreas: [
				{ nodeId: 'dam', cropId: 'maize', areaM2: 600_000 },
				{ nodeId: 'hill', cropId: 'maize', areaM2: 400_000 },
				{ nodeId: 'flats', cropId: 'maize', areaM2: 300_000 }
			],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate, values: new Array(days).fill(0) } }
	};
	// Natural flow: a base flow with a wet spell each January and February.
	const d0 = Date.parse(`${startDate}T00:00:00Z`);
	const natural = Array.from({ length: days }, (_, t) => {
		const m = new Date(d0 + t * 86_400_000).getUTCMonth() + 1;
		return m === 1 || m === 2 ? 40_000 : 3_000;
	});
	const out = runModelWith(input, () => ({ naturalFlowM3Day: natural }));
	return { input, out, run: asRun(input, out) };
}

describe('a crop under its own irrigation efficiency (engine 0.43.0)', () => {
	it('shows the efficiency the run used and curtails with its consumptive share, given the snapshot’s crops', () => {
		const { input } = scenario();
		// Maize, the only crop, on drip at 0.9: every farm runs at 0.9, not its own 0.75.
		const drip: ModelInput = { ...input, model: { ...input.model, crops: input.model.crops.map((c) => ({ ...c, irrigationEfficiency: 0.9 })) } };
		const d0 = Date.parse('2021-10-01T00:00:00Z');
		const natural = Array.from({ length: 822 }, (_, t) => ([0, 1].includes(new Date(d0 + t * 86_400_000).getUTCMonth()) ? 40_000 : 3_000));
		// Reported over the season, so runModel's own table is the one the projection must match.
		const seasonal = { ...drip, settings: { ...drip.settings, reportStart: '2023-10-01', reportEnd: '2023-12-31' } };
		const out = runModelWith(seasonal, () => ({ naturalFlowM3Day: natural }));
		const run = asRun(seasonal, out);
		expect(farmProjection(run, 'dam').irrigationEfficiency).toBeCloseTo(0.9, 12);
		expect(analyseSeason(run).curtailment.farms).toEqual(out.summary.curtailment!.farms);
		// Without the crops (an older caller) it falls back to the farm's own efficiency, and the table is off.
		const bare: ProjectionRun = { ...run, crops: undefined, cropAreas: undefined };
		expect(farmProjection(bare, 'dam').irrigationEfficiency).toBe(0.75);
		expect(analyseSeason(bare).curtailment.farms).not.toEqual(out.summary.curtailment!.farms);
	});
});

describe('windowSummary', () => {
	const v = [1, 2, 3, null, 5];
	it('sums, averages and takes the last value over an inclusive window', () => {
		expect(windowSummary(v, '2024-01-01', '2024-01-02', '2024-01-03')).toEqual({ from: '2024-01-02', to: '2024-01-03', days: 2, sum: 5, mean: 2.5, last: 3 });
	});
	it('clamps to the series, counts a missing day as 0 and reports it as no last value', () => {
		expect(windowSummary(v, '2024-01-01', '2023-12-01', '2024-01-04')).toEqual({ from: '2024-01-01', to: '2024-01-04', days: 4, sum: 6, mean: 1.5, last: null });
		expect(windowSummary(v, '2024-01-01', '2024-01-04', '2025-01-01')!.to).toBe('2024-01-05');
	});
	it('is null when the window misses the series', () => {
		expect(windowSummary(v, '2024-01-01', '2024-02-01', '2024-02-10')).toBeNull();
		expect(windowSummary(v, '2024-01-01', '2024-01-03', '2024-01-02')).toBeNull();
	});
});

describe('season dates under a skewed TZ', () => {
	let tz: string | undefined;
	beforeEach(() => {
		tz = process.env.TZ;
		process.env.TZ = 'Pacific/Kiritimati'; // UTC+14: a local-time slip would move 1 October into September
	});
	afterEach(() => {
		process.env.TZ = tz;
	});

	it('starts the season on 1 October of the water year', () => {
		expect(seasonStart('2024-01-10')).toBe('2023-10-01');
		expect(seasonStart('2023-10-01')).toBe('2023-10-01');
		expect(seasonStart('2023-09-30')).toBe('2022-10-01');
	});
	it('steps back a year, 29 February to 28 February', () => {
		expect(yearBefore('2024-01-10')).toBe('2023-01-10');
		expect(yearBefore('2024-02-29')).toBe('2023-02-28');
	});
	it('windows the season and the last 30 days by UTC calendar day', () => {
		const { run } = scenario();
		const a = analyseSeason(run);
		expect(a.season).toMatchObject({ fromDate: '2023-10-01', toDate: '2023-12-31' });
		expect(a.last30).toMatchObject({ fromDate: '2023-12-02', toDate: '2023-12-31' });
		const p = farmProjection(run, 'dam', a);
		expect(p.monthly.map((m) => m.month)).toEqual(['2023-01', '2023-02', '2023-03', '2023-04', '2023-05', '2023-06', '2023-07', '2023-08', '2023-09', '2023-10', '2023-11', '2023-12']);
		expect(p.lastSeason).toMatchObject({ from: '2022-10-01', to: '2022-12-31' });
	});
});

describe('farmProjection', () => {
	const { run, out } = scenario();
	const a = analyseSeason(run);
	const series = (nodeId: string, key: string) => out.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
	const d0 = Date.parse(`${run.startDate}T00:00:00Z`);
	const idx = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - d0) / 86_400_000);
	const sum = (v: ArrayLike<number>, from: string, to: string) => {
		let s = 0;
		for (let t = idx(from); t <= idx(to); t++) s += v[t]!;
		return s;
	};

	it('totals the season and the last 30 days from the run', () => {
		const p = farmProjection(run, 'dam', a);
		expect(p.dataUntil).toBe('2023-12-31');
		expect(p.season.from).toBe('2023-10-01');
		expect(p.season.demandM3).toBeCloseTo(sum(series('dam', 'demand'), '2023-10-01', '2023-12-31'), 6);
		expect(p.season.suppliedM3).toBeCloseTo(sum(series('dam', 'supplied'), '2023-10-01', '2023-12-31'), 6);
		expect(p.season.fraction).toBeCloseTo(p.season.suppliedM3 / p.season.demandM3, 12);
		expect(p.last30.suppliedM3).toBeCloseTo(sum(series('dam', 'supplied'), '2023-12-02', '2023-12-31'), 6);
		const monthlyNeed = p.monthly.slice(-3).reduce((s, m) => s + m.demandM3, 0);
		expect(monthlyNeed).toBeCloseTo(p.season.demandM3, 6);
	});

	it('finds a dam farm short only when its dam is at its stop level', () => {
		const p = farmProjection(run, 'dam', a);
		expect(p.season.shortDays).toBeGreaterThan(0);
		expect(p.season.shortDaysAtStopLevel).toBe(p.season.shortDays);
		expect(p.season.shortMonths.length).toBeGreaterThan(0);
		expect([...p.season.shortMonths].sort()).toEqual(p.season.shortMonths);
		expect(p.dam!.usableM3).toBeCloseTo(Math.max(p.dam!.storageM3 - 200_000 * 0.2, 0), 6);
	});

	it('leaves the usable volume and days out when the dam has no stop level', () => {
		const p = farmProjection(run, 'flats', a);
		expect(p.damMinPct).toBe(0);
		expect(p.dam).not.toBeNull();
		expect(p.dam!.usableM3).toBeNull();
		expect(p.dam!.usableDays).toBeNull();
		expect(p.dam!.pct).toBeCloseTo(p.dam!.storageM3 / 80_000, 12);
	});

	it('gives a farm with no dam no dam card and no stop-level days', () => {
		const p = farmProjection(run, 'hill', a);
		expect(p.dam).toBeNull();
		expect(p.monthly.every((m) => m.damPctEnd === null)).toBe(true);
		expect(p.season.shortDaysAtStopLevel).toBe(0);
		expect(p.lastSeason!.damPct).toBeNull();
	});

	it('works out the dam figures from the storage series', () => {
		const p = farmProjection(run, 'dam', a);
		const st = series('dam', 'dam_storage');
		expect(p.dam!.storageM3).toBe(st[idx('2023-12-31')]);
		expect(p.dam!.pct30dAgo).toBeCloseTo(st[idx('2023-12-01')]! / 200_000, 12);
		expect(p.dam!.use14M3Day).toBeCloseTo(sum(series('dam', 'supplied'), '2023-12-18', '2023-12-31') / 14, 6);
		const spill = series('dam', 'spill');
		let last = -1;
		for (let t = 0; t < spill.length; t++) if (spill[t]! > 1e-6) last = t;
		expect(p.dam!.lastSpill).toBe(last < 0 ? null : new Date(d0 + last * 86_400_000).toISOString().slice(0, 10));
	});

	it('is the season curtailment row, and its headline is what the farm received less its pump cut', () => {
		for (const id of ['dam', 'hill', 'flats']) {
			const p = farmProjection(run, id, a);
			const cf = a.curtailment.farms.find((f) => f.nodeId === id)!;
			expect(p.river.demandM3Day).toBe(cf.demandM3Day);
			expect(p.river.supplyCutM3Day).toBeCloseTo(-cf.ewrSupplyCutM3Day!, 12);
			expect(p.river.headline).toBeCloseTo((cf.suppliedM3Day + cf.ewrSupplyCutM3Day!) / cf.demandM3Day, 12);
			expect(p.river.windowDays).toBe(92);
			expect(p.river.equitableFraction).toBe(a.curtailment.equitableFraction);
			expect(p.river.aboveBelowShareM3Day).toBe(cf.reduceGainM3Day);
		}
	});

	it('bases a farm well below the even share on what it received, never on the share (the Klipdrift case)', () => {
		// Find the farm furthest below the even share; the headline stays under what it received.
		const rows = a.curtailment.farms.filter((f) => f.fractionSupplied !== null);
		const below = rows.reduce((m, f) => (f.reduceGainM3Day > m.reduceGainM3Day ? f : m));
		expect(below.reduceGainM3Day).toBeGreaterThan(0);
		const p = farmProjection(run, below.nodeId, a);
		expect(p.river.headline!).toBeLessThanOrEqual(below.fractionSupplied! + 1e-12);
		// fractionOfDemandLeft (V) counts the even share as water; the headline doesn't.
		expect(p.river.headline!).toBeLessThan(below.fractionOfDemandLeft!);
	});

	it('counts the days charged and the per-charged-day cut', () => {
		const p = farmProjection(run, 'dam', a);
		const charge = series('dam', 'ewr_charge');
		let n = 0;
		for (let t = idx('2023-10-01'); t <= idx('2023-12-31'); t++) if (charge[t]! < 0) n++;
		expect(p.river.chargedDays).toBe(n);
		expect(n).toBeGreaterThan(0);
		expect(p.river.perChargedDaySupplyCutM3!).toBeCloseTo((p.river.supplyCutM3Day * 92) / n, 9);
		expect(p.river.sites).toEqual([expect.objectContaining({ name: 'outlet' })]);
		expect(p.river.sites[0]!.daysNotMet).toBeGreaterThanOrEqual(p.river.sites[0]!.daysOnlyNatural);
		expect(p.river.bindingSite).toBe('outlet');
	});

	it('bands the headline', () => {
		const p = farmProjection(run, 'dam', a);
		const expected = p.river.headline! < 0.7 ? 'short' : p.river.headline! < 0.9 || p.river.storageM3Day >= DEMAND_PCT_FLOOR_M3_DAY ? 'watch' : 'ok';
		expect(p.river.band).toBe(expected);
	});

	it('has no last season when the run does not reach back a year', () => {
		const short = scenario({ startDate: '2023-06-01', days: 214 }); // to 2023-12-31
		const p = farmProjection(short.run, 'dam');
		expect(p.lastSeason).toBeNull();
		expect(p.season.from).toBe('2023-10-01');
		// What the farm page names instead: "the model's data starts on 1 Jun 2023".
		expect(p.dataFrom).toBe('2023-06-01');
	});

	it('starts the season at the run when the run starts after 1 October', () => {
		const late = scenario({ startDate: '2023-11-15', days: 47 });
		const p = farmProjection(late.run, 'dam');
		expect(p.season.from).toBe('2023-11-15');
		expect(p.lastSeason).toBeNull();
		expect(p.monthly.slice(0, 10).every((m) => m.demandM3 === 0 && m.damPctEnd === null)).toBe(true);
	});

	it('ends every window at dataUntil when the run goes on on forecast rain', () => {
		const withForecast: ProjectionRun = { ...run, dataUntil: '2023-12-21' };
		const f = analyseSeason(withForecast);
		expect(f.season).toMatchObject({ fromDate: '2023-10-01', toDate: '2023-12-21' });
		expect(f.last30).toMatchObject({ fromDate: '2023-11-22', toDate: '2023-12-21' });
		const p = farmProjection(withForecast, 'dam', f);
		expect(p.dataUntil).toBe('2023-12-21');
		expect(p.season.suppliedM3).toBeCloseTo(sum(series('dam', 'supplied'), '2023-10-01', '2023-12-21'), 6);
		expect(p.dam!.storageM3).toBe(series('dam', 'dam_storage')[idx('2023-12-21')]);
		expect(p.river.windowDays).toBe(82);
		expect(p.monthly.at(-1)!.suppliedM3).toBeCloseTo(sum(series('dam', 'supplied'), '2023-12-01', '2023-12-21'), 6);
		expect(catchmentView(withForecast, f)).toMatchObject({ dataUntil: '2023-12-21', runDays: idx('2023-12-21') + 1 });
		// Clamped to the run.
		expect(analyseSeason({ ...run, dataUntil: '2030-01-01' }).dataUntil).toBe('2023-12-31');
	});

	it('refuses a node that is not a farm, and a run missing a series', () => {
		expect(() => farmProjection(run, 'outlet', a)).toThrow(/not a farm/);
		const old: ProjectionRun = { ...run, series: (n, k) => (k === 'ewr_charge_irrigation' ? undefined : run.series(n, k)) };
		expect(() => analyseSeason(old)).toThrow(/no ewr_charge_irrigation series/);
	});

	it('names no other farm', () => {
		const p = farmProjection(run, 'dam', a);
		const text = JSON.stringify(p);
		for (const other of ['hill', 'Hill farm', 'flats', 'Flats farm']) expect(text).not.toContain(other);
	});
});

describe('catchmentView', () => {
	it('counts days not met at each site over the run, the season and 30 days, and holds no volume', () => {
		const { run } = scenario();
		const v = catchmentView(run);
		expect(v).toMatchObject({ runStart: '2021-10-01', dataUntil: '2023-12-31', farmCount: 3, season: { days: 92 }, last30: { days: 30 } });
		expect(v.sites).toHaveLength(1);
		const s = v.sites[0]!;
		expect(s.isOutlet).toBe(true);
		expect(s.daysNotMet.run).toBeGreaterThanOrEqual(s.daysNotMet.season);
		expect(s.daysNotMet.season).toBeGreaterThanOrEqual(s.daysNotMet.last30);
		expect(Object.keys(v).sort()).toEqual(['dataUntil', 'farmCount', 'last30', 'runDays', 'runStart', 'season', 'sites']);
	});
});

describe('the season curtailment agrees with runModel over the same window', () => {
	// runModel computes the curtailment over settings.reportStart … reportEnd;
	// set that to the season and the projection's own table (and its
	// recomputed binding sites) must match it on random networks, users,
	// gauges and transfers included.
	it('on 300 random networks', () => {
		let checked = 0;
		// How many cases exercise the hard paths: a gauge binding a farm's charge, and transfer rules.
		let gaugeBinds = 0;
		let withTransfers = 0;
		let loops = 0;
		for (let seed = 1; seed <= 300; seed++) {
			const base = randomInput(seed, { maxDays: 800 });
			let probe: ModelOutput;
			try {
				probe = runModel(base);
			} catch {
				continue;
			}
			const input = { ...base, settings: { ...base.settings, reportStart: seasonStart(probe.endDate), reportEnd: probe.endDate } };
			const out = runModel(input);
			const expected = out.summary.curtailment!;
			const run = asRun(input, out);
			const got = analyseSeason(run);
			expect(got.curtailment.reportStart, `seed ${seed}`).toBe(expected.reportStart);
			expect(got.curtailment.equitableFraction, `seed ${seed}`).toBe(expected.equitableFraction);
			expect(got.curtailment.ewrSites, `seed ${seed}`).toEqual(expected.ewrSites);
			// A run of today's engine is exact, transfer loops included: it stores the binding sites (1.5.0) and each rule's volume (1.6.0).
			expect(got.bindingApproximate, `seed ${seed}`).toBe(false);
			expect(got.curtailment.farms, `seed ${seed}`).toEqual(expected.farms);
			// With the binding sites recomputed, from the per-rule volumes: still exact.
			const recomputed = analyseSeason({ ...run, series: (n, k) => (k === EWR_BINDING_SERIES.key ? undefined : run.series(n, k)) });
			expect(recomputed.bindingApproximate, `seed ${seed}`).toBe(false);
			expect(recomputed.curtailment.farms, `seed ${seed}`).toEqual(expected.farms);
			// A run saved before 1.5.0 (neither series): the fallback cuts a loop, and says so. A model with a
			// river off-take (engine 1.14.0) can't come from such a run, and the farms' nets don't carry one.
			if (input.model.transfers.some((t) => t.enabled && isRiverOfftake(t))) {
				checked++;
				continue;
			}
			const old = analyseSeason({ ...run, series: (n, k) => (k === EWR_BINDING_SERIES.key || parseTransferRuleKey(k) ? undefined : run.series(n, k)) });
			const strip = (f: { ewrBindingSiteId?: string | null }) => ({ ...f, ewrBindingSiteId: undefined });
			if (old.bindingApproximate) {
				loops++;
				expect(old.curtailment.farms.map(strip), `seed ${seed}`).toEqual(expected.farms.map(strip));
			} else {
				expect(old.curtailment.farms, `seed ${seed}`).toEqual(expected.farms);
			}
			checked++;
			if (got.curtailment.farms.some((f) => f.ewrBindingSiteId && f.ewrBindingSiteId !== got.sites[0]!.nodeId)) gaugeBinds++;
			if (input.model.transfers.some((t) => t.enabled)) withTransfers++;
		}
		expect(checked).toBeGreaterThan(200);
		expect(gaugeBinds).toBeGreaterThanOrEqual(3);
		expect(withTransfers).toBeGreaterThan(50);
		expect(loops).toBeGreaterThan(0);
	});
});
