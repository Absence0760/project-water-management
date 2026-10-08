import { describe, expect, it, vi } from 'vitest';
import type { CalibrationReport } from '@water-management/engine';
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
});
