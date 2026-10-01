// The unsaved-edits preview's input (./overlay.ts, issue #284): the last
// run's input with only the saved → unsaved change laid over it, path by
// path, so whatever the editor didn't touch stays as the run had it.
import type { ModelInput, NetworkNode, ProjectModel } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { hasUnsaved, overlayUnsaved, overlayValue, previewBaseRun } from './overlay';

const node = (id: string, extra: Partial<NetworkNode> = {}) => ({ id, name: id.toUpperCase(), kind: 'farm', downstreamNodeId: 'out', areaKm2: 1, damCapacityM3: 0, ...extra }) as unknown as NetworkNode;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function model(nodes: NetworkNode[], extra: Partial<ProjectModel> = {}): ProjectModel {
	return { nodes, crops: [{ id: 'c1', name: 'Citrus', cropFactor: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }], cropAreas: [{ nodeId: 'a', cropId: 'c1', areaM2: 1000 }], transfers: [], landCover: [], ...extra };
}

function runInput(): ModelInput {
	return {
		settings: { gr4j: { x1: 100, x2: 0, x3: 50, x4: 2 }, februaryDays: 28.25, lakeEvapFactor: 0.8 } as unknown as ModelInput['settings'],
		model: { ...model([node('out', { kind: 'gauge', downstreamNodeId: null } as Partial<NetworkNode>), node('a'), node('b')]), allocations: [] },
		series: { rain_mm: { startDate: '2020-01-01', values: [1, 2, 3] } } as unknown as ModelInput['series']
	};
}

describe('overlayValue', () => {
	it('takes only the paths that changed, leaving the rest as the base has them', () => {
		const base = { gr4j: { x1: 100, x3: 50 }, k: 1 };
		const saved = { gr4j: { x1: 200, x3: 50 }, k: 1 };
		const draft = { gr4j: { x1: 200, x3: 60 }, k: 1 };
		// x1 moved between the run and the save: not an unsaved edit, so the run's 100 stays.
		expect(overlayValue(base, saved, draft)).toEqual({ gr4j: { x1: 100, x3: 60 }, k: 1 });
	});

	it('drops a key the draft dropped, and takes a list or a number whole', () => {
		expect(overlayValue({ a: 1, b: [1, 2], c: 3 }, { a: 1, b: [1, 2], c: 3 }, { a: 1, b: [9] })).toEqual({ a: 1, b: [9] });
	});

	it('is the base when nothing changed, even where the base differs from the saved value', () => {
		expect(overlayValue({ a: 5 }, { a: 1 }, { a: 1 })).toEqual({ a: 5 });
	});

	it("takes the draft's object whole where the base has none", () => {
		expect(overlayValue({ a: null }, { a: { x: 1 } }, { a: { x: 2, y: 3 } })).toEqual({ a: { x: 2, y: 3 } });
	});
});

describe('overlayUnsaved: settings', () => {
	it('lays the unsaved settings over the run, and only those', () => {
		const base = runInput();
		const saved = { gr4j: { x1: 120, x2: 0, x3: 50, x4: 2 }, februaryDays: 28.25, lakeEvapFactor: 0.8 };
		const draft = { ...clone(saved), lakeEvapFactor: 0.7 };
		const r = overlayUnsaved(base, { settings: { saved, draft } });
		expect(r.input.settings).toEqual({ ...base.settings, lakeEvapFactor: 0.7 });
		// x1 = 120 was saved after the run: the preview keeps the run's 100.
		expect((r.input.settings.gr4j as { x1: number }).x1).toBe(100);
		expect(r.settings).toEqual(['lakeEvapFactor']);
		expect(r.problems).toEqual([]);
	});

	it("ignores the settings a run doesn't read (autoRun, outcomes, outlook)", () => {
		const base = runInput();
		const saved = { lakeEvapFactor: 0.8, autoRun: { enabled: false }, outlook: { a: 1 } };
		const draft = { lakeEvapFactor: 0.8, autoRun: { enabled: true }, outlook: { a: 2 } };
		const r = overlayUnsaved(base, { settings: { saved, draft } });
		expect(r.input.settings).toEqual(base.settings);
		expect(r.input.settings).not.toHaveProperty('autoRun');
		expect(r.settings).toEqual([]);
		expect(hasUnsaved({ settings: { saved, draft } })).toBe(false);
	});

	it('never changes the run input it was given, and keeps its series', () => {
		const base = runInput();
		const before = clone(base);
		const r = overlayUnsaved(base, { settings: { saved: { lakeEvapFactor: 0.8 }, draft: { lakeEvapFactor: 0.5 } }, model: { saved: model([node('a')]), draft: model([node('a', { areaKm2: 9 })]) } });
		expect(base).toEqual(before);
		expect(r.input.series).toEqual(base.series);
		expect(r.input.model.allocations).toEqual([]);
	});
});

