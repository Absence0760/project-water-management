import { describe, expect, it } from 'vitest';
import type { NetworkNode, ProjectModel, SeriesMeta } from '@water-management/engine';
import { lakeFactorPresetFill, withMonthlyRates } from '@water-management/engine';
import { coverageRows, cropAreaRows, effectiveSettings, monthlyRows, nodeRows, settingsRows, transferRows } from './inputs';

const node = (id: string, name: string, over: Partial<NetworkNode> = {}) =>
	({ id, name, kind: 'farm', downstreamNodeId: null, sortOrder: 0, areaKm2: 1, damCapacityM3: 0, irrigationEfficiency: 0.8, ...over }) as NetworkNode;

const model: Partial<ProjectModel> = {
	nodes: [
		node('g', 'Outlet gauge', { kind: 'gauge', sortOrder: 2, areaKm2: 5 }),
		node('a', 'Upper farm', { sortOrder: 0, downstreamNodeId: 'b', damCapacityM3: 150_000 }),
		node('b', 'Lower farm', { sortOrder: 1, downstreamNodeId: 'g' })
	],
	crops: [
		{ id: 'c1', name: 'Citrus', cropFactor: [] },
		{ id: 'c2', name: 'Lucerne', cropFactor: [] }
	],
	cropAreas: [
		{ nodeId: 'b', cropId: 'c1', areaM2: 250_000 },
		{ nodeId: 'a', cropId: 'c2', areaM2: 100_000 },
		{ nodeId: 'a', cropId: 'c1', areaM2: 50_000 },
		{ nodeId: 'a', cropId: 'c2', areaM2: 0 }
	],
	transfers: [
		{ id: 't', fromNodeId: 'b', toNodeId: 'a', months: [10, 11, 12], maxRateM3s: 0.05, dailyCapM3: null, minStoragePct: 0, enabled: false, priority: 1 }
	]
};

describe('effectiveSettings', () => {
	it('fills what the run did not store from the defaults, GR4J one level deep', () => {
		const s = effectiveSettings({ runoffModel: 'gr4j', gr4j: { x1: 500 } as never });
		expect(s.gr4j.x1).toBe(500);
		expect(s.gr4j.x4).toBe(1.7);
		expect(s.panCoefficient).toHaveLength(12);
	});

	it('reads a stored run that names no runoff model as legacy (engine < 1.0.0), never as today’s GR4J default', () => {
		expect(effectiveSettings({ runoffModel: 'gr4j' }).runoffModel).toBe('gr4j');
		expect(effectiveSettings({ runoffModel: 'legacy' }).runoffModel).toBe('legacy');
		expect(effectiveSettings({}).runoffModel).toBe('legacy');
		expect(effectiveSettings(undefined).runoffModel).toBe('legacy');
	});
});

describe('settingsRows', () => {
	it('names the runoff model and lists GR4J parameters only for a GR4J run', () => {
		const run = { startDate: '2000-10-01', endDate: '2010-09-30' };
		const gr4j = Object.fromEntries(settingsRows(effectiveSettings({ runoffModel: 'gr4j' }), run));
		expect(gr4j['Simulated period']).toBe('2000-10-01 – 2010-09-30');
		expect(gr4j['Runoff model']).toBe('GR4J');
		expect(gr4j['GR4J parameters']).toMatch(/^X1 350 mm/);
		expect(gr4j['Calibration window']).toBe('whole record');
		const legacy = Object.fromEntries(settingsRows(effectiveSettings({ runoffModel: 'legacy', calibrationStart: '2003-10-01' }), run));
		expect(legacy['Runoff model']).toBe('Legacy (b023 workbook, removed in engine 1.0.0): workbook comparison only');
		expect(legacy['GR4J parameters']).toBeUndefined();
		expect(legacy['Calibration window']).toBe('from 2003-10-01');
	});

	it('lists the rain-source periods, or none (engine ≥ 0.30.0)', () => {
		const run = { startDate: '2000-10-01', endDate: '2010-09-30' };
		expect(Object.fromEntries(settingsRows(effectiveSettings({}), run))['Rain source periods']).toBe('none (the catchment series throughout)');
		const period = {
			start: '2005-10-01',
			end: '2010-09-30',
			series: 'rain_catchment_alt_mm' as const,
			factors: 'fit' as const,
			fitReference: { series: 'rain_reanalysis_mm' as const, fromWaterYear: 1995, toWaterYear: 2004 },
			reason: 'automatic station'
		};
		expect(Object.fromEntries(settingsRows(effectiveSettings({ rainSource: [period] }), run))['Rain source periods']).toBe(
			'2005-10-01 to 2010-09-30: alternative catchment gauge, fitted against reanalysis 1995/96–2004/05 (automatic station)'
		);
	});

	it('says where GR4J’s potential evaporation came from (engine ≥ 0.31.0), pan × A-pan for a snapshot without it', () => {
		const run = { startDate: '2000-10-01', endDate: '2010-09-30' };
		expect(Object.fromEntries(settingsRows(effectiveSettings({ runoffModel: 'gr4j' }), run))['GR4J potential evaporation']).toBe('pan coefficient × A-pan');
		const pe = { kind: 'monthly' as const, mm: new Array(12).fill(100) as never, source: 'station ET₀' };
		expect(Object.fromEntries(settingsRows(effectiveSettings({ runoffModel: 'gr4j', pe }), run))['GR4J potential evaporation']).toBe(
			'monthly, entered directly: 1\u202f200 mm a year (station ET₀)'
		);
		// Where the pan-coefficient row came from, when noted (engine ≥ 0.31.1); not under a monthly PE, which doesn't use it.
		const panCoefficientSource = 'FAO-56 Table 5, Case A, 10 m green crop fetch';
		expect(Object.fromEntries(settingsRows(effectiveSettings({ runoffModel: 'gr4j', panCoefficientSource }), run))['GR4J potential evaporation']).toBe(
			'pan coefficient × A-pan (pan coefficient: FAO-56 Table 5, Case A, 10 m green crop fetch)'
		);
		expect(Object.fromEntries(settingsRows(effectiveSettings({ runoffModel: 'gr4j', pe, panCoefficientSource }), run))['GR4J potential evaporation']).toBe(
			'monthly, entered directly: 1\u202f200 mm a year (station ET₀)'
		);
		// Legacy runs have no GR4J PE.
		expect(Object.fromEntries(settingsRows(effectiveSettings({ runoffModel: 'legacy', pe }), run))['GR4J potential evaporation']).toBeUndefined();
	});
});

