import { describe, expect, it } from 'vitest';
import { YIELD_DEFAULT_TOLERANCE, type ScenarioOp, type YieldPoint } from '@water-management/engine';
import type { JobMeta, RunMeta, YieldJob, YieldResult } from '#lib/api/index.js';
import { fmtNum } from '#lib/format/number.js';
import {
	assuranceLabel,
	cancellableJobStatus,
	curveChart,
	curveRangeText,
	engineDiffersNote,
	jobStatus,
	jobToFollow,
	latestResults,
	modelRuns,
	noDamText,
	parseMaxCapacity,
	patternChoices,
	patternLabel,
	patternParams,
	PREVIEW_TOLERANCE,
	previewSource,
	noInflowText,
	staleNote,
	startLabel,
	yieldWithheld,
	type CurveResult
} from './yield';

const job = (over: Partial<JobMeta>): JobMeta => ({
	id: 'j',
	kind: 'yield',
	status: 'queued',
	attempts: 0,
	maxAttempts: 2,
	runAfter: '',
	createdAt: '',
	startedAt: null,
	finishedAt: null,
	error: null,
	createdBy: 'A',
	progress: null,
	...over
});

const point = (capacityM3: number, yieldM3Day: number): YieldPoint => ({
	capacityM3,
	yieldM3Day,
	yieldM3Year: yieldM3Day * 365.25,
	failsAtM3Day: yieldM3Day * 1.001,
	failureDays: 0,
	failedYears: 0,
	boundM3Day: yieldM3Day * 2,
	probes: 12
});

const params = { pattern: 'constant' as const, assurance: 1, tolerance: 0.001, points: 11 };
const base = { runId: 'r', scenarioId: null, nodeId: 'n', jobId: null, params, engineVersion: '0.34.0', createdBy: 'A', createdAt: '2026-09-26T10:00:00Z' };

describe('jobToFollow', () => {
	const pending = (id: string, status: JobMeta['status']): YieldJob => ({
		...job({ id, status }),
		target: { nodeId: 'n', runId: 'r', scenarioId: null, kind: 'firm', params: { pattern: 'constant', assurance: 1, tolerance: 0.001, points: 11 } }
	});
	it('prefers a running job, then the newest waiting one, then one waiting to retry', () => {
		expect(jobToFollow([])).toBeNull();
		expect(jobToFollow([pending('q2', 'queued'), pending('r', 'running'), pending('f', 'failed')])?.id).toBe('r');
		expect(jobToFollow([pending('f', 'failed'), pending('q2', 'queued'), pending('q1', 'queued')])?.id).toBe('q2');
		expect(jobToFollow([pending('f', 'failed')])?.id).toBe('f');
		expect(jobToFollow([pending('d', 'done'), pending('x', 'dead')])).toBeNull();
	});
});

describe('jobStatus', () => {
	it('says what the job is doing, with its progress, and nothing once done', () => {
		expect(jobStatus(null)).toBeNull();
		expect(jobStatus(job({ status: 'queued' }))).toEqual({ text: 'Queued: waiting for the background worker.', busy: true, failed: false });
		expect(jobStatus(job({ status: 'running' }))?.text).toBe('Running…');
		expect(jobStatus(job({ status: 'running', progress: 45 }))?.text).toBe('Running: 45 % done.');
		expect(jobStatus(job({ status: 'done' }))).toBeNull();
		expect(jobStatus(job({ status: 'dead', error: 'cancelled' }))).toEqual({ text: 'Cancelled.', busy: false, failed: true });
		expect(jobStatus(job({ status: 'dead', error: 'the yield search failed: no demand' }))?.text).toBe('Failed: the yield search failed: no demand.');
		expect(jobStatus(job({ status: 'failed', error: 'a database error (SQLSTATE 40001)' }))?.text).toMatch(/^Failed, will retry/);
	});
});

