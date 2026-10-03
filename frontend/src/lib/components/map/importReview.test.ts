// The upload sheet's review (importReview.ts, issue #326 D2): which kinds a
// row may take, "set every row's kind", the one-boundary rule, replacing the
// current boundary only with the tick, and the body.
import { describe, expect, it } from 'vitest';
import type { MapImportPreview } from '$lib/api/types';
import { importBody, kindCounts, kindsFor, nodesFor, replaceBoundaryText, replacesBoundary, reviewedFeatures, reviewProblems, reviewRows, setEveryKind, withKind, type ReviewNode } from './importReview';

const nodes: ReviewNode[] = [
	{ id: 'g', name: 'Weir', kind: 'gauge' },
	{ id: 'f', name: 'Upper farm', kind: 'farm' },
	{ id: 'u', name: 'Town', kind: 'user' }
];
const preview: MapImportPreview = {
	fileName: 'mixed.geojson',
	sha256: 'a'.repeat(64),
	duplicate: false,
	currentBoundary: null,
	problems: [{ feature: 4, message: 'has 3D coordinates' }],
	nodes,
	features: [
		{ index: 1, geometryType: 'Polygon', name: 'Upper farm', areaM2: 1e6, kind: 'farm_parcel', kindFrom: 'geometry', nodeId: 'f' },
		{ index: 2, geometryType: 'Point', name: 'Weir', areaM2: null, kind: 'gauge', kindFrom: 'property', nodeId: 'g' },
		{ index: 3, geometryType: 'LineString', name: 'River', areaM2: null, kind: 'river', kindFrom: 'geometry', note: 'the file says “road”, which isn’t a kind the map knows', nodeId: null },
		{ index: 4, geometryType: null, name: '', areaM2: null, kind: null, kindFrom: null, nodeId: null }
	]
};

describe('the import review', () => {
	it('offers each row only the kinds its geometry can be, and none for a refused row', () => {
		const rows = reviewRows(preview);
		expect(kindsFor(rows[0]!)).toEqual(['catchment_boundary', 'farm_parcel', 'dam', 'other']);
		expect(kindsFor(rows[1]!)).toEqual(['dam', 'gauge', 'other']);
		expect(kindsFor(rows[2]!)).toEqual(['river', 'other']);
		expect(kindsFor(rows[3]!)).toEqual([]);
		expect(rows[2]!.note).toMatch(/road/);
	});

	it('offers the nodes a kind can stand for, and drops a node that no longer fits a changed kind', () => {
		expect(nodesFor('farm_parcel', nodes).map((n) => n.id)).toEqual(['f', 'u']);
		expect(nodesFor('gauge', nodes).map((n) => n.id)).toEqual(['g']);
		expect(nodesFor('river', nodes)).toEqual([]);
		const [parcel, gauge] = reviewRows(preview);
		expect(withKind(parcel!, 'dam', nodes).nodeId).toBe('f');
		expect(withKind(parcel!, 'catchment_boundary', nodes).nodeId).toBeNull();
		expect(withKind(gauge!, 'dam', nodes)).toMatchObject({ kind: 'dam', nodeId: null });
	});

	it('sets every row that can take a kind, and counts the rest', () => {
		const { rows, skipped } = setEveryKind(reviewRows(preview), 'dam', nodes);
		expect(rows.map((r) => r.kind)).toEqual(['dam', 'dam', 'river', null]);
		expect(skipped).toBe(1);
		expect(setEveryKind(reviewRows(preview), 'other', nodes).rows.map((r) => r.kind)).toEqual(['other', 'other', 'other', null]);
	});

	it('refuses more than one boundary in a file', () => {
		const rows = reviewRows(preview);
		expect(reviewProblems(rows)).toEqual([]);
		const two = [rows[0]!, { ...rows[0]!, index: 5 }].map((r) => ({ ...r, kind: 'catchment_boundary' as const }));
		expect(reviewProblems(two)).toEqual([{ feature: null, message: 'A file holds at most one catchment boundary; features 1, 5 are each marked as one.' }]);
	});

	it('sends each row’s kind, name (one line, as the API takes it) and node, never a node for a kind that stands for none', () => {
		const rows = reviewRows(preview);
		rows[0] = { ...rows[0]!, name: '  Upper\tfarm  \u2028north ' };
		rows[2] = { ...rows[2]!, nodeId: 'g' };
		expect(reviewedFeatures(rows)).toEqual([
			{ index: 1, kind: 'farm_parcel', name: 'Upper farm north', nodeId: 'f' },
			{ index: 2, kind: 'gauge', name: 'Weir', nodeId: 'g' },
			{ index: 3, kind: 'river', name: 'River', nodeId: null }
		]);
	});

	it('counts the rows by kind in the review’s order', () => {
		const rows = reviewRows(preview);
		expect(kindCounts(rows)).toBe('1 farm parcel, 1 gauge, 1 river');
		expect(kindCounts(setEveryKind(rows, 'other', nodes).rows)).toBe('3 others');
		expect(kindCounts([rows[0]!, rows[0]!].map((r) => ({ ...r, kind: 'catchment_boundary' as const })))).toBe('2 catchment boundaries');
	});

	it('warns and needs the tick only while a row is the boundary and the project has one', () => {
		const rows = reviewRows(preview);
		const asBoundary = rows.map((r, i) => (i === 0 ? withKind(r, 'catchment_boundary', nodes) : r));
		const current = { name: 'Old catchment' };
		// Control: no boundary in the project, or none in the rows, replaces nothing and sends no flag.
		expect(replacesBoundary(asBoundary, null)).toBe(false);
		expect(replacesBoundary(rows, current)).toBe(false);
		expect(importBody(asBoundary, null, true)).not.toHaveProperty('replaceBoundary');
		expect(replacesBoundary(asBoundary, current)).toBe(true);
		expect(replaceBoundaryText(current)).toBe('Importing replaces the current catchment boundary “Old catchment”: it goes from the map.');
		expect(replaceBoundaryText({ name: ' ' })).toBe('Importing replaces the current catchment boundary: it goes from the map.');
		// Unticked: no flag (the server refuses it); ticked: replaceBoundary true.
		expect(importBody(asBoundary, current, false)).toEqual({ features: reviewedFeatures(asBoundary) });
		expect(importBody(asBoundary, current, true)).toEqual({ features: reviewedFeatures(asBoundary), replaceBoundary: true });
		// A tick left on after the row changed back sends no flag.
		expect(importBody(rows, current, true)).not.toHaveProperty('replaceBoundary');
	});
});