describe('monthly dam evaporation factors (WP-3.5)', () => {
	it('lists them with the monthly rows and points the settings row there', () => {
		const run = { startDate: '2020-10-01', endDate: '2021-09-30' };
		const k = [0.7, 0.7, 0.75, 0.8, 0.8, 0.8, 0.8, 0.75, 0.7, 0.65, 0.65, 0.7];
		const s = effectiveSettings({ lakeEvapFactorMonthly: k as never });
		expect(monthlyRows(s).find((r) => r.label === 'Dam evaporation factor (× A-pan)')?.values[3]).toBe('0.8');
		expect(settingsRows(s, run).find((r) => r[0] === 'Dam evaporation factor')?.[1]).toBe('by month (see the monthly table)');
		const one = effectiveSettings({});
		expect(monthlyRows(one).map((r) => r.label)).not.toContain('Dam evaporation factor (× A-pan)');
		expect(settingsRows(one, run).find((r) => r[0] === 'Dam evaporation factor')?.[1]).toBe('0.75');
	});

	it('shows a lake-factor preset’s factors to 3 decimals and names its source (engine ≥ 1.49.0)', () => {
		const run = { startDate: '2020-10-01', endDate: '2021-09-30' };
		const fill = lakeFactorPresetFill('wr90', [180, 230, 270, 285, 245, 210, 140, 90, 60, 65, 90, 130]);
		if (!fill.ok) throw new Error(fill.reason);
		const s = effectiveSettings({ lakeEvapFactorMonthly: fill.values as never, lakeEvapFactorSource: fill.note });
		expect(monthlyRows(s).find((r) => r.label === 'Dam evaporation factor (× A-pan)')?.values[3]).toBe('0.691');
		expect(settingsRows(s, run).find((r) => r[0] === 'Dam evaporation factor')?.[1]).toBe(`by month (see the monthly table) (source: ${fill.note})`);
		// A single factor with a note names it too; a run saved before the setting has none.
		expect(settingsRows(effectiveSettings({ lakeEvapFactorSource: 'site study' }), run).find((r) => r[0] === 'Dam evaporation factor')?.[1]).toBe('0.75 (source: site study)');
	});
});

describe('monthlyRows', () => {
	it('gives twelve values per row, in water-year order', () => {
		const s = effectiveSettings({ apanMm: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as never });
		const rows = monthlyRows(s);
		expect(rows.map((r) => r.label)).toEqual(['A-pan evaporation (mm)', 'Pan coefficient', 'Pragmatic EWR (m³/day)']);
		expect(rows[0]!.values[0]).toBe('1');
		expect(rows[0]!.values).toHaveLength(12);
	});

	it('shows GR4J’s monthly PE row instead of the unused pan coefficient under a monthly PE', () => {
		const pe = { kind: 'monthly' as const, mm: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120] as never, source: 'station' };
		const rows = monthlyRows(effectiveSettings({ runoffModel: 'gr4j', pe }));
		expect(rows.map((r) => r.label)).toEqual(['A-pan evaporation (mm)', 'GR4J monthly PE (mm)', 'Pragmatic EWR (m³/day)']);
		expect(rows[1]!.values[0]).toBe('10');
		// Legacy ignores the PE input, so the report keeps the pan coefficient row as before.
		expect(monthlyRows(effectiveSettings({ runoffModel: 'legacy', pe })).map((r) => r.label)).toContain('Pan coefficient');
	});
});

