import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoCalibration } from '$lib/api/types';
import { AutoCalibrationFollower, POLL_MS, type AutoCalibrationApi } from './autoFollow.svelte';

/** A run of the rules: two cases planned, `done` of them fitted. */
function run(id: string, done: number, status: AutoCalibration['status'] = 'running'): AutoCalibration {
	return {
		id,
		status,
		cases: Array.from({ length: done }, () => ({})),
		plan: { cases: [{}, {}], years: [], ruleExclusions: [] },
		job: { status: 'running' },
		error: null,
		chosen: status === 'complete' ? 0 : null
	} as unknown as AutoCalibration;
}

/** Resolve a promise the test controls. */
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

function stubApi(o: Partial<AutoCalibrationApi> = {}) {
	return {
		list: vi.fn(o.list ?? (async () => [])),
		get: vi.fn(o.get ?? (async (_p: string, id: string) => run(id, 2, 'complete'))),
		start: vi.fn(o.start ?? (async () => ({ calibration: run('new', 0) }))),
		apply: vi.fn(o.apply ?? (async (_p: string, id: string) => ({ calibration: run(id, 2, 'complete'), runError: null })))
	};
}

/** Let pending promise callbacks run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AutoCalibrationFollower', () => {
	it('shows the latest run, and polls a running one until it completes', async () => {
		let n = 0;
		const api = stubApi({
			list: async () => [run('a1', 0)],
			get: async (_p, id) => (++n < 2 ? run(id, 1) : run(id, 2, 'complete'))
		});
		const f = new AutoCalibrationFollower(api);
		f.open('A');
		await settle();
		expect(api.list).toHaveBeenCalledWith('A');
		expect(f.latest?.id).toBe('a1');
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(f.latest?.cases).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(f.latest?.status).toBe('complete');
		// Complete: no more polls.
		await vi.advanceTimersByTimeAsync(POLL_MS * 5);
		expect(api.get).toHaveBeenCalledTimes(2);
		expect(api.get).toHaveBeenCalledWith('A', 'a1');
	});

	it('does not poll a run that is already complete, failed or stopped', async () => {
		for (const latest of [run('c', 2, 'complete'), run('f', 0, 'failed'), { ...run('d', 0), job: { status: 'dead' } } as unknown as AutoCalibration]) {
			const api = stubApi({ list: async () => [latest] });
			const f = new AutoCalibrationFollower(api);
			f.open('A');
			await settle();
			await vi.advanceTimersByTimeAsync(POLL_MS * 3);
			expect(f.latest?.id).toBe(latest.id);
			expect(api.get).not.toHaveBeenCalled();
		}
	});

	it('a project with no run shows none', async () => {
		const f = new AutoCalibrationFollower(stubApi());
		f.open('A');
		await settle();
		expect(f.latest).toBeNull();
		expect(f.error).toBeNull();
	});

	it('another project never shows the first one’s running run, and the first one’s polling stops', async () => {
		const api = stubApi({ list: async (p) => (p === 'A' ? [run('a1', 0)] : []), get: async (_p, id) => run(id, 1) });
		const f = new AutoCalibrationFollower(api);
		f.open('A');
		await settle();
		expect(f.latest?.id).toBe('a1');
		f.open('B');
		await settle();
		expect(f.latest).toBeNull();
		await vi.advanceTimersByTimeAsync(POLL_MS * 5);
		expect(f.latest).toBeNull();
		expect(api.get).not.toHaveBeenCalled();
	});

	it('a poll still in flight when another project opens is dropped, and schedules nothing', async () => {
		const pending = deferred<AutoCalibration>();
		const api = stubApi({ list: async (p) => (p === 'A' ? [run('a1', 0)] : []), get: () => pending.promise });
		const f = new AutoCalibrationFollower(api);
		f.open('A');
		await settle();
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(api.get).toHaveBeenCalledTimes(1);
		f.open('B');
		await settle();
		pending.resolve(run('a1', 1));
		await settle();
		expect(f.latest).toBeNull();
		await vi.advanceTimersByTimeAsync(POLL_MS * 5);
		expect(api.get).toHaveBeenCalledTimes(1);
	});

	it('a load still in flight when another project opens is dropped', async () => {
		const slowA = deferred<AutoCalibration[]>();
		const api = stubApi({ list: (p) => (p === 'A' ? slowA.promise : Promise.resolve([run('b1', 2, 'complete')])) });
		const f = new AutoCalibrationFollower(api);
		f.open('A');
		f.open('B');
		await settle();
		expect(f.latest?.id).toBe('b1');
		slowA.resolve([run('a1', 0)]);
		await settle();
		expect(f.latest?.id).toBe('b1');
		await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		expect(api.get).not.toHaveBeenCalled();
	});

	it('a failed poll in the old project shows no error in the new one', async () => {
		const pending = deferred<AutoCalibration>();
		const api = stubApi({ list: async (p) => (p === 'A' ? [run('a1', 0)] : []), get: () => pending.promise });
		const f = new AutoCalibrationFollower(api);
		f.open('A');
		await settle();
		await vi.advanceTimersByTimeAsync(POLL_MS);
		f.open('B');
		pending.reject(new Error('not found'));
		await settle();
		expect(f.error).toBeNull();
	});

	it('close stops polling, and drops a reply in flight', async () => {
		const pending = deferred<AutoCalibration>();
		const api = stubApi({ list: async () => [run('a1', 0)], get: () => pending.promise });
		const f = new AutoCalibrationFollower(api);
		f.open('A');
		await settle();
		await vi.advanceTimersByTimeAsync(POLL_MS);
		f.close();
		expect(f.projectId).toBeNull();
		pending.resolve(run('a1', 1));
		await settle();
		expect(f.latest?.cases).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(POLL_MS * 5);
		expect(api.get).toHaveBeenCalledTimes(1);
	});

	it('start asks for the shown project, follows the new run, and is busy only until the server answers', async () => {
		const started = deferred<{ calibration: AutoCalibration }>();
		const api = stubApi({ start: () => started.promise, get: async (_p, id) => run(id, 2, 'complete') });
		const f = new AutoCalibrationFollower(api);
		f.open('A');
		await settle();
		const done = f.start();
		expect(f.busy).toBe(true);
		// A second click while it waits does nothing.
		void f.start();
		expect(api.start).toHaveBeenCalledTimes(1);
		started.resolve({ calibration: run('a2', 0) });
		await done;
		expect(f.busy).toBe(false);
		expect(api.start).toHaveBeenCalledWith('A');
		expect(f.latest?.id).toBe('a2');
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(api.get).toHaveBeenCalledWith('A', 'a2');
		expect(f.latest?.status).toBe('complete');
	});

	it('a start answered after another project opened is not shown there and polls nothing', async () => {
		const started = deferred<{ calibration: AutoCalibration }>();
		const api = stubApi({ start: () => started.promise });
		const f = new AutoCalibrationFollower(api);
		f.open('A');
		await settle();
		const done = f.start();
		f.open('B');
		await settle();
		expect(f.busy).toBe(false);
		started.resolve({ calibration: run('a2', 0) });
		await done;
		expect(f.latest).toBeNull();
		expect(f.busy).toBe(false);
		await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		expect(api.get).not.toHaveBeenCalled();
	});

	it('a refused start shows why', async () => {
		const f = new AutoCalibrationFollower(stubApi({ start: () => Promise.reject(new Error('Too many queued runs')) }));
		f.open('A');
		await settle();
		await f.start();
		expect(f.error).toBe('Too many queued runs');
		expect(f.busy).toBe(false);
	});

	it('apply shows the applied run and its run error, then reloads the settings', async () => {
		const api = stubApi({
			list: async () => [run('a1', 2, 'complete')],
			apply: async (_p, id) => ({ calibration: { ...run(id, 2, 'complete'), appliedAt: '2026-10-08T10:00:00Z' } as AutoCalibration, runError: 'no rain series' })
		});
		const f = new AutoCalibrationFollower(api);
		const onApplied = vi.fn(async () => {});
		f.open('A');
		await settle();
		await f.apply(onApplied);
		expect(api.apply).toHaveBeenCalledWith('A', 'a1');
		expect(f.latest?.appliedAt).toBe('2026-10-08T10:00:00Z');
		expect(f.runError).toBe('no rain series');
		expect(onApplied).toHaveBeenCalledOnce();
	});

	it('an apply answered after another project opened never reloads that project’s settings', async () => {
		const applied = deferred<{ calibration: AutoCalibration; runError: string | null }>();
		const api = stubApi({ list: async (p) => (p === 'A' ? [run('a1', 2, 'complete')] : []), apply: () => applied.promise });
		const f = new AutoCalibrationFollower(api);
		const onApplied = vi.fn(async () => {});
		f.open('A');
		await settle();
		const done = f.apply(onApplied);
		f.open('B');
		await settle();
		applied.resolve({ calibration: run('a1', 2, 'complete'), runError: null });
		await done;
		expect(onApplied).not.toHaveBeenCalled();
		expect(f.latest).toBeNull();
	});

	it('does nothing before a project is open, or with no run to apply', async () => {
		const api = stubApi();
		const f = new AutoCalibrationFollower(api);
		await f.start();
		await f.apply(async () => {});
		expect(api.start).not.toHaveBeenCalled();
		f.open('A');
		await settle();
		await f.apply(async () => {});
		expect(api.apply).not.toHaveBeenCalled();
	});
});
