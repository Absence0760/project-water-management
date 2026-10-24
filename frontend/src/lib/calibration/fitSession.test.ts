import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STARTS, type CalibrationReport } from '@water-management/engine';
// runner.ts imports the worker's URL from a virtual module only the app build provides.
vi.mock('virtual:autocal-worker-url', () => ({ default: '' }));

import { FitSession } from './fitSession.svelte';
import { FitCancelled, type FitHandle } from './runner';

const report = { flowKind: 'flow_observed_m3s' } as unknown as CalibrationReport;
const context = () => Promise.resolve({ settings: {} as never, validate: true, validationRecord: null });

/** A fit the test settles by hand; cancel() rejects it as the real worker does. */
function deferredFit() {
	let resolve!: (r: CalibrationReport) => void;
	let reject!: (e: Error) => void;
	const result = new Promise<CalibrationReport>((res, rej) => ((resolve = res), (reject = rej)));
	const cancel = vi.fn(() => reject(new FitCancelled()));
	const handle: FitHandle = { result, cancel };
	return { handle, resolve, cancel };
}

describe('FitSession', () => {
	it('keeps a finished result until applied, and counts it as unapplied till then', async () => {
		const s = new FitSession();
		const f = deferredFit();
		const done = s.start(context, () => f.handle, () => undefined);
		await vi.waitFor(() => expect(s.status).toBe('running'));
		expect(s.unapplied).toBe(true);
		f.resolve(report);
		await done;
		expect(s.status).toBe('done');
		expect(s.report).toBe(report);
		expect(s.ran).toEqual({ settings: {}, validate: true, validationRecord: null });
		expect(s.unapplied).toBe(true);
		s.applied = true;
		expect(s.unapplied).toBe(false);
	});

	it('records the fitted record’s origin when the server gave one', async () => {
		const s = new FitSession();
		const f = deferredFit();
		const done = s.start(context, () => f.handle, () => null);
		await vi.waitFor(() => expect(s.status).toBe('running'));
		f.resolve(report);
		await done;
		expect(s.ran?.observedOrigin).toBeNull();
	});

	it('cancel stops the worker and keeps nothing', async () => {
		const s = new FitSession();
		const f = deferredFit();
		const done = s.start(context, () => f.handle, () => undefined);
		await vi.waitFor(() => expect(s.status).toBe('running'));
		s.cancel();
		await done;
		expect(f.cancel).toHaveBeenCalledOnce();
		expect(s.status).toBe('idle');
		expect(s.report).toBeNull();
		expect(s.unapplied).toBe(false);
	});

	it('a cancel while the data loads never starts the worker', async () => {
		const s = new FitSession();
		let loaded!: () => void;
		const prepare = () => new Promise<Awaited<ReturnType<typeof context>>>((res) => (loaded = () => res({ settings: {} as never, validate: false, validationRecord: null })));
		const run = vi.fn(() => deferredFit().handle);
		const done = s.start(prepare, run, () => undefined);
		expect(s.status).toBe('loading');
		s.cancel();
		loaded();
		await done;
		expect(run).not.toHaveBeenCalled();
		expect(s.status).toBe('idle');
	});

	it('a second start cancels the first, whose result never shows', async () => {
		const s = new FitSession();
		const first = deferredFit();
		const second = deferredFit();
		const a = s.start(context, () => first.handle, () => undefined);
		await vi.waitFor(() => expect(s.status).toBe('running'));
		const b = s.start(context, () => second.handle, () => undefined);
		expect(first.cancel).toHaveBeenCalledOnce();
		await a;
		await vi.waitFor(() => expect(s.status).toBe('running'));
		second.resolve(report);
		await b;
		expect(s.report).toBe(report);
		expect(s.status).toBe('done');
	});

	it('an error shows, and leaves nothing to apply', async () => {
		const s = new FitSession();
		await s.start(() => Promise.reject(new Error('no flow record')), () => deferredFit().handle, () => undefined);
		expect(s.status).toBe('error');
		expect(s.error).toBe('no flow record');
		expect(s.unapplied).toBe(false);
	});

	it('discard drops the result; reset also restores the default choices for another project', async () => {
		const s = new FitSession();
		const f = deferredFit();
		const done = s.start(context, () => f.handle, () => undefined);
		await vi.waitFor(() => expect(s.status).toBe('running'));
		f.resolve(report);
		await done;
		s.starts = 2;
		s.picked = { x1: true };
		s.discard();
		expect(s.report).toBeNull();
		expect(s.status).toBe('idle');
		expect(s.starts).toBe(2);
		s.reset('p2');
		expect(s.projectId).toBe('p2');
		expect(s.starts).toBe(5);
		expect(s.picked).toEqual({});
	});

	describe('searchFrom (issue #554)', () => {
		const record = { bounds: 'typical', budget: 800, starts: 3, seed: 42 } as const;

		it('starts the Search choices from the project’s fit record', () => {
			const s = new FitSession();
			s.reset('p1');
			s.searchFrom(record);
			expect([s.bounds, s.budget, s.starts, s.seed]).toEqual(['typical', 800, 3, 42]);
		});

		it('keeps the defaults without a record, and applies one a later load brings', () => {
			const s = new FitSession();
			s.reset('p1');
			s.searchFrom(null);
			expect([s.bounds, s.budget, s.starts, s.seed]).toEqual(['wide', 1500, DEFAULT_STARTS, 1]);
			s.searchFrom(record);
			expect(s.seed).toBe(42);
		});

		it('a reload of the same project keeps a choice made since; another project starts from its own record', () => {
			const s = new FitSession();
			s.reset('p1');
			s.searchFrom(record);
			s.seed = 7;
			s.searchFrom(record);
			expect(s.seed).toBe(7);
			s.reset('p2');
			expect(s.seed).toBe(1);
			s.searchFrom({ ...record, seed: 9 });
			expect(s.seed).toBe(9);
		});

		it('reads a record from before starts were recorded as one start', () => {
			const s = new FitSession();
			s.reset('p1');
			s.searchFrom({ bounds: 'wide', budget: 1500, seed: 1 });
			expect(s.starts).toBe(1);
		});
	});
});
