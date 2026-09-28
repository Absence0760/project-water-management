import { band, type Band, type ResolvedEnsembleOptions } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { Ensemble } from '$lib/api';
import { abandonedText, bandCells, coverageText, fdcChart, historyRows, isPaired, pct, pointsBelowEwr, rangeText, rejectedText, shownEnsemble, sig } from './bands';

const gated: Band = { n: 5, p5: null, p50: null, p95: null, min: 1, max: 9 };
const b = band(Array.from({ length: 40 }, (_, i) => i + 1));

const options = (over: Partial<ResolvedEnsembleOptions> = {}) =>
	({
		model: 'gr4j',
		method: 'lhs',
		members: 300,
		seed: 11,
		bounds: 'typical',
		free: ['x1', 'x3', 'x4'],
		panOffset: 0.1,
		rainSources: ['recorded'],
		records: ['flow_observed_m3s'],
		thresholds: { objective: 'kgePrime', minSkill: 0.5, wr2012MaxLevel: 'query', maxLowFlowBiasPct: 50 },
		dimensions: [],
		holdOut: 'secondHalf',
		percentiles: [5, 50, 95],
		minMembers: 30,
		coverageWarning: 0.7,
		...over
	}) as ResolvedEnsembleOptions;
const ens = (over: Partial<Ensemble>): Ensemble => ({
	id: 'e',
	runId: 'r',
	baselineId: null,
	baselineRunId: null,
	runoffModel: 'gr4j',
	engineVersion: '0.26.0',
	method: 'lhs',
	seed: 11,
	members: 300,
	options: options(),
	status: 'complete',
	accepted: 120,
	summary: null,
	createdAt: '2026-09-25T10:00:00Z',
	createdBy: 'Hydro',
	createdById: 'u',
	completedAt: '2026-09-25T10:01:00Z',
	...over
});

describe('band text', () => {
	it('shows the 5–95 % range and three cells, or dashes when the band is gated', () => {
		expect(rangeText(b)).toBe('2.95 – 38.1');
		expect(bandCells(b)).toEqual(['2.95', '20.5', '38.1']);
		expect(rangeText(gated)).toBe('–');
		expect(bandCells(gated)).toEqual(['–', '–', '–']);
	});
	it('rounds to about three significant figures', () => {
		expect([sig(1234.5), sig(12.34), sig(1.234), sig(0.01234), sig(null)]).toEqual(['1\u202f235', '12.3', '1.23', '0.012', '–']);
		expect(pct(0.694)).toBe('69 %');
	});
});

describe('coverage and rejections', () => {
	it('says how many held-out observations fall inside, or why none is given', () => {
		expect(coverageText({ record: 'flow_logger_m3s', heldOutDays: 2456, inside: 1705, fraction: 0.694, warning: true }, 30)).toBe(
			'1\u202f705 of 2\u202f456 held-out logger record observations (69 %) fall inside the 5–95 % band.'
		);
		expect(coverageText({ record: 'flow_observed_m3s', heldOutDays: 100, inside: null, fraction: null, warning: false }, 30)).toBe(
			'Withheld for the gauge record: fewer than 30 parameter sets kept.'
		);
	});
	it('lists rejection reasons, most common first', () => {
		expect(rejectedText({ skill: 2, wr2012: 0, lowFlow: 197 })).toBe('197 on the low-flow check, 2 on the skill score');
		expect(rejectedText({ skill: 0, wr2012: 0, lowFlow: 0 })).toBe('none');
	});
});

describe('the history of a run’s ensembles', () => {
	const shown = ens({ id: 'b' });
	const list = [
		ens({ id: 'c', status: 'started', accepted: null, completedAt: null, seed: 5 }),
		shown,
		ens({ id: 'a', options: options({ thresholds: { objective: 'kgePrime', minSkill: 0.3, wr2012MaxLevel: 'query', maxLowFlowBiasPct: 50 } }) }),
		ens({ id: 'p', baselineId: 'x', baselineRunId: 'y' })
	];

	it('shows the newest complete ensemble of the run itself, never a paired one', () => {
		expect(shownEnsemble(list)?.id).toBe('b');
		expect(shownEnsemble([ens({ id: 'p', baselineId: 'x' })])).toBeNull();
	});
	it('lists every start with what differs from the shown rule', () => {
		const rows = historyRows(list, shown);
		expect(rows.map((r) => [r.id, r.status, r.shown])).toEqual([
			['c', 'started, never stored', false],
			['b', 'stored', true],
			['a', 'stored', false]
		]);
		expect(rows.find((r) => r.id === 'a')!.changes).toEqual([{ label: 'Lowest skill kept', a: '0.5', b: '0.3' }]);
		expect(rows.find((r) => r.id === 'b')!.changes).toEqual([]);
	});
	it('counts the starts never stored', () => {
		expect(abandonedText(list)).toBe(
			'1 of the 3 ensembles started for this run was never stored (cancelled or abandoned). Every start is kept, with its seed and rule.'
		);
		expect(abandonedText([shown])).toBeNull();
	});
	it('tells a paired summary from an ensemble summary', () => {
		expect(isPaired({ members: 40 } as never)).toBe(true);
		expect(isPaired({ accepted: 40 } as never)).toBe(false);
		expect(isPaired(null)).toBe(false);
	});
});

describe('the monthly flow-duration chart', () => {
	const pts = [5, 50, 95];
	const bands = [band(Array.from({ length: 30 }, () => 1000)), band(Array.from({ length: 30 }, () => 100)), band(Array.from({ length: 30 }, () => 10))];

	it('draws the band, the median and the EWR on a log axis', () => {
		const c = fdcChart(bands, pts, 100, 520, 240);
		expect(c.band.startsWith('M')).toBe(true);
		expect(c.band.endsWith('Z')).toBe(true);
		expect(c.median.split('L')).toHaveLength(3);
		// 100 is the log-midpoint of 10 … 1000 with equal padding, so it sits mid-plot.
		expect(c.ewrY).toBeCloseTo((8 + (240 - 26)) / 2, 0);
		expect(c.yTicks.map((t) => t.label)).toEqual(['10', '100', '1\u202f000']);
		expect(pointsBelowEwr(bands, 100)).toBe(1);
	});
	it('draws no band when it is gated, and keeps zero flows on the axis floor', () => {
		const c = fdcChart([gated, gated, gated], pts, 50, 520, 240);
		expect(c.band).toBe('');
		expect(c.median).toBe('');
		const zero = fdcChart([bands[0]!, bands[1]!, band(Array.from({ length: 30 }, () => 0))], pts, 0, 520, 240);
		expect(zero.ewrY).toBeNull();
		expect(zero.band).not.toMatch(/NaN|Infinity/);
	});
});
