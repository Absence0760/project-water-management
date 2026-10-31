// A cap or full-allocation run as a viewer kept from each registered volume
// reads it: verdicts and counts only, an allowlist (issue #523 finding I,
// rounds 4 and 5, verdictsOnly.ts); the licence-impact boards' waterfalls on
// every report. The round-5 gauge and board probes run here on the engine's
// invented outlook catchment: each recovers the volume from the full output
// (the positive control) and finds nothing to read in what the viewer gets.
import { licenceImpactBoard, runModelChecked, type ModelInput, type ModelOutput } from '@water-management/engine';
import { randomInput } from '@water-management/engine/testing';
import { describe, expect, it } from 'vitest';
import { testCatchment } from '../../../packages/engine/src/outlook/testCatchment.js';
import { ALLOCATION_SERIES_KEYS, authorisedVerdicts, boardVerdicts, combinedDamVerdicts, ensembleVerdicts, reportVerdictsOnly, verdictsOnly, verdictsReport, verdictsSummary } from './verdictsOnly.js';
import { redactRunAllocations } from './viewerUnits.js';
import { sweepForViewer } from '../sweeps/routes.js';
import type { SweepRow } from '../sweeps/store.js';
import { withholdingFor } from '../runs/withheldSeries.js';

const VOL = 123_457;

/** Every number in a JSON value. */
const numbers = (v: unknown): number[] => (typeof v === 'number' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(numbers) : []);

/** The invented catchment with one surface allocation on Farm A, in `mode`; `gauge`: a gauge directly below a dam-less A. */
function catchment(mode: 'none' | 'cap' | 'fullAllocation', gauge = false): { input: ModelInput; out: ModelOutput } {
	const x = testCatchment() as ModelInput;
	if (gauge) {
		const a = x.model.nodes.find((n) => n.id === 'a')!;
		Object.assign(a, { downstreamNodeId: 'ga', damCapacityM3: 0, damInitialPct: 0, pctRunoffToDam: 1, damAreaFullM2: null });
		x.model.nodes.push({ ...x.model.nodes.find((n) => n.id === 'g')!, id: 'ga', name: 'Gauge below A', downstreamNodeId: 'g', sortOrder: 3 });
	}
	x.model.allocations = [{ id: 'a-s', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: VOL, storageM3: null, validFrom: null, validTo: null }];
	x.settings = { ...x.settings, allocationMode: mode };
	return { input: x, out: runModelChecked(x) };
}

const epoch = (d: string) => Date.parse(`${d}T00:00:00Z`) / 864e5;

describe('which runs give a viewer kept from the volumes verdicts and counts only', () => {
	it('a cap or full-allocation run; not a compare-only run', () => {
		expect([verdictsOnly({ mode: 'cap' }), verdictsOnly({ mode: 'fullAllocation' }), verdictsOnly({ mode: 'none' }), verdictsOnly(null)]).toEqual([true, true, false, false]);
	});

	it('no series of such a run at all; on any other run all but the allocation series', () => {
		const capped = withholdingFor({ mode: 'cap' });
		expect(['natural_flow', 'simulated_outflow', 'ewr', 'ewr_shortfall'].map((k) => capped.withheld(null, k))).toEqual([true, true, true, true]);
		expect(capped.withheld('g', 'inflow_upstream')).toBe(true);
		const plain = withholdingFor({ mode: 'none' });
		expect([plain.withheld('a', 'supplied'), plain.withheld(null, 'simulated_outflow'), plain.withheld('a', 'allocation_room_surface')]).toEqual([false, false, true]);
		expect(ALLOCATION_SERIES_KEYS.size).toBe(5);
	});
});

