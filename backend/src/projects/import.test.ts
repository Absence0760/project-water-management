import { canonicalUnit } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { MAX_EXPORT_BYTES } from '../export/csv.js';
import { ProjectFile } from './document.js';
import { freshIds, IMPORT_MAX_BYTES, projectFileProblems } from './import.js';

const LAMBDA_REQUEST_PAYLOAD = 6 * 1024 * 1024;

describe('import body cap', () => {
	it('stays under Lambda’s 6 MB request payload with room for headers and JSON escaping', () => {
		expect(IMPORT_MAX_BYTES).toBeLessThanOrEqual(LAMBDA_REQUEST_PAYLOAD - 512 * 1024);
	});

	it('takes every file the export writes (raise the export cap and imports need a gzip body first)', () => {
		expect(IMPORT_MAX_BYTES).toBeGreaterThanOrEqual(MAX_EXPORT_BYTES);
	});
});

const u = () => crypto.randomUUID();

describe('freshIds', () => {
	it('gives every row a new id and keeps every reference between rows, land cover included', () => {
		const [a, b, c, t, lc] = [u(), u(), u(), u(), u()];
		const { model, ids } = freshIds({
			nodes: [
				{ id: a, downstreamNodeId: null },
				{ id: b, downstreamNodeId: a }
			] as never,
			crops: [{ id: c }] as never,
			cropAreas: [{ nodeId: b, cropId: c, areaM2: 1 }],
			transfers: [{ id: t, fromNodeId: b, toNodeId: a }] as never,
			landCover: [{ id: lc, nodeId: b }] as never
		});
		const [na, nb] = [ids.get(a)!, ids.get(b)!];
		expect(new Set([na, nb, ids.get(c), ids.get(t), ids.get(lc)]).size).toBe(5);
		for (const old of [a, b, c, t, lc]) expect(ids.get(old)).not.toBe(old);
		expect(model.nodes.map((n) => [n.id, n.downstreamNodeId])).toEqual([
			[na, null],
			[nb, na]
		]);
		expect(model.cropAreas[0]).toMatchObject({ nodeId: nb, cropId: ids.get(c) });
		expect(model.transfers[0]).toMatchObject({ id: ids.get(t), fromNodeId: nb, toNodeId: na });
		expect(model.landCover![0]).toMatchObject({ id: ids.get(lc), nodeId: nb });
	});

	it('keeps the ids’ order, which the engine sums and breaks ties in', () => {
		// Python importer ids and a UI-made id, deliberately not in list order.
		const olds = ['c3f1', '0aa2', 'ffff-last', '7b00', '00-first', 'b2', 'x-crop', 'a-transfer'];
		const nodes = olds.slice(0, 6).map((id, i) => ({ id, downstreamNodeId: i === 0 ? null : olds[0]! }));
		for (let round = 0; round < 20; round++) {
			const { ids } = freshIds({
				nodes: nodes as never,
				crops: [{ id: 'x-crop' }] as never,
				cropAreas: [],
				transfers: [{ id: 'a-transfer', fromNodeId: 'b2', toNodeId: 'c3f1' }] as never
			});
			const byOld = [...olds].sort();
			const byNew = [...olds].sort((a, b) => (ids.get(a)! < ids.get(b)! ? -1 : 1));
			expect(byNew).toEqual(byOld);
			for (const o of olds) expect(ids.get(o)).toMatch(/^[0-9a-f-]{36}$/);
		}
	});
});

describe('projectFileProblems', () => {
	const file = (series: { kind: string; name?: string }[]) =>
		ProjectFile.parse({
			name: 'P',
			model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
			series: series.map((s) => ({ unit: canonicalUnit(s.kind), startDate: '2020-01-01', values: [1], ...s }))
		});

	it('refuses two series of one kind and name (the database keeps one), not two names of one kind', () => {
		expect(projectFileProblems(file([{ kind: 'rain_catchment_mm', name: 'A' }, { kind: 'rain_catchment_mm', name: 'B' }]))).toEqual([]);
		expect(projectFileProblems(file([{ kind: 'rain_catchment_mm' }, { kind: 'rain_catchment_mm', name: '' }]))).toEqual([
			'duplicate series rain_catchment_mm'
		]);
		expect(projectFileProblems(file([{ kind: 'flow_observed_m3s', name: 'G' }, { kind: 'flow_observed_m3s', name: 'G' }]))).toEqual([
			'duplicate series flow_observed_m3s "G"'
		]);
	});
});