describe('cancellableJobStatus', () => {
	it('offers Cancel while the job waits or runs, until this page asked', () => {
		expect(cancellableJobStatus(null, null)).toBeNull();
		expect(cancellableJobStatus(job({ status: 'done' }), null)).toBeNull();
		expect(cancellableJobStatus(job({ status: 'queued' }), null)).toEqual({ text: 'Queued: waiting for the background worker.', busy: true, failed: false, cancelled: false, canCancel: true });
		expect(cancellableJobStatus(job({ status: 'running', progress: 10 }), null)).toMatchObject({ text: 'Running: 10 % done.', canCancel: true });
		// Asked: a running job stops at its next step, and no second Cancel shows meanwhile.
		expect(cancellableJobStatus(job({ status: 'running', progress: 10 }), 'j')).toEqual({ text: 'Cancelling: it stops at its next step.', busy: true, failed: false, cancelled: false, canCancel: false });
		// Another job than the one asked about is offered as usual.
		expect(cancellableJobStatus(job({ id: 'k', status: 'running' }), 'j')).toMatchObject({ text: 'Running…', canCancel: true });
	});

	it('says a cancelled job plainly, never as a failure', () => {
		expect(cancellableJobStatus(job({ status: 'dead', error: 'cancelled' }), 'j')).toEqual({ text: 'Cancelled.', busy: false, failed: false, cancelled: true, canCancel: false });
		expect(cancellableJobStatus(job({ status: 'dead', error: 'the future yield failed: no dam' }), null)).toMatchObject({ failed: true, cancelled: false, canCancel: false });
		expect(cancellableJobStatus(job({ status: 'failed', error: 'timeout' }), null)).toMatchObject({ failed: true, busy: false, canCancel: false });
	});
});

describe('latestResults', () => {
	it('takes the newest of each kind (the API lists newest first)', () => {
		const results: YieldResult[] = [
			{ ...base, id: 'c2', kind: 'curve', points: { baseCapacityM3: 10, assurance: 1, points: [point(0, 1)], monotone: true } },
			{ ...base, id: 'f2', kind: 'firm', points: { point: point(10, 5) } },
			{ ...base, id: 'f1', kind: 'firm', points: { point: point(10, 4) } }
		];
		const l = latestResults(results);
		expect(l.firm?.id).toBe('f2');
		expect(l.curve?.id).toBe('c2');
		expect(latestResults([])).toEqual({ firm: null, curve: null });
	});
});

describe('curveChart', () => {
	it('plots yield against capacity in thousand m³', () => {
		const curve = { ...base, id: 'c', kind: 'curve', points: { baseCapacityM3: 20_000, assurance: 1, points: [point(0, 3), point(20_000, 8), point(40_000, 9)], monotone: true } } as CurveResult;
		const c = curveChart(curve);
		expect(c.xy.x).toEqual([0, 20, 40]);
		expect(c.xy.ys).toEqual([[3, 8, 9]]);
		expect(c.series).toHaveLength(1);
	});
});

describe('labels', () => {
	it('names patterns, assurance levels and the runs a yield can use', () => {
		expect(patternLabel({ pattern: 'constant' })).toBe('constant draft');
		expect(patternLabel({ pattern: 'demand' })).toBe("this hydrological unit's demand shape");
		expect(patternLabel({ pattern: new Array(12).fill(1) })).toBe('custom monthly shape');
		expect(assuranceLabel(1)).toBe('firm');
		expect(assuranceLabel(0.95)).toBe('95 % assurance');
		const runs = [{ id: 'f', scenarioId: null, trigger: 'forecast' }, { id: 'a', scenarioId: 's' }, { id: 'b', scenarioId: null, trigger: 'manual' }, { id: 'c' }] as RunMeta[];
		// A forecast run is never offered (issue #51: a yield is judged on history).
		expect(modelRuns(runs).map((r) => r.id)).toEqual(['b', 'c']);
		expect(modelRuns(null)).toEqual([]);
	});
});