describe('overlayUnsaved: the model', () => {
	it("changes only the edited fields of a node, leaving its other fields as the run had them", () => {
		const base = runInput();
		base.model.nodes[1]!.damCapacityM3 = 500; // the run's value; saved since as 700
		const saved = model([node('a', { damCapacityM3: 700 })]);
		const draft = model([node('a', { damCapacityM3: 700, areaKm2: 4 })]);
		const r = overlayUnsaved(base, { model: { saved, draft } });
		const a = r.input.model.nodes.find((n) => n.id === 'a')!;
		expect(a.areaKm2).toBe(4);
		expect(a.damCapacityM3).toBe(500);
		expect(r.model.nodes).toEqual({ added: 0, removed: 0, changed: 1 });
	});

	it('adds an added node and removes a removed one', () => {
		const base = runInput();
		const saved = model([node('a'), node('b')]);
		const draft = model([node('a'), node('c', { areaKm2: 3 })]);
		const r = overlayUnsaved(base, { model: { saved, draft } });
		expect(r.input.model.nodes.map((n) => n.id)).toEqual(['out', 'a', 'c']);
		expect(r.input.model.nodes[2]!.areaKm2).toBe(3);
		expect(r.model.nodes).toEqual({ added: 1, removed: 1, changed: 0 });
	});

	it("names an edited node the run doesn't have, and leaves it out", () => {
		const base = runInput();
		const saved = model([node('new')]);
		const draft = model([node('new', { areaKm2: 2 })]);
		const r = overlayUnsaved(base, { model: { saved, draft } });
		expect(r.input.model.nodes.map((n) => n.id)).toEqual(['out', 'a', 'b']);
		expect(r.problems).toEqual(['node "NEW" isn\'t in the last run (it was added after it), so its unsaved changes aren\'t in the preview']);
	});

	it('matches planted areas by unit and crop', () => {
		const base = runInput();
		const saved = model([node('a')]);
		const draft = model([node('a')], { cropAreas: [{ nodeId: 'a', cropId: 'c1', areaM2: 5000 }, { nodeId: 'b', cropId: 'c1', areaM2: 10 }] });
		const r = overlayUnsaved(base, { model: { saved, draft } });
		expect(r.input.model.cropAreas).toEqual([
			{ nodeId: 'a', cropId: 'c1', areaM2: 5000 },
			{ nodeId: 'b', cropId: 'c1', areaM2: 10 }
		]);
		expect(r.model.cropAreas).toEqual({ added: 1, removed: 0, changed: 1 });
		// The lists the edits left alone are absent from the summary.
		expect(r.model.nodes).toBeUndefined();
	});

	it("leaves an optional list the run never had absent when the edits leave it empty", () => {
		const base = runInput();
		const saved = model([node('a')], { boreholes: [{ id: 'bh', nodeId: 'a' } as never] });
		const draft = model([node('a')]);
		const r = overlayUnsaved(base, { model: { saved, draft } });
		expect(r.input.model).not.toHaveProperty('boreholes');
	});

	it('is the run input itself when nothing is unsaved', () => {
		const base = runInput();
		const m = model([node('a')]);
		expect(overlayUnsaved(base, { model: { saved: m, draft: clone(m) } }).input).toEqual(base);
		expect(hasUnsaved({ model: { saved: m, draft: clone(m) } })).toBe(false);
		expect(hasUnsaved({ model: { saved: m, draft: model([node('a', { areaKm2: 2 })]) } })).toBe(true);
	});
});

describe('previewBaseRun', () => {
	const run = (id: string, createdAt: string, extra: object = {}) => ({ id, createdAt, ...extra });

	it("is the newest run of the catchment's own model", () => {
		const runs = [run('s', '2026-09-30T10:00:00Z', { scenarioId: 'x' }), run('l', '2026-09-29T10:00:00Z', { legacy: true }), run('m', '2026-09-28T10:00:00Z'), run('o', '2026-09-01T10:00:00Z')];
		expect(previewBaseRun(runs)?.id).toBe('m');
	});

	it('is null without one', () => {
		expect(previewBaseRun(null)).toBeNull();
		expect(previewBaseRun([run('s', '2026-09-30T10:00:00Z', { scenarioId: 'x' })])).toBeNull();
	});
});
