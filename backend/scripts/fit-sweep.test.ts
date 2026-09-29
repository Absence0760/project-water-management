// `pnpm fit-sweep` (./fit-sweep.ts): grid parsing and expansion, the
// refusals, one real cell on a synthetic catchment (invented values only:
// public repo) with a tiny budget, and the report. No database.
import { CALIBRATION_BOUNDS, ENGINE_VERSION, OBJECTIVES, PAN_COEFFICIENT_PRESETS, type ModelInput, type ProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from './fit-project.js';
import {
	DEFAULT_MAX_CELLS,
	expandGrid,
	intOption,
	parseGrid,
	runCell,
	sweepInputOf,
	sweepRefusal,
	toJson,
	toMarkdown,
	validationRecordOf,
	type CellResult,
	type SweepMeta
} from './fit-sweep.js';
import { cliPath } from './pan-sensitivity.js';

const reference = {
	quaternary: 'X99A',
	areaKm2: 40,
	marMm3: 1.2,
	monthlyMm3: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
	periodStart: 1920,
	periodEnd: 2030,
	mapMm: null,
	source: 'invented for the test'
};

function doc(settings: Record<string, unknown> = {}): ProjectDocument {
	const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 1, lossReturnFraction: 0, damAreaFullM2: null, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const days = 1461;
	const rain = Array.from({ length: days }, (_, i) => (i % 13 === 0 ? 30 : i % 4 === 0 ? 2 : 0));
	const flow = Array.from({ length: days }, (_, i) => 0.04 + 0.25 * Math.exp(-(i % 13) / 3) * (1 + 0.5 * Math.sin(i / 58)));
	return {
		name: 'Invented',
		settings: { apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100], ...settings },
		model: {
			nodes: [
				{ ...node, id: '00000000-0000-4000-8000-000000000001', name: 'Outlet', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
				{ ...node, id: '00000000-0000-4000-8000-000000000002', name: 'Unit', kind: 'farm', downstreamNodeId: '00000000-0000-4000-8000-000000000001', areaKm2: 20 }
			],
			crops: [],
			cropAreas: [],
			transfers: []
		} as unknown as ModelInput['model'],
		series: [
			{ kind: 'rain_chirps_mm', startDate: '2016-10-01', values: rain },
			{ kind: 'flow_observed_m3s', startDate: '2016-10-01', values: flow }
		]
	};
}

describe('parseGrid', () => {
	it('takes an empty grid (every axis at its default) and a full one', () => {
		expect(parseGrid({})).toEqual({});
		const g = parseGrid({
			panPresets: ['project', 'winter-rainfall', 0.6, { label: 'mine', values: new Array(12).fill(0.75) }],
			bounds: [...CALIBRATION_BOUNDS],
			objectives: [...OBJECTIVES],
			exclusionSets: { none: [], 'drop-2018': [{ start: '2018-01-01', end: '2018-06-30', reason: 'logger silted' }], wy: [{ waterYear: 2017, reason: 'rating changed' }] },
			wr2012Band: [false, true],
			wr2012Penalty: { weight: 1, marLowMm3: 0.5, marHighMm3: 0.8 }
		});
		expect(g.objectives).toEqual([...OBJECTIVES]);
	});

	it('names every problem by its path', () => {
		const bad = (raw: unknown, re: RegExp) => expect(() => parseGrid(raw)).toThrow(re);
		bad({ objective: ['kgePrime'] }, /unrecognized key|objective/i);
		bad({ objectives: ['r2'] }, /objectives\.0/);
		bad({ bounds: ['loose'] }, /bounds\.0/);
		bad({ panPresets: ['tropical'] }, /unknown pan preset "tropical".*winter-rainfall/);
		bad({ panPresets: [{ label: 'short', values: [0.7] }] }, /12 months/);
		bad({ panPresets: [3] }, /panPresets\.0/);
		bad({ objectives: ['kgePrime', 'kgePrime'] }, /objective kgePrime is listed twice/);
		bad({ panPresets: [0.7, { label: 'flat 0.70', values: new Array(12).fill(0.7) }] }, /pan preset flat 0.70 is listed twice/);
		bad({ exclusionSets: {} }, /at least one named set/);
		bad({ exclusionSets: { x: [{ start: '2018-01-01', end: '2018-02-01' }] } }, /exclusionSets\.x\.0/);
		bad({ exclusionSets: { x: [{ start: '2018-03-01', end: '2018-02-01', reason: 'r' }] } }, /exclusionSets\.x\.0/);
		bad({ wr2012Band: [] }, /wr2012Band/);
		bad({ wr2012Penalty: { weight: 0 } }, /wr2012Penalty\.weight/);
	});
});

describe('expandGrid', () => {
	it('is one cell per combination, in axis order, with defaults for omitted axes', () => {
		expect(expandGrid({}, false)).toEqual([{ pan: { label: 'project', values: null }, bounds: 'wide', objective: 'kgePrime', exclusionSet: 'none', exclusions: [], wr2012Band: false }]);
		// The band's default is the project's own setting.
		expect(expandGrid({}, true)[0]!.wr2012Band).toBe(true);

		const g = parseGrid({ panPresets: ['generic', 0.6], bounds: ['wide', 'typical'], objectives: [...OBJECTIVES], exclusionSets: { none: [], a: [{ waterYear: 2017, reason: 'r' }] }, wr2012Band: [false, true] });
		const cells = expandGrid(g, false);
		expect(cells).toHaveLength(2 * 2 * OBJECTIVES.length * 2 * 2);
		expect(cells[0]!.pan).toEqual({ label: 'generic', values: PAN_COEFFICIENT_PRESETS.find((p) => p.id === 'generic')!.values });
		expect(cells[1]).toMatchObject({ exclusionSet: 'none', wr2012Band: true });
		expect(cells[2]).toMatchObject({ exclusionSet: 'a', exclusions: [{ waterYear: 2017, reason: 'r' }], wr2012Band: false });
		expect(cells.at(-1)!.pan).toEqual({ label: 'flat 0.60', values: new Array(12).fill(0.6) });
		// Every objective the engine offers is a valid axis value (read from OBJECTIVES, never a copy of it).
		expect(new Set(cells.map((c) => c.objective))).toEqual(new Set(OBJECTIVES));
	});
});

describe('sweepRefusal', () => {
	const settings = sweepInputOf(doc()).settings;
	it('passes a grid the project can run', () => {
		expect(sweepRefusal(expandGrid({}, false), settings, {}, DEFAULT_MAX_CELLS)).toBeNull();
	});

	it('refuses more cells than the cap, until it is raised', () => {
		const g = parseGrid({ objectives: [...OBJECTIVES], bounds: ['wide', 'typical'], wr2012Band: [false, true], panPresets: ['project', 'generic', 'winter-rainfall'] });
		const cells = expandGrid(g, false);
		expect(cells.length).toBeGreaterThan(DEFAULT_MAX_CELLS);
		expect(sweepRefusal(cells, { ...settings, wr2012: { ...settings.wr2012, reference } }, g, DEFAULT_MAX_CELLS)).toMatch(/raise --max-cells/);
		expect(sweepRefusal(cells, { ...settings, wr2012: { ...settings.wr2012, reference } }, g, cells.length)).toBeNull();
	});

	it('refuses a pan preset under a monthly PE, but not the project’s own row', () => {
		const monthly = { ...settings, pe: { kind: 'monthly', mm: new Array(12).fill(100), source: 'ET₀' } } as unknown as ProjectSettings;
		expect(sweepRefusal(expandGrid({}, false), monthly, {}, DEFAULT_MAX_CELLS)).toBeNull();
		const g = parseGrid({ panPresets: ['project', 'generic'] });
		expect(sweepRefusal(expandGrid(g, false), monthly, g, DEFAULT_MAX_CELLS)).toMatch(/pan preset other than "project".*monthly PE row/);
	});

	it('refuses the band on without a WR2012 reference, or with a band the penalty rejects', () => {
		const g = parseGrid({ wr2012Band: [false, true] });
		expect(sweepRefusal(expandGrid(g, false), settings, g, DEFAULT_MAX_CELLS)).toMatch(/needs a WR2012 reference/);
		const withRef = { ...settings, wr2012: { ...settings.wr2012, reference } };
		expect(sweepRefusal(expandGrid(g, false), withRef, g, DEFAULT_MAX_CELLS)).toBeNull();
		const oneSided = parseGrid({ wr2012Band: [true], wr2012Penalty: { marLowMm3: 1 } });
		expect(sweepRefusal(expandGrid(oneSided, false), withRef, oneSided, DEFAULT_MAX_CELLS)).toMatch(/WR2012 penalty .* not valid/);
	});
});

describe('runCell (synthetic catchment, tiny budget)', () => {
	it('fits with validation and reports parameters, scores, MAR, the WR2012 ratio and EWR days', () => {
		const d = doc({ wr2012: { reference } });
		const base = sweepInputOf(d);
		const g = parseGrid({ bounds: ['typical'], objectives: ['nseSqrt'], exclusionSets: { a: [{ start: '2017-01-01', end: '2017-03-31', reason: 'invented outage' }] }, wr2012Band: [true], wr2012Penalty: { weight: 1 } });
		const [cell] = expandGrid(g, false);
		const r = runCell(base, cell!, g, { seed: 3, starts: 1, budget: 15, validationRecord: validationRecordOf(d, base.settings) });
		expect(r.flowKind).toBe('flow_observed_m3s');
		expect(r.budget).toBe(15);
		for (const k of ['x1', 'x2', 'x3', 'x4']) expect(Number.isFinite(r.params[k])).toBe(true);
		expect(r.fit.days).toBeGreaterThan(0);
		// The named set is left out on top of the (empty) stored exclusions: 90 days fewer scored than without it.
		const free = runCell(base, { ...cell!, exclusions: [] }, g, { seed: 3, starts: 1, budget: 15 });
		expect(free.fit.days - r.fit.days).toBe(90);
		expect(r.splitValidation?.days).toBeGreaterThan(0);
		expect(r.independentValidation).toBeNull(); // only one observed record
		expect(r.naturalMarMm3).toBeGreaterThan(0);
		expect(r.wr2012MarRatio).toBeGreaterThan(0);
		expect(r.ewrDaysNotMet).toBeGreaterThanOrEqual(0);
		expect(r.ewrFractionDaysNotMet).toBeLessThanOrEqual(1);
		// Same seed, same settings: the same fit.
		expect(runCell(base, cell!, g, { seed: 3, starts: 1, budget: 15 }).params).toEqual(r.params);
	});

	it('validates against the other record when the project has both', () => {
		const d = doc();
		d.series!.push({ ...d.series![1]!, kind: 'flow_logger_m3s' });
		expect(validationRecordOf(d, sweepInputOf(d).settings)).toBe('flow_logger_m3s');
		expect(validationRecordOf(doc(), sweepInputOf(doc()).settings)).toBeUndefined();
	});
});

describe('toMarkdown / toJson', () => {
	const scores = (v: number | null) => ({ days: 100, kgePrime: v, kgeYearly: v, kgeNp: v, nse: v, nseSqrt: v, nseLog: v, kgeLowHigh: v, volumeErrorPct: 1, fdcHighPct: 1, fdcMidSlopePct: 1, fdcLowPct: 1 });
	const result = (over: Partial<CellResult> = {}): CellResult => ({
		cell: { pan: { label: 'generic', values: new Array(12).fill(0.7) }, bounds: 'typical', objective: 'nseLog', exclusionSet: 'drop', exclusions: [{ start: '2018-01-01', end: '2018-02-01', reason: 'silted' }], wr2012Band: true },
		params: { x1: 350.25, x2: 0, x3: 90.5, x4: 1.75 },
		free: ['x1', 'x3', 'x4'],
		flowKind: 'flow_logger_m3s',
		budget: 40,
		fit: { ...scores(0.8), kgePrime: 0.75 },
		splitValidation: { ...scores(0.6), kgePrime: 0.55 },
		dryWetValidation: null,
		independentValidation: scores(0.4),
		naturalMarMm3: 1.234,
		wr2012MarRatio: 1.1,
		ewrDaysNotMet: 12,
		ewrFractionDaysNotMet: 0.0123,
		notes: ['an invented note'],
		...over
	});
	const meta: SweepMeta = {
		file: 'data/x/project.json',
		seed: 7,
		starts: 2,
		budget: undefined,
		validationRecord: 'flow_observed_m3s',
		grid: { exclusionSets: { none: [], drop: [{ start: '2018-01-01', end: '2018-02-01', reason: 'silted' }] }, wr2012Penalty: { weight: 1 } },
		generatedAt: '2026-01-01T00:00:00.000Z'
	};

	it('puts the engine version, seed, starts and budget in the header, one row per cell, ranking nothing', () => {
		const md = toMarkdown([result(), result({ wr2012MarRatio: null, independentValidation: null, cell: { ...result().cell, wr2012Band: false } })], meta);
		expect(md).toContain(`Engine ${ENGINE_VERSION}; seed 7, 2 starts, 40 runs per fit.`);
		expect(md).toContain('Fitted to `flow_logger_m3s`; independent record: `flow_observed_m3s`.');
		expect(md).toContain('- **drop**: 2018-01-01 – 2018-02-01 (silted)');
		expect(md).toContain('| 1 | generic | typical | nseLog | drop | on | 350.3 | 0.00 | 90.5 | 1.75 | 0.800 | 0.750 | 0.600 | 0.550 | – | 0.400 | 1.23 | 1.10 | 12 | 1.2 % |');
		expect(md).toContain('| 2 | generic | typical | nseLog | drop | off | 350.3 | 0.00 | 90.5 | 1.75 | 0.800 | 0.750 | 0.600 | 0.550 | – | – | 1.23 | – | 12 | 1.2 % |');
		expect(md).toContain('- #1: an invented note');
		expect(md).toContain('nothing is ranked');
		expect(md).toContain('gitignored');
	});

	it('writes the same results as JSON with the engine version', () => {
		const j = JSON.parse(toJson([result()], meta));
		expect(j.engineVersion).toBe(ENGINE_VERSION);
		expect(j.seed).toBe(7);
		expect(j.cells[0].params.x1).toBe(350.25);
	});
});

describe('CLI helpers', () => {
	it('intOption checks range and wholeness', () => {
		expect(intOption('seed', undefined, 1, 0, 10)).toBe(1);
		expect(intOption('seed', '4', 1, 0, 10)).toBe(4);
		expect(() => intOption('starts', '0', 5, 1, 10)).toThrow(/--starts must be a whole number from 1 to 10/);
		expect(() => intOption('budget', '1.5', undefined, 1, 10)).toThrow(/--budget/);
		expect(() => intOption('budget', 'x', undefined, 1, 10)).toThrow(/--budget/);
	});

	it('cliPath resolves against the directory the command was typed in (pnpm -C moves the working directory)', () => {
		expect(cliPath('data/p.json', { INIT_CWD: '/repo' })).toBe('/repo/data/p.json');
		expect(cliPath('/abs/p.json', { INIT_CWD: '/repo' })).toBe('/abs/p.json');
		expect(cliPath('p.json', {})).toBe(`${process.cwd()}/p.json`);
	});
});
