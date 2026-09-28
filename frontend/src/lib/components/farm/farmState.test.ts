import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FarmIndex, FarmView } from '@water-management/engine';
import { ApiError } from '$lib/api/client';
import { clearFarmMemo, FarmState } from './farmState.svelte';
import { vaalbankFixture } from './fixture';
import { readSaved, SAVED_KEY, writeSaved } from './savedCopy';

const P = 'p-sandspruit';
const N = 'n-vaalbank';
const index = (publication: FarmIndex['publication'] = { publishedAt: '2024-01-12T08:00:00Z', restriction: { level: 'advisory' } }): FarmIndex => ({
	project: { id: P, name: 'Sandspruit (example catchment)', wuaName: 'Sandspruit WUA' },
	farms: [{ nodeId: N, name: 'Vaalbank (example)' }],
	publication
});

function fakeApi(opts: { index?: () => Promise<FarmIndex>; view?: () => Promise<FarmView>; role?: string } = {}) {
	return {
		farm: {
			index: vi.fn(opts.index ?? (async () => index())),
			view: vi.fn(opts.view ?? (async () => vaalbankFixture())),
			exportUrl: () => '',
			access: vi.fn(async () => [])
		},
		projects: { list: vi.fn(async () => [{ id: P, role: opts.role ?? 'farmer' }] as never) }
	};
}

beforeEach(() => {
	const m = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k)
	});
	clearFarmMemo();
});
afterEach(() => vi.unstubAllGlobals());