describe("the Draft pattern: any unit's irrigation demand (engine 1.117.0)", () => {
	const units = [
		{ nodeId: 'z', name: 'Riverside', demand: true },
		{ nodeId: 'h', name: 'Hilltop', demand: false },
		{ nodeId: 'b', name: 'Bare', demand: false },
		{ nodeId: 'k', name: 'Meadow', demand: true }
	];

	it("a dam whose unit has no demand: Constant, its own disabled with the reason, then each other unit with demand in the model's order", () => {
		expect(patternChoices(units, 'h')).toEqual([
			{ value: 'constant', label: 'Constant: the same every day' },
			{ value: 'demand', label: "This hydrological unit's irrigation demand, by month (it has none: no crops or demand objects)", disabled: true },
			{ value: 'unit:z', label: "Riverside's irrigation demand, by month" },
			{ value: 'unit:k', label: "Meadow's irrigation demand, by month" }
		]);
	});

	it('a unit with demand: its own enabled, itself not listed again; before the units load, the two it always had', () => {
		expect(patternChoices(units, 'z').map((c) => [c.value, !!c.disabled])).toEqual([
			['constant', false],
			['demand', false],
			['unit:k', false]
		]);
		expect(patternChoices(null, 'h')).toEqual([
			{ value: 'constant', label: 'Constant: the same every day' },
			{ value: 'demand', label: "This hydrological unit's irrigation demand, by month" }
		]);
	});

	it('maps each choice to the request: no patternNodeId for the dam’s own, as every request before', () => {
		expect(patternParams('constant')).toEqual({ pattern: 'constant' });
		expect(patternParams('demand')).toEqual({ pattern: 'demand' });
		expect(patternParams('unit:z')).toEqual({ pattern: 'demand', patternNodeId: 'z' });
	});

	it("labels another unit's shape by the name it had, and says when it was renamed or removed", () => {
		const p = { pattern: 'demand' as const, patternNodeId: 'z', patternNodeName: 'Riverside' };
		expect(patternLabel(p)).toBe("Riverside's irrigation demand shape");
		expect(patternLabel(p, units)).toBe("Riverside's irrigation demand shape");
		expect(patternLabel(p, [{ nodeId: 'z', name: 'Riverside Noord', demand: true }])).toBe("Riverside's irrigation demand shape (the unit now called Riverside Noord)");
		expect(patternLabel(p, [])).toBe("Riverside's irrigation demand shape (that unit is no longer in this model)");
		// A preview (no stored name) names it from the model.
		expect(patternLabel({ pattern: 'demand', patternNodeId: 'k' }, units)).toBe("Meadow's irrigation demand shape");
	});
});

describe('a unit with no dam, and sizing a proposed one', () => {
	it('says plainly that it has no dam, and when its dam receives no water', () => {
		expect(noDamText('Hilltop')).toBe('Hilltop has no dam in this model (capacity 0 m³). In a scenario, add a change that sets its dam capacity, then work out the yield.');
		expect(noDamText(' ')).toMatch(/^This unit has no dam/);
		const none = { runoffToDam: 0, upstreamToDam: 0, upstreamUnits: 2, riverToDam: false, transfersIn: 0, receives: false };
		expect(noInflowText('Hilltop', none)).toBe(
			"Hilltop's dam receives no water in this model: Runoff to dam is 0 % and Upstream inflow to dam is 0 %. In the scenario, set the share of its runoff (and of the river above it) that the dam catches."
		);
		expect(noInflowText('Hilltop', { ...none, upstreamToDam: 1, upstreamUnits: 0 })).toMatch(/Upstream inflow to dam is 100 % but no unit drains into it\./);
		expect(noInflowText('Hilltop', { ...none, runoffToDam: 0.5, receives: true })).toBeNull();
		expect(noInflowText('Hilltop', null)).toBeNull();
	});

	it("flags a scenario's stored yield worked out on other changes than the scenario has now", () => {
		const sc = { opsSha256: 'b'.repeat(64), updatedAt: '2026-11-09T10:00:00Z' };
		const r = { scenarioId: 's', createdAt: '2026-11-09T09:00:00Z' };
		expect(staleNote({ ...r, opsSha256: 'b'.repeat(64) }, sc)).toBeNull();
		expect(staleNote({ ...r, opsSha256: 'a'.repeat(64) }, sc)).toBe("Worked out before the scenario's latest changes: work it out again.");
		// From before the app recorded the changes: judged by when the scenario last changed.
		expect(staleNote({ ...r, opsSha256: null }, sc)).toMatch(/^Worked out before the scenario was last changed/);
		expect(staleNote({ ...r, opsSha256: null, createdAt: '2026-11-09T11:00:00Z' }, sc)).toBeNull();
		// A run's yield, or no scenario to compare with.
		expect(staleNote({ scenarioId: null, opsSha256: null, createdAt: r.createdAt }, sc)).toBeNull();
		expect(staleNote({ ...r, opsSha256: 'a'.repeat(64) }, null)).toBeNull();
	});

	it('reads the "Up to" capacity: empty is twice the dam, a number above 0, spaced or comma thousands', () => {
		expect(parseMaxCapacity('')).toEqual({ value: undefined });
		expect(parseMaxCapacity('  ')).toEqual({ value: undefined });
		expect(parseMaxCapacity('300 000')).toEqual({ value: 300_000 });
		expect(parseMaxCapacity('1,500,000')).toEqual({ value: 1_500_000 });
		expect(parseMaxCapacity('2500.5')).toEqual({ value: 2500.5 });
		for (const bad of ['0', '-5', 'abc', '1e6', '5 m³']) expect(parseMaxCapacity(bad)).toHaveProperty('error');
		expect(parseMaxCapacity('2000000000000')).toEqual({ error: 'Enter at most 1 000 000 000 000 m³.' });
	});

	it("describes a curve's range: twice the dam for a stored curve without a maximum, else the maximum entered", () => {
		const c = (cap: number, max?: number) =>
			({ ...base, id: 'c', kind: 'curve', params: { ...base.params, ...(max ? { maxCapacityM3: max } : {}) }, points: { baseCapacityM3: cap, assurance: 1, points: [point(0, 0), point(1, 1), point(2, 2)], monotone: true } }) as CurveResult;
		expect(curveRangeText(c(20_000))).toBe(`at 3 capacities from 0 to twice the dam's ${fmtNum(20_000)} m³`);
		expect(curveRangeText(c(20_000, 90_000))).toBe(`at 3 capacities from 0 to ${fmtNum(90_000)} m³ (the dam holds ${fmtNum(20_000)} m³)`);
		expect(curveRangeText(c(0, 300_000))).toBe(`at 3 capacities from 0 to ${fmtNum(300_000)} m³ (sizing a proposed dam: the unit has no dam in this model)`);
	});
});

