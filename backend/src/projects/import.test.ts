import { canonicalUnit, defaultCalibrationRules } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { MAX_JSON_EXPORT_BYTES } from '../export/csv.js';
import { ProjectFile } from './document.js';
import { freshIds, IMPORT_MAX_BYTES, parseProjectFile, projectFileProblems } from './import.js';

const LAMBDA_REQUEST_PAYLOAD = 6 * 1024 * 1024;

describe('import body cap', () => {
	it('stays under Lambda’s 6 MB request payload with room for headers and JSON escaping', () => {
		expect(IMPORT_MAX_BYTES).toBeLessThanOrEqual(LAMBDA_REQUEST_PAYLOAD - 512 * 1024);
	});

	it('takes every file the export writes (raise the export cap and imports need a gzip body first)', () => {
		expect(IMPORT_MAX_BYTES).toBeGreaterThanOrEqual(MAX_JSON_EXPORT_BYTES);
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

	it('moves the unit an off-take’s seepage rejoins below with the nodes (engine 1.42.0), and leaves none as none', () => {
		const [a, b, t, t2] = [u(), u(), u(), u()];
		const { model, ids } = freshIds({
			nodes: [
				{ id: a, downstreamNodeId: null },
				{ id: b, downstreamNodeId: a }
			] as never,
			crops: [],
			cropAreas: [],
			transfers: [
				{ id: t, fromNodeId: b, toNodeId: a, lossReturnPct: 0.5, lossReturnNodeId: a },
				{ id: t2, fromNodeId: b, toNodeId: a, lossReturnPct: 0, lossReturnNodeId: null }
			] as never
		});
		expect(model.transfers[0]).toMatchObject({ lossReturnNodeId: ids.get(a) });
		expect(model.transfers[1]!.lossReturnNodeId).toBeNull();
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

describe('parseProjectFile: an automated fit must match the file’s own calibration rules (issue #153)', () => {
	const period = { start: '2020-01-01', end: '2020-01-30', waterYears: [2019], scores: { days: 30, kgePrime: 0.7 } };
	const params = { x1: 420, x2: 0, x3: 70, x4: 2.1 };
	const rules = { ...defaultCalibrationRules(), revision: 2 };
	const record = {
		fittedAt: '2026-09-29T10:00:00.000Z',
		engineVersion: '1.25.0',
		model: 'gr4j',
		objective: 'kgePrime',
		bounds: 'typical',
		seed: 1,
		budget: 1500,
		evaluations: 4500,
		cancelled: false,
		free: ['x1', 'x3', 'x4'],
		params,
		startParams: { x1: 350, x2: 0, x3: 90, x4: 1.7 },
		flowKind: 'flow_observed_m3s',
		simulatedKey: 'simulated_outflow',
		calibrationStart: null,
		calibrationEnd: null,
		exclusions: [],
		validate: true,
		validationRecord: null,
		fit: period,
		before: period,
		splitSample: null,
		differential: null,
		independentRecord: null,
		notes: [],
		editedParams: [],
		auto: {
			rules,
			ruleExclusions: [],
			chosen: 0,
			cases: [{ label: 'typical', pan: 'project', bounds: 'typical', objective: 'kgePrime', score: 0.7, eligible: true, reasons: [], params }]
		}
	};
	const doc = (calibrationRules: unknown) => ({ name: 'P', model: { nodes: [], crops: [], cropAreas: [], transfers: [] }, series: [], settings: { calibrationRules, fitRecord: record } });

	it('takes a file whose fit ran under its own rules', () => {
		expect(() => parseProjectFile(doc(rules))).not.toThrow();
	});

	it('refuses a file whose rules moved on from the fit (another revision, content or sign-off)', () => {
		for (const other of [
			{ ...rules, revision: 3 },
			{ ...rules, selection: { test: 'split', score: 'kgePrime' } },
			{ ...rules, signedOff: { by: 'Someone', on: '2026-09-29' } }
		]) {
			expect(() => parseProjectFile(doc(other)), JSON.stringify(other)).toThrow('invalid project file');
		}
	});
});

describe('a project document’s names are made one line (issue #385)', () => {
	it('cleans a name over several lines, as the workbook importers do, where PUT /model refuses it', () => {
		const out = u();
		const farm = u();
		const node = (id: string, name: string, downstreamNodeId: string | null) => ({
			id,
			name,
			kind: 'farm',
			downstreamNodeId,
			sortOrder: 0,
			areaKm2: 1,
			areaHiKm2: 0,
			areaLoKm2: 0,
			flowShareManual: null,
			pctUpstreamToDam: 1,
			pctRunoffToDam: 0,
			damCapacityM3: 0,
			damInitialPct: 0,
			damMinPct: 0,
			divertCapacityM3Day: 0,
			irrigationEfficiency: 1,
			lossReturnFraction: 0,
			damAreaFullM2: null,
			damAreaExponent: 0.7,
			damSeepagePerDay: 0
		});
		const file = parseProjectFile({
			name: 'P',
			model: { nodes: [node(out, 'Outlet', null), node(farm, 'Golf\r\nFarm', out)], crops: [{ id: u(), name: 'Vines\u009fD', cropFactor: new Array(12).fill(0.5) }], cropAreas: [], transfers: [] },
			series: []
		});
		expect(file.model.nodes.map((n) => n.name)).toEqual(['Outlet', 'Golf Farm']);
		expect(file.model.crops.map((c) => c.name)).toEqual(['Vines D']);
	});
});