// Round 5 (I), the gauge probe (r5i/gauge.mts): a dam-less unit with a gauge directly below gives its supply exactly,
// every day, from the natural flow times its share less the gauge's inflow.
describe('the round-5 gauge probe', () => {
	for (const mode of ['cap', 'fullAllocation'] as const)
		it(`${mode}: recovers the volume from the full series (positive control); that viewer reads none of them`, () => {
			const { input, out } = catchment(mode, true);
			const probe = (visible: ModelOutput['series']) => {
				const get = (nodeId: string | null, key: string) => visible.find((r) => r.nodeId === nodeId && r.key === key)?.values;
				const nat = get(null, 'natural_flow');
				const ewr = get(null, 'ewr');
				const gaIn = get('ga', 'inflow_upstream');
				const gaZ = get('ga', 'ewr_cumulative');
				if (!nat || !ewr || !gaIn || !gaZ) return [];
				const k = 1 - input.model.nodes.find((n) => n.id === 'a')!.returnFlowFraction!;
				const start = epoch(out.startDate);
				return [2002, 2003, 2004].map((wy) => {
					let s = 0;
					for (let t = epoch(`${wy}-10-01`) - start; t < epoch(`${wy + 1}-10-01`) - start; t++) s += ((nat[t]! * (ewr[t]! > 0 ? gaZ[t]! / ewr[t]! : 0)) - gaIn[t]!) / k;
					return s;
				});
			};
			expect(probe(out.series).some((v) => Math.abs(v - VOL) < 1)).toBe(true);
			const w = withholdingFor(out.summary.allocations);
			expect(out.series.filter((r) => !w.withheld(r.nodeId, r.key))).toEqual([]);
			expect(probe(out.series.filter((r) => !w.withheld(r.nodeId, r.key)))).toEqual([]);
		});
});

// Round 5 (I), the board probes (r5i/board2.mts, board3.mts): the authorised board (full allocation, on every
// application's report) and a cap scenario's own board give the existing use, which less the other unit's is the volume.
describe('the round-5 board probe', () => {
	const series = (o: ModelOutput, k: string) => o.series.find((r) => r.nodeId === null && r.key === k)!.values;
	for (const mode of ['cap', 'fullAllocation'] as const)
		it(`${mode}: the board's waterfall gives the volume (positive control); boardVerdicts keeps the verdicts only`, () => {
			const run = catchment(mode).out;
			const base = catchment('none').out;
			const r = { startDate: run.startDate, summary: run.summary, natural: series(run, 'natural_flow'), ewrShortfall: series(run, 'ewr_shortfall') };
			const board = licenceImpactBoard(r as never, r as never, { yearClassMethod: 'auto', siteNodeId: null, nameOf: () => null });
			expect(board.result.status).toBe('ok');
			const bOf = (o: ModelOutput, n: string, k: string) => o.series.find((x) => x.nodeId === n && x.key === k)!.values;
			const start = epoch(base.startDate);
			const bUse = (wy: number) => {
				let s = 0;
				for (let t = epoch(`${wy}-10-01`) - start; t < epoch(`${wy + 1}-10-01`) - start; t++) s += bOf(base, 'b', 'supplied')[t]! - bOf(base, 'b', 'return_flow')[t]!;
				return s;
			};
			const probe = (b: typeof board) =>
				b.result.status !== 'ok'
					? []
					: b.result.impact.classes.flatMap((c) => (c.waterfall ? [(c.waterfall.existingUseM3 - c.waterYears.reduce((s, wy) => s + bUse(wy), 0) / c.waterYears.length) / 0.9] : []));
			if (mode === 'fullAllocation') expect(probe(board).some((v) => Math.abs(v - VOL) < 1)).toBe(true);
			const mine = boardVerdicts(board);
			expect(probe(mine)).toEqual([]);
			if (mine.result.status === 'ok') {
				for (const c of mine.result.impact.classes) expect([c.waterfall, c.lowerM3, c.upperM3]).toEqual([null, null, null]);
				expect(mine.result.impact.classes.map((c) => c.verdict)).toEqual(board.result.status === 'ok' ? board.result.impact.classes.map((c) => c.verdict) : []);
			}
		});
});

