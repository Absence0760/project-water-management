// Rain for each hydrological unit through the whole path, headlessly (issue
// #482; docs/model.md §2.4h, docs/maps.md § Rain for each unit): three land
// units, each with a parcel inside the synthetic CHIRPS fixture's cover, and a
// catchment gauge record with a gap. The owner sets up the units' feeds (POST
// …/feeds/chirps/from-units), their fetches run through runTick against the
// fixtures (FEED_SOURCE=fixtures), the units get their MAPs and Settings the
// gauge's MAP with unitRain `perUnit`, and a run then reports every unit on
// rule gaugeMap with factor = clamp(unit MAP ÷ gauge MAP) (one clamped at 4),
// the gauge's gap filled from each unit's own fetched CHIRPS, and a rain_unit
// series stored per unit. A server calibration under it records the units'
// forcing in its fit record, which the apply accepts and a later save carries
// back unchanged. Positive control: the same project with unitRain off runs
// on the catchment's rain, with no unitRain and no rain_unit series.
// Invented names, geometry and values.
import { AREAL_RAIN_FACTOR_MAX, AREAL_RAIN_FACTOR_MIN, defaultCalibrationRules, runModel, unitRainSeriesKey, type CalibrationRules, type ModelInput, type UnitRainUnit } from '@water-management/engine';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { utcToday } from '../feeds/fetch.js';
import { runTick } from '../jobs/runner.js';

type User = Awaited<ReturnType<typeof signUp>>;

const tick = () => runTick({ feeds: false, reports: false, alerts: false });

const ring = (w: number, s: number, e: number, n: number) => [
	[w, s],
	[e, s],
	[e, n],
	[w, n],
	[w, s]
];

const GAUGE_MAP = 640;
/** Each unit's MAP; the third's ratio (3000 ÷ 640 ≈ 4.7) is held at AREAL_RAIN_FACTOR_MAX. */
const UNITS = [
	{ name: 'Unit North', mapMm: 800, areaKm2: 12, parcel: ring(21.21, -33.79, 21.27, -33.74) },
	{ name: 'Unit Middle', mapMm: 480, areaKm2: 9, parcel: ring(21.31, -33.69, 21.37, -33.64) },
	{ name: 'Unit South', mapMm: 3000, areaKm2: 6, parcel: ring(21.41, -33.59, 21.45, -33.55) }
] as const;
const clamp = (x: number) => Math.min(AREAL_RAIN_FACTOR_MAX, Math.max(AREAL_RAIN_FACTOR_MIN, x));

const TRUTH = { x1: 420, x2: 0, x3: 70, x4: 2.1, warmupDays: 365 };
const quickRules = (): CalibrationRules => ({
	...defaultCalibrationRules(),
	run: { seed: 3, starts: 1, budget: 60 },
	cases: { bounds: ['typical'], objectives: ['kgePrime'] },
	selection: { test: 'split', score: 'kgePrime' },
	after: { onNewData: 'off', ensemble: false }
});

const today = toEpochDay(utcToday());
/** The gauge record: three years ending 10 days ago, with a 20-day gap inside the units' CHIRPS. */
const RECORD_START = fromEpochDay(today - 3 * 365);
const RECORD_DAYS = 3 * 365 - 10 + 1;
const GAP = { from: RECORD_DAYS - 60, days: 20 };
/** The units' feeds start here: one fetch window (120 days) reaches the fixture's newest rnl day. */
const FEED_START = fromEpochDay(today - 110);

const unitRain = { mode: 'perUnit', gaugeMapMm: GAUGE_MAP, gaugeMapSource: 'the gauge’s synthetic record, 1991–2020', mapPeriod: { start: '1991-01-01', end: '2020-12-31' } };

let owner: User;
let pid: string;
let gaugeId: string;
let units: { id: string; name: string; mapMm: number }[];

async function call(method: string, path: string, body?: unknown, status = 200) {
	const r = await owner.call(method, path, body);
	expect(r.status, `${method} ${path} → ${JSON.stringify(r.body)}`).toBe(status);
	return r.body;
}