describe('nodeRows', () => {
	it('lists nodes in network order with what each drains into', () => {
		expect(nodeRows(model)).toEqual([
			['Upper farm', 'Hydrological unit', 'Lower farm', '1.00', '150\u202f000', '80%'],
			['Lower farm', 'Hydrological unit', 'Outlet gauge', '1.00', '–', '80%'],
			['Outlet gauge', 'Gauge', 'outlet', '5.00', '–', '–']
		]);
	});
});

describe('cropAreaRows', () => {
	it('lists planted areas in hectares by farm then crop, leaving out empty ones', () => {
		expect(cropAreaRows(model)).toEqual([
			['Upper farm', 'Citrus', '5.00'],
			['Upper farm', 'Lucerne', '10.00'],
			['Lower farm', 'Citrus', '25.00']
		]);
	});
});

describe('transferRows', () => {
	it('names both ends and the months, and says when a transfer was off', () => {
		expect(transferRows(model)).toEqual([['Lower farm', 'Upper farm', 'Oct–Dec', '0.05', 'none', '–', '–', 'off']]);
	});
	it('lists each month\'s own rate when a rule has monthly rates that differ (engine 1.14.0)', () => {
		const t = { ...model.transfers![0]!, ...withMonthlyRates([0.05, 0.02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
		expect(transferRows({ ...model, transfers: [t] })[0]).toEqual(['Lower farm', 'Upper farm', 'Oct, Nov', 'Oct 0.05, Nov 0.02', 'none', '–', '–', 'off']);
		// One rate in every month it runs: the rate, as before.
		const same = { ...t, ...withMonthlyRates([0.05, 0.05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
		expect(transferRows({ ...model, transfers: [same] })[0]![3]).toBe('0.05');
	});
	it('says when a transfer is a river off-take (engine 1.14.0)', () => {
		const t = { ...model.transfers![0]!, source: 'river' as const };
		expect(transferRows({ ...model, transfers: [t] })[0]![0]).toBe('Lower farm (river off-take)');
	});
	it('gives a river off-take\'s conveyance losses and the share seeping back, with the unit it rejoins below (engine 1.42.0)', () => {
		const t = { ...model.transfers![0]!, fromNodeId: 'a', toNodeId: 'b', source: 'river' as const, lossPct: 0.2 };
		const row = (over: object) => transferRows({ ...model, transfers: [{ ...t, ...over }] })[0]!.slice(5, 7);
		// None back: all the losses leave the catchment (the default).
		expect(row({})).toEqual(['20.0%', 'none']);
		// Below the source (no unit named), and below a unit downstream of it.
		expect(row({ lossReturnPct: 0.4, lossReturnNodeId: null })).toEqual(['20.0%', '40.0% of them, below Upper farm']);
		expect(row({ lossReturnPct: 0.4, lossReturnNodeId: 'b' })).toEqual(['20.0%', '40.0% of them, below Lower farm']);
		// A share with no losses to return is none.
		expect(row({ lossPct: 0, lossReturnPct: 0.4 })).toEqual(['0.0%', 'none']);
	});
});

describe('coverageRows', () => {
	it('counts the days of each series inside the run', () => {
		const series: SeriesMeta[] = [
			{ id: '1', kind: 'rain_catchment_mm', name: '', unit: 'mm', startDate: '1999-10-01', length: 800 },
			{ id: '2', kind: 'flow_observed_m3s', name: 'Weir', unit: 'm³/s', startDate: '2001-01-01', length: 10 }
		];
		expect(coverageRows(series, { startDate: '2000-01-01', endDate: '2000-12-31' })).toEqual([
			['Flow — observed gauge · Weir', '2001-01-01', '2001-01-10', '10', '0'],
			['Rainfall — catchment', '1999-10-01', '2001-12-08', '800', '366']
		]);
	});

	it('ends each series on its last value: blank days stored after it are no data', () => {
		const logger: SeriesMeta = { id: '1', kind: 'rain_catchment_mm', name: 'Logger', unit: 'mm', startDate: '2026-09-01', length: 27, lastValueDate: '2026-09-25' };
		expect(coverageRows([logger], { startDate: '2026-09-01', endDate: '2026-09-27' })).toEqual([['Rainfall — catchment · Logger', '2026-09-01', '2026-09-25', '27', '27']]);
	});
});