describe('the authorised board as that viewer reads it (#523 G2)', () => {
	it('drops the pair’s reproduction record (digests, kinds by allocation id) beside boardVerdicts; a board without one is unchanged but for its verdicts', () => {
		const board = { classes: [{ classId: 'dry', label: 'Dry', verdict: 'noChange', waterfall: { existingUseM3: VOL }, lowerM3: 1, upperM3: 2 }] };
		const lia = { status: 'ok', board, reproduction: { baselineResultsSha256: 'a'.repeat(64), kinds: [{ allocationId: 'x', authorisation: 'licence' }] } };
		const mine = authorisedVerdicts(lia);
		expect(mine).not.toHaveProperty('reproduction');
		expect(mine).toEqual({ status: 'ok', board: boardVerdicts(board) });
		expect(authorisedVerdicts({ status: 'ok', board })).toEqual(boardVerdicts({ status: 'ok', board }));
		expect(authorisedVerdicts(null)).toBeNull();
	});
});

describe('a run summary as that viewer reads it', () => {
	for (const mode of ['cap', 'fullAllocation'] as const)
		it(`${mode}: counts and verdicts only; no flow, volume, unit or use total; the rest named withheld`, () => {
			const { out } = catchment(mode, true);
			const s = verdictsSummary(structuredClone(out.summary)) as unknown as Record<string, unknown> & { withheld: string[]; catchment: Record<string, unknown>; allocations: Record<string, unknown> };
			expect(Object.keys(s).every((k) => ['historyDays', 'catchment', 'ewrCompliance', 'ewrAssurance', 'servedWhileEwrFails', 'forecast', 'farms', 'users', 'warnings', 'warningCodes', 'calibration', 'allocations', 'withheld'].includes(k))).toBe(true);
			expect(s.catchment.meanSimulatedOutflowM3Day).toBeNull();
			expect(s.allocations.verdictsOnly).toBe(true);
			// The coded warnings go with the warnings: their texts and figures could name a volume.
			expect([s.warnings, s.warningCodes, s.withheld.includes('warningCodes')]).toEqual([[], [], false]);
			expect(s.withheld).toEqual(expect.arrayContaining(['waterBalance', 'supplyAssurance', 'runoff']));
			// No figure, nor any difference of two, is the volume (the derived canary).
			const n = numbers(s);
			expect(n.some((a) => n.some((b) => Math.abs(a - b - VOL) < 1))).toBe(false);
			expect(verdictsSummary(s)).toBe(s);
		});

	it('a compare-only run comes back as it is (positive control); redactRunAllocations and a sweep member go through it', () => {
		const plain = catchment('none').out.summary;
		expect(verdictsSummary(plain)).toBe(plain);
		expect((redactRunAllocations({ summary: catchment('cap').out.summary }).summary as { farms: unknown[] }).farms).toEqual([]);
		const full = catchment('fullAllocation').out;
		const sweep = { id: 's', members: [{ name: 'm', ops: [], summary: full.summary, series: full.series.filter((r) => r.nodeId === null) }] } as unknown as SweepRow;
		const member = sweepForViewer(sweep).members[0]!;
		expect([member.series, member.withheld]).toEqual([null, ['series']]);
	});

	it('fuzz: no unit, flow series or use total of any engine summary is left, in either mode', () => {
		let runs = 0;
		for (let seed = 1; seed <= 60; seed++) {
			const input = randomInput(seed, { maxNodes: 8, maxDays: 500 }) as ModelInput;
			if (!input.model.allocations?.length) continue;
			const units = new Set(input.model.nodes.filter((n) => n.kind !== 'gauge').map((n) => n.id));
			for (const mode of ['cap', 'fullAllocation'] as const) {
				const out = verdictsSummary(runModelChecked({ ...input, settings: { ...input.settings, allocationMode: mode } }).summary);
				const left: string[] = [];
				const walk = (v: unknown, at: string): void => {
					if (typeof v === 'string' && units.has(v)) left.push(at);
					else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (units.has(k) ? left.push(`${at}.${k}`) : walk(x, `${at}.${k}`));
				};
				walk(out, `seed ${seed} ${mode}`);
				expect(left).toEqual([]);
				expect(JSON.stringify(out)).not.toMatch(/(M3Day|Mcm|M3|Mm3)"\s*:\s*-?\d/);
				runs++;
			}
		}
		expect(runs).toBeGreaterThan(10);
	}, 120_000);
});

describe('an ensemble of such a run', () => {
	it('each member its EWR counts and rates only; no outflow, natural, shortfall or unit figure', () => {
		const metrics = { ewrDaysNotMet: 3, shortfallMm3: 1, marOutflowMm3: 9, annualOutflowMm3: [9], fdcM3Day: [[1]], curtailmentM3Day: { a: -2 }, unitDemandM3Day: { a: VOL / 365 }, reserveRate: { outlet: 0.9 } };
		const row = {
			result: { header: { farms: [{ nodeId: 'a' }], units: [{ nodeId: 'a' }], ewrByMonthM3Day: [5], reserveSites: [{ key: 'outlet' }] }, members: [{ index: 0, metrics }] },
			summary: { reference: metrics, bands: { curtailment: [{ nodeId: 'a' }], marOutflowMm3: { p50: 9 }, ewrDaysNotMet: { p50: 3 } } }
		};
		const out = ensembleVerdicts(row);
		expect(out.result.members[0]!.metrics).toEqual({ ewrDaysNotMet: 3, reserveRate: { outlet: 0.9 }, curtailmentM3Day: {} });
		expect(out.result.header).toEqual({ farms: [], units: [], ewrByMonthM3Day: [], reserveSites: [{ key: 'outlet' }] });
		expect(out.summary.bands).toMatchObject({ ewrDaysNotMet: { p50: 3 }, marOutflowMm3: null, curtailment: [] });
	});
});

describe('an evidence report on such a run', () => {
	const report = (mode: string) => ({
		version: 'evidence-18',
		rows: [{ id: 'reserve' }, { id: 'userSupply' }, { id: 'shortfall' }, { id: 'outflowMar' }, { id: 'ewrDays' }],
		flags: [{ id: 'noRule' }, { id: 'allocationsOver' }],
		questions: ['q'],
		users: [{ nodeId: 'a' }],
		servedWhileFailing: { notAssessed: null, sites: [{ key: 'outlet', name: 'Weir', isOutlet: true, basis: 'x', daysNotMetA: 1, daysNotMetB: 2, units: [{ nodeId: 'a' }] }] },
		allocations: { modeA: 'none', modeB: mode, units: [{ nodeId: 'a' }] },
		licenceImpact: { result: { status: 'ok', impact: { classes: [{ classId: 'dry', label: 'Dry', nYears: 3, enoughYears: true, waterYears: [2001], lowerM3: 1, upperM3: 2, waterfall: { existingUseM3: VOL }, below: { units: 12 }, verdict: 'worse' }], warnings: ['w'] } } },
		river: [{ key: 'outlet', months: [{ year: 2001, month: 1, waterYear: 2000, deliveredA: 0.5, deliveredB: 0.25, metA: false, metB: false }], worst: { year: 2001, month: 1, delivered: 0.25 }, naturalMar: { runMcm: 3 }, fdcBands: [] }],
		newSection: { m3: VOL },
		appendix: { warnings: { baseline: ['w'], application: ['w'] }, baselineInputs: {} },
		summaries: { baseline: { allocations: { mode: 'none' } }, application: { allocations: { mode }, waterBalance: { total: VOL } } }
	});

	it('only the listed sections: count rows and flags, sites as verdicts, the board’s verdicts; a new section withheld', () => {
		const out = verdictsReport(report('cap') as never) as unknown as ReturnType<typeof report> & { withheld: string[] };
		expect(reportVerdictsOnly(out as never)).toBe(true);
		expect(out.rows.map((r) => r.id)).toEqual(['reserve', 'ewrDays']);
		expect(out.flags.map((f) => f.id)).toEqual(['noRule']);
		expect([out.users, out.questions, out.allocations.units, out.servedWhileFailing.sites[0]!.units]).toEqual([[], [], [], []]);
		// No share delivered: share × the base run's requirement would be the month's flow (#523 I, round 6).
		expect(out.river[0]).toMatchObject({ key: 'outlet', months: [{ year: 2001, month: 1, waterYear: 2000, metA: false, metB: false, deliveredA: null, deliveredB: null }], worst: { year: 2001, month: 1, delivered: null }, naturalMar: null, fdcBands: null });
		expect(JSON.stringify(out.river)).not.toMatch(/0\.25|0\.5\b/);
		expect(out.licenceImpact.result.impact.classes[0]).toEqual({ classId: 'dry', label: 'Dry', nYears: 3, enoughYears: true, waterYears: [2001], below: { units: 12 }, verdict: 'worse', lowerM3: null, upperM3: null, waterfall: null });
		expect('newSection' in out).toBe(false);
		expect(out.withheld).toEqual(expect.arrayContaining(['newSection', 'users', 'licenceImpact']));
		expect(JSON.stringify(out)).not.toContain(String(VOL));
	});

	it('a report on two compare-only runs comes back as it is (positive control); its boards are cut by boardVerdicts alone', () => {
		const r = report('none');
		expect(verdictsReport(r as never)).toBe(r);
		expect(JSON.stringify(boardVerdicts(r.licenceImpact))).not.toContain(String(VOL));
	});
});

describe('§ 4’s combined dams as that viewer reads them (evidence-26)', () => {
	const m = (b: number, c: number) => ({ baseline: b, combined: c, change: c - b, sumOfSingles: c - b, interaction: 0 });
	const dam = (nodeId: string, onVolumes: boolean) => ({
		nodeId,
		name: `Dam ${nodeId}`,
		firmYield: m(VOL, VOL - 1000),
		reliability: m(0.9, 0.8),
		verdict: { firmYield: 'lower', reliability: 'lower' },
		onVolumes
	});
	const cumulative = (onVolumes: boolean) => ({ applications: [], counted: 0, truncated: false, total: { ewrDays: 3, reservePp: null }, withThis: null, combined: { notAssessed: null, ewrDays: m(4, 7), dams: [dam('a', onVolumes), dam('b', false)] } });
	const report = (mode: string, onVolumes = false) => ({
		version: 'evidence-26',
		cumulative: cumulative(onVolumes),
		summaries: { baseline: { allocations: { mode } }, application: { allocations: { mode: 'none' } } }
	});
	const withheld = (nodeId: string) => ({ nodeId, name: `Dam ${nodeId}`, verdict: { firmYield: 'lower', reliability: 'lower' }, onVolumes: nodeId === 'a', firmYield: null, reliability: null, withheld: true });

	it('on a cap or full-allocation report every dam keeps its direction and loses its yield and assurance; the EWR counts stay', () => {
		for (const mode of ['cap', 'fullAllocation']) {
			const out = verdictsReport(report(mode, true) as never) as unknown as ReturnType<typeof report>;
			expect(out.cumulative.combined.dams).toEqual([withheld('a'), { ...withheld('b'), onVolumes: false }]);
			expect(out.cumulative.combined.ewrDays).toEqual(m(4, 7));
			expect(JSON.stringify(out.cumulative)).not.toContain(String(VOL - 1000));
		}
	});

	it('on any other report only a dam whose yields rest on the volumes is cut (redactReportAllocations); one on compare-only runs is read in full (positive control)', () => {
		const c = cumulative(true);
		const out = combinedDamVerdicts(c, false);
		expect(out.combined.dams).toEqual([withheld('a'), dam('b', false)]);
		expect(verdictsReport(report('none') as never)).toEqual(report('none'));
		// A dam without the flag (hand-edited, or a shape this code doesn't know) counts as resting on them.
		const unflagged = { combined: { dams: [{ ...dam('c', false), onVolumes: undefined }] } };
		expect((combinedDamVerdicts(unflagged, false).combined.dams[0] as { withheld?: true }).withheld).toBe(true);
		// Nothing to cut: a report before evidence-26, or no combined section.
		const before = { combined: { notAssessed: 'x' } };
		expect(combinedDamVerdicts(before, true)).toBe(before);
	});
});
