import { describe, expect, it } from 'vitest';
import type { DelineationProposal, DelineationRequest } from '$lib/api/types';
import { afterPollError, COPERNICUS_NOTICE, datasetNotice, failedText, POLL_GIVE_UP, isWaiting, openProposal, panFacts, proposalFacts, provenanceFacts, waitingText } from './delineation';

const proposal = (over: Partial<DelineationProposal> = {}): DelineationProposal => ({
	id: 'p1',
	status: 'proposed',
	from: 'outlet',
	click: [20.7, -33.5],
	outlet: [20.7, -33.5],
	snapDistanceM: 127.6,
	geometry: { type: 'Polygon', coordinates: [[[20, -33], [21, -33], [21, -34], [20, -33]]] },
	areaM2: 547_190_000,
	cells: 33_609,
	cellSizeM: 127.6,
	zoom: 10,
	windowCells: 1024,
	dataset: 'Synthetic DEM 1',
	datasetFingerprint: '0e25a572b5cf789a',
	method: 'D8 …',
	methodVersion: 'delineate-1',
	pans: null,
	featureId: null,
	createdBy: 'Ann',
	createdAt: '2026-10-01T00:00:00Z',
	decidedBy: null,
	decidedAt: null,
	...over
});

describe('delineation helpers', () => {
	it('finds the one open proposal', () => {
		expect(openProposal(null)).toBeNull();
		expect(openProposal({ available: true, dataset: null, request: null, proposals: [proposal({ status: 'rejected' })] })).toBeNull();
		expect(openProposal({ available: true, dataset: null, request: null, proposals: [proposal({ id: 'a', status: 'superseded' }), proposal({ id: 'b' })] })?.id).toBe('b');
	});

	it('words the facts: area, snap, cells, dataset with its fingerprint, method with its version', () => {
		const f = Object.fromEntries(proposalFacts(proposal()));
		expect(f.Area).toBe('547.19 km²');
		expect(f['The point is']).toBe('the catchment’s outlet');
		expect(f.Outlet).toBe('128 m from the point, on the channel');
		expect(f.Cells).toMatch(/ cells, each about 128 m across$/);
		const how = Object.fromEntries(provenanceFacts(proposal()));
		expect(how.Dataset).toBe('Synthetic DEM 1 (0e25a572b5cf789a)');
		expect(how.Method).toMatch(/\[delineate-1\]$/);
		expect(Object.fromEntries(proposalFacts(proposal({ snapDistanceM: 0.2 }))).Outlet).toBe('where the point was');
	});

	it('reports the area draining into pans and the effective area beside it (delineate-9), and nothing before it', () => {
		const pans = {
			nonContributingM2: 54_719_000,
			count: 3,
			largest: [{ at: [26.1, -28.3] as [number, number], floorM2: 2_000_000, depthM: 4.5, drainsM2: 30_000_000, storageMm: 210 }],
			method: 'Non-contributing (pans): …'
		};
		const f = Object.fromEntries(proposalFacts(proposal({ pans })));
		expect(f['Into pans']).toBe('54.72 km² (10 %) drains into 3 pans; the largest holds 210 mm over its 30.00 km². Non-contributing in WR2012’s sense; still inside the area and outline');
		expect(f['Effective area']).toBe('492.47 km², if the pans contribute nothing');
		expect(Object.fromEntries(provenanceFacts(proposal({ pans }))).Pans).toBe('Non-contributing (pans): …');
		// None found: said so, and no effective area to offer.
		expect(panFacts({ areaM2: 1e6, pans: { ...pans, nonContributingM2: 0, count: 0, largest: [] } })).toEqual([['Into pans', 'none found (no closed depression deep and large enough)']]);
		// A proposal from before delineate-9 never looked: nothing said either way.
		expect(panFacts(proposal())).toEqual([]);
		expect(provenanceFacts(proposal()).map(([k]) => k)).toEqual(['Dataset', 'Method']);
	});

	it('lists storage on a river apart from the pans (delineate-12), and says nothing when there is none or it wasn’t checked', () => {
		const at = [29.09, -28.58] as [number, number];
		const pans = { nonContributingM2: 0, count: 0, largest: [], method: 'm' };
		const one = { ...pans, onRiver: { count: 1, largest: [{ at, floorM2: 1_595_686, depthM: 8, drainsM2: 29_909_565, storageMm: 371, by: 'river' as const }] } };
		expect(panFacts({ areaM2: 61e6, pans: one })).toEqual([
			['Into pans', 'none found (no closed depression deep and large enough)'],
			['Storage on a river', 'A closed depression holds as much as a pan, but a mapped river flows out of it over a wall: storage on a river, so the 29.91 km² draining into it is not counted as non-contributing']
		]);
		const dams = { ...pans, onRiver: { count: 2, largest: [{ ...one.onRiver.largest[0]!, by: 'dam' as const }] } };
		expect(Object.fromEntries(panFacts({ areaM2: 61e6, pans: dams }))['Storage on a river']).toBe(
			'2 closed depressions hold as much as pans, but a mapped river flows out of each over a wall or a dam holds it: storage on a river, not counted as non-contributing (the largest has 29.91 km² draining into it)'
		);
		expect(panFacts({ areaM2: 61e6, pans: { ...pans, onRiver: { count: 0, largest: [] } } })).toHaveLength(1);
	});

	it('carries the Copernicus notice for the GLO-30 DEM only', () => {
		expect(datasetNotice({ label: '© Mapterhorn', attribution: '© Mapterhorn' })).toBe(COPERNICUS_NOTICE);
		expect(datasetNotice({ label: 'Synthetic DEM 1', attribution: 'synthetic' })).toBeNull();
		expect(datasetNotice(null)).toBeNull();
	});
});