describe('how a stored yield started the record', () => {
	it('half full from engine 1.117.0; before it, the dam’s own initial storage, said so', () => {
		for (const v of ['1.117.0', '1.117.1', '1.118.0', '2.0.0']) expect(startLabel(v)).toBe('half full');
		for (const v of ['1.116.0', '1.34.0', '0.34.0']) expect(startLabel(v)).toBe("at the dam's own initial storage (worked out before engine 1.117.0, which starts every yield half full)");
		expect(startLabel('garbage')).toMatch(/^at the dam's own/);
	});
});

describe('the in-browser preview', () => {
	it("searches to the job's default tolerance, the engine's", () => {
		expect(PREVIEW_TOLERANCE).toBe(YIELD_DEFAULT_TOLERANCE);
	});

	it("runs on the picked run's own input", () => {
		expect(previewSource(null, 'r1', null)).toEqual({ runId: 'r1', ops: undefined, key: 'r:r1' });
		expect(previewSource(null, '', null)).toBeNull();
	});

	it("runs a scenario's saved ops on its base run, and changes key when the ops or the base do", () => {
		const ops: ScenarioOp[] = [{ op: 'node.remove', nodeId: 'n' }];
		const a = previewSource('s1', 'ignored', { baseRunId: 'b1', ops, opsSha256: 'h1' });
		expect(a).toEqual({ runId: 'b1', ops, key: 's:s1:b1:h1' });
		expect(previewSource('s1', '', { baseRunId: 'b1', ops, opsSha256: 'h2' })!.key).not.toBe(a!.key);
		expect(previewSource('s1', '', { baseRunId: 'b2', ops, opsSha256: 'h1' })!.key).not.toBe(a!.key);
	});

	it('offers none for a scenario given no base (an application: the server masks it)', () => {
		expect(previewSource('s1', 'r1', null)).toBeNull();
	});
});

describe('engineDiffersNote', () => {
	it('says nothing when nothing is stored or the stored result is on the preview\'s engine', () => {
		expect(engineDiffersNote('1.34.0', null)).toBeNull();
		expect(engineDiffersNote('1.34.0', { engineVersion: '1.34.0' })).toBeNull();
	});

	it('names both engines when the stored result came from another one', () => {
		const note = engineDiffersNote('1.34.0', { engineVersion: '1.33.0' });
		expect(note).toBe(
			'The stored yield below was worked out on engine 1.33.0 and this preview on engine 1.34.0, so the two can differ by what changed between those versions.'
		);
	});
});

describe('a yield withheld from a viewer kept from the volumes (#523 I)', () => {
	it('is skipped as the latest result and said; a result with points is the positive control', () => {
		const withheld = { id: 'w', kind: 'firm', points: null, withheld: ['points'] } as unknown as YieldResult;
		const shown = { id: 's', kind: 'firm', points: { point: { yieldM3Day: 5 } } } as unknown as YieldResult;
		expect(latestResults([withheld]).firm).toBeNull();
		expect(latestResults([withheld, shown]).firm?.id).toBe('s');
		expect([yieldWithheld([withheld]), yieldWithheld([shown])]).toEqual([true, false]);
	});
});
