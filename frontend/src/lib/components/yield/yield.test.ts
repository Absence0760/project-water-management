import { describe, expect, it } from 'vitest';
import type { YieldPoint } from '@water-management/engine';
import type { JobMeta, RunMeta, YieldJob, YieldResult } from '$lib/api';
import { assuranceLabel, curveChart, jobStatus, jobToFollow, latestResults, modelRuns, patternLabel, type CurveResult } from './yield';

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
		expect(patternLabel('constant')).toBe('constant draft');
		expect(patternLabel('demand')).toBe("this hydrological unit's demand shape");
		expect(patternLabel(new Array(12).fill(1))).toBe('custom monthly shape');
		expect(assuranceLabel(1)).toBe('firm');
		expect(assuranceLabel(0.95)).toBe('95 % assurance');
		const runs = [{ id: 'f', scenarioId: null, trigger: 'forecast' }, { id: 'a', scenarioId: 's' }, { id: 'b', scenarioId: null, trigger: 'manual' }, { id: 'c' }] as RunMeta[];
		// A forecast run is never offered (issue #51: a yield is judged on history).
		expect(modelRuns(runs).map((r) => r.id)).toEqual(['b', 'c']);
		expect(modelRuns(null)).toEqual([]);
	});
});
