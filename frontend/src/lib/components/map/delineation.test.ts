import { describe, expect, it } from 'vitest';
import type { DelineationProposal } from '$lib/api/types';
import { COPERNICUS_NOTICE, datasetNotice, openProposal, proposalFacts, provenanceFacts } from './delineation';

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
		expect(openProposal({ available: true, dataset: null, proposals: [proposal({ status: 'rejected' })] })).toBeNull();
		expect(openProposal({ available: true, dataset: null, proposals: [proposal({ id: 'a', status: 'superseded' }), proposal({ id: 'b' })] })?.id).toBe('b');
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