describe('a delineation the background worker has', () => {
	const request = (over: Partial<DelineationRequest> = {}): DelineationRequest => ({
		id: 'r1',
		status: 'queued',
		from: 'outlet',
		click: [20.7, -33.5],
		progress: null,
		error: null,
		proposal: null,
		check: null,
		refusal: null,
		createdAt: '2026-10-03T00:00:00.000Z',
		finishedAt: null,
		...over
	});

	it('is waited for only while queued or running', () => {
		expect(isWaiting(request())).toBe(true);
		expect(isWaiting(request({ status: 'running' }))).toBe(true);
		for (const status of ['failed', 'proposed', 'refused', 'superseded'] as const) expect(isWaiting(request({ status })), status).toBe(false);
		expect(isWaiting(null)).toBe(false);
	});

	it('says it is queued, then how far it has run', () => {
		expect(waitingText(request())).toMatch(/^The catchment is too large to work out at once, so it is queued for the background\./);
		expect(waitingText(request({ status: 'running', progress: 0 }))).toMatch(/^Working out the catchment in the background\. A large/);
		expect(waitingText(request({ status: 'running', progress: 50 }))).toMatch(/^Working out the catchment in the background \(50 % through\)\./);
	});

	it('says why it failed, without a stray full stop, and nothing for a cancel', () => {
		expect(failedText(request({ status: 'failed', error: 'The elevation model could not be read just now.' }))).toBe(
			'The background delineation failed: The elevation model could not be read just now. Try again, or draw or import the boundary.'
		);
		expect(failedText(request({ status: 'failed', error: 'cancelled' }))).toBe('The background delineation failed. Try again, or draw or import the boundary.');
	});

	it('keeps asking after a failed ask (the job runs on), giving up after five in a row or at once on a 404', () => {
		expect(POLL_GIVE_UP).toBe(5);
		for (let n = 1; n < 5; n++) {
			expect(afterPollError(n, undefined), `network ${n}`).toBe('retry');
			expect(afterPollError(n, 503), `503 ${n}`).toBe('retry');
		}
		expect(afterPollError(5, undefined)).toBe('give_up');
		expect(afterPollError(5, 500)).toBe('give_up');
		expect(afterPollError(1, 404)).toBe('give_up');
	});
});