beforeAll(async () => {
	owner = await signUp('UnitRainPathOwner');
	pid = (await call('POST', '/projects', { name: 'Rain for each unit, end to end' }, 201)).project.id;
	const gauge = node('Outlet gauge', null, { areaKm2: 0, damCapacityM3: 0 });
	const nodes = UNITS.map((u, i) =>
		node(u.name, gauge.id, { sortOrder: i + 1, areaKm2: u.areaKm2, pctRunoffToDam: 0, damCapacityM3: 0, mapMm: u.mapMm, mapSource: 'a synthetic MAP grid, 1991–2020' })
	);
	gaugeId = gauge.id;
	units = nodes.map((n, i) => ({ id: n.id, name: n.name, mapMm: UNITS[i]!.mapMm }));
	await call('PUT', `/projects/${pid}/model`, { nodes: [gauge, ...nodes], crops: [], cropAreas: [], transfers: [] });
	for (const [i, u] of UNITS.entries()) {
		await call('POST', `/projects/${pid}/map/features`, { kind: 'farm_parcel', name: `${u.name} parcel`, nodeId: units[i]!.id, geometry: { type: 'Polygon', coordinates: [u.parcel] } }, 201);
	}
	const current = (await call('GET', `/projects/${pid}`)).project.settings;
	await call('PATCH', `/projects/${pid}`, { settings: { runoffModel: 'gr4j', apanMm: monthly(150), gr4j: TRUTH, calibrationRules: { ...quickRules(), revision: current.calibrationRules.revision } } });
	const rain = Array.from({ length: RECORD_DAYS }, (_, t) => (t >= GAP.from && t < GAP.from + GAP.days ? null : t % 5 === 0 ? 12 + (t % 37) : t % 11 === 0 ? 3 : 0));
	await call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: RECORD_START, values: rain });
});

afterAll(async () => {
	await asOwner('DELETE FROM data_feed WHERE project_id = $1', [pid]);
	await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
});