describe('FarmState', () => {
	it('loads the only farm of a project and keeps it as the saved copy', async () => {
		const api = fakeApi();
		const s = new FarmState(api, () => 'u1');
		await s.load(P, null);
		expect(s.phase).toEqual({ kind: 'ready' });
		expect(s.nodeId).toBe(N);
		expect(s.view?.farm.name).toBe('Vaalbank (example)');
		expect(s.fromSaved).toBe(false);
		expect(readSaved('u1', P, N)?.view.farm.name).toBe('Vaalbank (example)');
	});

	it('asks for the index and the view together when the farm is known', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const api = fakeApi({ index: async () => (await gate, index()) });
		const s = new FarmState(api, () => 'u1');
		const done = s.load(P, N);
		expect(api.farm.view).toHaveBeenCalledWith(P, N);
		release();
		await done;
		expect(api.farm.view).toHaveBeenCalledTimes(1);
	});

	it('shows the saved copy at once, "updating", then the live answer', async () => {
		const at = Date.now() - 60_000;
		writeSaved('u1', P, N, vaalbankFixture(), at);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const s = new FarmState(fakeApi({ index: async () => (await gate, index()) }), () => 'u1');
		const done = s.load(P, null);
		expect(s.phase.kind).toBe('ready');
		expect(s.fromSaved).toBe(true);
		expect(s.updating).toBe(true);
		expect(s.savedAt).toBe(at);
		release();
		await done;
		expect(s.fromSaved).toBe(false);
		expect(s.updating).toBe(false);
	});

	it('keeps the saved copy under the offline strip when there is no signal', async () => {
		const at = Date.now() - 60_000;
		writeSaved('u1', P, N, vaalbankFixture(), at);
		const s = new FarmState(fakeApi({ index: async () => Promise.reject(new ApiError(0, 'x')) }), () => 'u1');
		await s.load(P, N);
		expect(s.phase.kind).toBe('ready');
		expect(s.offline).toBe(true);
		expect(s.fromSaved).toBe(true);
		expect(s.savedAt).toBe(at);
	});

	it('shows the error state without a saved copy, counting the attempts', async () => {
		const s = new FarmState(fakeApi({ index: async () => Promise.reject(new ApiError(0, 'x')) }), () => 'u1');
		await s.load(P, N);
		expect(s.phase).toEqual({ kind: 'error', offline: true, attempts: 1 });
		await s.load(P, N);
		expect(s.phase).toEqual({ kind: 'error', offline: true, attempts: 2 });
		const f = new FarmState(fakeApi({ view: async () => Promise.reject(new ApiError(500, 'x')) }), () => 'u1');
		await f.load(P, N);
		expect(f.phase).toEqual({ kind: 'error', offline: false, attempts: 1 });
	});

	it('says access was removed on a 403 or 404 and clears the saved copy', async () => {
		for (const status of [403, 404]) {
			writeSaved('u1', P, N, vaalbankFixture());
			const s = new FarmState(fakeApi({ view: async () => Promise.reject(new ApiError(status, 'x')) }), () => 'u1');
			await s.load(P, N);
			expect(s.phase).toEqual({ kind: 'removed' });
			expect(s.view).toBeNull();
			expect(readSaved('u1', P, N)).toBeNull();
		}
	});

	it('treats a ?node= that isn’t the user’s as removed', async () => {
		const s = new FarmState(fakeApi(), () => 'u1');
		await s.load(P, 'someone-else');
		expect(s.phase).toEqual({ kind: 'removed' });
	});

	it('shows the no-publication state when nothing is published', async () => {
		const s = new FarmState(fakeApi({ index: async () => index(null) }), () => 'u1');
		await s.load(P, null);
		expect(s.phase).toEqual({ kind: 'no-publication' });
		expect(s.farmName).toBe('Vaalbank (example)');
		expect(s.projectName).toBe('Sandspruit (example catchment)');
		// The contact line names the WUA from the index before any view (095_wua_name).
		expect(s.wuaName).toBe('Sandspruit WUA');
	});

	it('takes the WUA’s name from the view once it arrives, and none from a copy saved before it existed', async () => {
		const named = new FarmState(fakeApi({ view: async () => ({ ...vaalbankFixture(), project: { ...vaalbankFixture().project, wuaName: 'Vaalbank WUA' } }) }), () => 'u1');
		await named.load(P, N);
		expect(named.wuaName).toBe('Vaalbank WUA');
		const old = new FarmState(
			fakeApi({ index: async () => ({ ...index(), project: { id: P, name: 'X' } as FarmIndex['project'] }), view: async () => ({ ...vaalbankFixture(), project: { id: P, name: 'X' } as FarmView['project'] }) }),
			() => 'u-old-copy'
		);
		await old.load(P, N);
		expect(old.wuaName).toBeNull();
	});

	it('marks a viewer+ as previewing and keeps no copy for them', async () => {
		const s = new FarmState(fakeApi({ role: 'viewer' }), () => 'u1');
		await s.load(P, N);
		expect(s.phase.kind).toBe('ready');
		expect(s.preview).toBe(true);
		expect(localStorage.getItem(SAVED_KEY)).toBeNull();
		const f = new FarmState(fakeApi(), () => 'u1');
		await f.load(P, N);
		expect(f.preview).toBe(false);
	});

	it('treats an applicant linked to the farm as its own, not a preview (WP-3.3)', async () => {
		const s = new FarmState(fakeApi({ role: 'contributor' }), () => 'u1');
		await s.load(P, N);
		expect(s.phase.kind).toBe('ready');
		expect(s.preview).toBe(false);
		expect(localStorage.getItem(SAVED_KEY)).not.toBeNull();
	});

	it('reuses a view fetched a moment ago on the next farm page', async () => {
		const api = fakeApi();
		await new FarmState(api, () => 'u1').load(P, N);
		const s = new FarmState(api, () => 'u1');
		await s.load(P, N);
		expect(api.farm.index).toHaveBeenCalledTimes(1);
		expect(s.phase.kind).toBe('ready');
		await s.load(P, N, { quiet: true, fresh: true });
		expect(api.farm.index).toHaveBeenCalledTimes(2);
		// Another user on the same tab asks the server again.
		await new FarmState(api, () => 'u2').load(P, N);
		expect(api.farm.index).toHaveBeenCalledTimes(3);
	});
});
