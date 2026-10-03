import { describe, expect, it } from 'vitest';
import type { DelineationProposal, DelineationRequest } from '$lib/api/types';
import { COPERNICUS_NOTICE, datasetNotice, failedText, isWaiting, openProposal, proposalFacts, provenanceFacts, waitingText } from './delineation';

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
});