describe('rain for each unit, from the feeds to the run and the fit', () => {
	it('sets up and fetches a CHIRPS feed for every unit, offline, into each unit’s own series', async () => {
		const proposal = await call('GET', `/projects/${pid}/feeds/chirps/from-units`);
		expect(proposal.units.map((u: { nodeId: string }) => u.nodeId)).toEqual(units.map((u) => u.id));
		expect(proposal.withoutPolygon).toEqual([]);
		expect(proposal.refused).toEqual([]);
		const applied = await call('POST', `/projects/${pid}/feeds/chirps/from-units`, { product: 'rnl', startDate: FEED_START });
		expect(applied).toMatchObject({ created: 3, updated: 0 });
		for (const f of applied.feeds as { feedId: string }[]) await call('POST', `/projects/${pid}/feeds/${f.feedId}/run-now`, undefined, 202);
		for (let i = 0; i < 6; i++) {
			const feeds = (await call('GET', `/projects/${pid}/feeds`)).feeds as { lastDataDate: string | null }[];
			if (feeds.every((f) => f.lastDataDate)) break;
			await tick();
		}
		const feeds = (await call('GET', `/projects/${pid}/feeds`)).feeds as { lastDataDate: string | null; lastError: string | null; consecutiveFailures: number }[];
		expect(feeds).toHaveLength(3);
		for (const f of feeds) expect(f).toMatchObject({ lastError: null, consecutiveFailures: 0, lastDataDate: expect.any(String) });
		const input = (await call('GET', `/projects/${pid}/model-input`)).input as ModelInput;
		for (const u of units) {
			const s = input.series?.[unitRainSeriesKey('rain_chirps_mm', u.id)];
			expect(s, u.name).toBeDefined();
			expect(s!.startDate).toBe(FEED_START);
			expect(s!.values.filter((v) => v !== null).length).toBeGreaterThan(90);
		}
		// The catchment's own CHIRPS stays empty: the units' rain never becomes the catchment's.
		expect(input.series?.rain_chirps_mm).toBeUndefined();
	});

	it('with unitRain off, a run forces the catchment as before (the positive control for what follows)', async () => {
		const runId = (await call('POST', `/projects/${pid}/runs`, { label: 'catchment rain' }, 201)).run.id as string;
		const { run, series } = await call('GET', `/projects/${pid}/runs/${runId}`);
		expect(run.summary.unitRain).toBeUndefined();
		expect((series as { key: string }[]).filter((s) => s.key === 'rain_unit')).toEqual([]);
	});

	it('with unitRain perUnit, the run reports each unit on gaugeMap with factor clamp(unit MAP ÷ gauge MAP), its gap from its own CHIRPS, and stores its rain', async () => {
		await call('PATCH', `/projects/${pid}`, { settings: { unitRain } });
		// The observed record is GR4J's with the known parameters on the units' own rain; the fit later starts from the defaults.
		const input = (await call('GET', `/projects/${pid}/model-input`)).input as ModelInput;
		const flow = runModel(input).series.find((s) => s.key === 'natural_flow' && s.nodeId === null)!.values;
		await call('PUT', `/projects/${pid}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: RECORD_START, values: flow.map((q) => Math.round(((q ?? 0) / 86_400) * 1e6) / 1e6) });

		const runId = (await call('POST', `/projects/${pid}/runs`, { label: 'per unit' }, 201)).run.id as string;
		const { run, series } = await call('GET', `/projects/${pid}/runs/${runId}`);
		const summary = run.summary.unitRain as { mode: string; gaugeMapMm: number; units: UnitRainUnit[] };
		expect(summary).toMatchObject({ mode: 'perUnit', gaugeMapMm: GAUGE_MAP, gaugeMapSource: unitRain.gaugeMapSource, mapPeriod: unitRain.mapPeriod });
		expect(summary.units.map((u) => u.nodeId).sort()).toEqual(units.map((u) => u.id).sort());
		const runDays = toEpochDay(run.endDate as string) - toEpochDay(run.startDate as string) + 1;
		for (const u of units) {
			const got = summary.units.find((x) => x.nodeId === u.id)!;
			const own = u.mapMm / GAUGE_MAP;
			expect(got, u.name).toMatchObject({ name: u.name, mapMm: u.mapMm, rule: 'gaugeMap', rainKey: 'rain_catchment_mm', factorSource: 'gaugeMap', gaugeMapClamped: clamp(own) !== own });
			expect(got.factor).toBeCloseTo(clamp(own), 12);
			expect(got.gaugeMapFactor).toBeCloseTo(clamp(own), 12);
			expect(got.gaugeMapOwnFactor).toBeCloseTo(own, 12);
			// The gauge's gap is filled from the unit's own fetched CHIRPS, every other day is the gauge × the ratio.
			expect(got.days.unitChirps, u.name).toBe(GAP.days);
			expect(got.days.gaugeMap + got.days.unitChirps).toBe(runDays);
			expect(got.chirps).not.toBeNull();
			expect(got.runoffM3).toBeGreaterThan(0);
		}
		expect(summary.units.find((x) => x.name === 'Unit South')).toMatchObject({ factor: AREAL_RAIN_FACTOR_MAX, gaugeMapClamped: true });
		expect((run.summary.warnings as string[]).join('\n')).toMatch(/Unit South/);

		// One rain_unit series per unit, stored with the run: the gauge's rain × the unit's factor on a recorded day.
		const stored = (series as { nodeId: string | null; key: string }[]).filter((s) => s.key === 'rain_unit');
		expect(stored.map((s) => s.nodeId).sort()).toEqual(units.map((u) => u.id).sort());
		const gauge = input.series!.rain_catchment_mm!;
		const runStart = toEpochDay(run.startDate as string);
		const day = gauge.values.findIndex((v, t) => (v ?? 0) > 0 && toEpochDay(gauge.startDate) + t >= runStart);
		for (const u of units) {
			const { values } = await call('GET', `/projects/${pid}/runs/${runId}/series?key=rain_unit&nodeId=${u.id}`);
			expect(values).toHaveLength(runDays);
			const t = toEpochDay(gauge.startDate) + day - runStart;
			expect(values[t], u.name).toBeCloseTo(gauge.values[day]! * clamp(u.mapMm / GAUGE_MAP), 9);
		}
		// The gauge has no land: no rain of its own.
		expect(stored.some((s) => s.nodeId === gaugeId)).toBe(false);
	});

	it('a server calibration under it records every unit’s forcing in the fit record, the apply accepts it, and a later save carries it back', async () => {
		const res = await call('POST', `/projects/${pid}/auto-calibrations`, {}, 202);
		for (let i = 0; i < 8; i++) {
			const got = (await call('GET', `/projects/${pid}/auto-calibrations/${res.calibration.id}`)).calibration;
			if (got.status !== 'running') break;
			await tick();
		}
		const done = (await call('GET', `/projects/${pid}/auto-calibrations/${res.calibration.id}`)).calibration;
		expect(done.status).toBe('complete');
		const applied = await call('POST', `/projects/${pid}/auto-calibrations/${done.id}/apply`, {});
		expect(applied).toMatchObject({ runId: expect.any(String), runError: null });
		const settings = (await call('GET', `/projects/${pid}`)).project.settings;
		const fp = settings.fitRecord.forcing.unitRain as { mode: string; gaugeMapMm: number; units: { nodeId: string; rule: string; rainKey: string; factor: number }[] };
		expect(fp).toMatchObject({ mode: 'perUnit', gaugeMapMm: GAUGE_MAP, mapPeriod: unitRain.mapPeriod });
		expect(fp.units.map((u) => u.nodeId).sort()).toEqual(units.map((u) => u.id).sort());
		for (const u of units) {
			const got = fp.units.find((x) => x.nodeId === u.id)!;
			expect(got).toMatchObject({ rule: 'gaugeMap', rainKey: 'rain_catchment_mm' });
			expect(got.factor).toBeCloseTo(clamp(u.mapMm / GAUGE_MAP), 12);
		}
		// The run the apply made forces the units as the fit did.
		const run = (await call('GET', `/projects/${pid}/runs/${applied.runId}`)).run;
		expect((run.summary.unitRain.units as UnitRainUnit[]).every((u) => u.rule === 'gaugeMap')).toBe(true);
		// The settings, record and all, save back unchanged.
		await call('PATCH', `/projects/${pid}`, { settings });
		expect((await call('GET', `/projects/${pid}`)).project.settings.fitRecord.forcing.unitRain).toEqual(fp);
	});
});
