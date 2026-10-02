// The river-abstractions example (catchments.ts ORANJE, #342 items 4–5) and
// its map (oranjeMap.ts) as `pnpm seed:examples` loads them: a valid project
// document on the current schema, a clean run, and the features it is there
// to show (a demand on the river beside a dam, a pool, weekdays only, ranks,
// water piped out); the map passes the import's checks and matches the model.
import { runModelChecked, upgradeLegacyModel, type ModelOutput } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkGeometry, pointInGeometry, type Geometry, type Position } from '../../src/geo/geojson.js';
import { modelProblems } from '../../src/model/validate.js';
import { ProjectFile } from '../../src/projects/document.js';
import { buildRiverExample, inputOf, type ExampleProject } from './catchments.js';
import { oranjeMap } from './oranjeMap.js';

let ex: ExampleProject;
let out: ModelOutput;
beforeAll(() => {
	ex = buildRiverExample({ fit: false });
	out = runModelChecked(inputOf(ex));
}, 60_000);

const farm = (name: string) => out.summary.farms.find((f) => f.name === name)!;
const object = (unit: string, name: string) => farm(unit).demandObjects!.find((o) => o.name === name)!;
const take = (unit: string, name: string) => farm(unit).riverTakes!.find((r) => r.name === name)!;

describe('the Oranje example', () => {
	it('parses as a project document with nothing for the legacy upgrade to fill, deterministically', () => {
		expect(ProjectFile.safeParse(ex).error?.issues ?? []).toEqual([]);
		expect(modelProblems(ex.model)).toEqual([]);
		expect(upgradeLegacyModel(ex.model)).toEqual(ex.model);
		expect(buildRiverExample({ fit: false }).model).toEqual(ex.model);
	});

	it('runs with every self-check passing', () => {
		expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
	});

	it('runs a demand from the river beside a dam, on weekdays only, with a pool at its pump', () => {
		const packhouse = ex.model.demandObjects!.find((o) => o.name === 'Packhouse')!;
		expect(packhouse).toMatchObject({ waterSource: 'river', riverPumpM3Day: 400, riverPoolM3: 1500 });
		expect(packhouse.schedule).toEqual([expect.objectContaining({ span: 'always', weekdays: [6, 7], factor: 0 })]);
		expect(ex.model.nodes.find((n) => n.name === 'Rivierplaas')!.damCapacityM3).toBeGreaterThan(0);
		// Two days in seven off: the weekends.
		expect(object('Rivierplaas', 'Packhouse').daysOff! / out.days).toBeCloseTo(2 / 7, 2);
		expect(take('Rivierplaas', 'Packhouse').avgTakeM3Day).toBeGreaterThan(0);
		expect(take('Rivierplaas', 'Packhouse').avgPoolStorageM3).toBeGreaterThan(0);
	});

	it('irrigates crops from their own river pump, which limits them on some days, and supplies a town from the river', () => {
		const unit = ex.model.nodes.find((n) => n.name === 'Wingerdhoek')!;
		expect(unit).toMatchObject({ cropWaterSource: 'river', cropRiverPumpM3Day: 6000, cropRiverPoolM3: 5000 });
		expect(take('Wingerdhoek', 'Wingerdhoek: crops').daysPumpLimited).toBeGreaterThan(0);
		expect(take('Wingerdhoek', 'Town supply').avgTakeM3Day).toBeGreaterThan(0);
	});

	it('ranks the demands before the crops, and pipes water out of the catchment last', () => {
		expect(object('Rivierplaas', 'Rivierplaas village')).toMatchObject({ priority: 'first', daysShort: 0 });
		expect(object('Rivierplaas', 'Stock water')).toMatchObject({ priority: 'first', daysShort: 0 });
		expect(ex.model.demandObjects!.filter((o) => o.nodeId === ex.model.nodes.find((n) => n.name === 'Rivierplaas')!.id && o.priority === 'first').map((o) => [o.name, o.rank])).toEqual([
			['Rivierplaas village', 1],
			['Stock water', 2]
		]);
		expect(object('Wingerdhoek', 'Pipeline out of the catchment')).toMatchObject({ priority: 'last', destination: 'external', avgReturnedM3Day: 0 });
	});
});

const vertices = (g: Geometry): Position[] =>
	g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates.flat() : [];

describe('the Oranje example map', () => {
	const features = () => oranjeMap(ex.model);
	const boundary = () => features().find((f) => f.kind === 'catchment_boundary')!.geometry;

	it('passes the import’s geometry checks, one boundary, a parcel per unit and a point per pump', () => {
		for (const f of features()) expect(checkGeometry(f.geometry), f.name).not.toHaveProperty('problem');
		expect(features().filter((f) => f.kind === 'catchment_boundary')).toHaveLength(1);
		expect(features().filter((f) => f.kind === 'farm_parcel').map((f) => f.node).sort()).toEqual(ex.model.nodes.filter((n) => n.kind === 'farm').map((n) => n.name).sort());
		expect(features().filter((f) => f.kind === 'other').map((f) => f.name)).toEqual(['Packhouse pump', 'Wingerdhoek crops pump', 'Town supply pump']);
	});

	it('draws each parcel to its modelled area and each dam to its full-supply area (within 1 %), all inside the boundary', () => {
		for (const n of ex.model.nodes.filter((n) => n.kind === 'farm')) {
			const parcel = checkGeometry(features().find((f) => f.kind === 'farm_parcel' && f.node === n.name)!.geometry) as { areaM2: number };
			expect(Math.abs(parcel.areaM2 / 1e6 / n.areaKm2 - 1), n.name).toBeLessThan(0.01);
			const dam = checkGeometry(features().find((f) => f.kind === 'dam' && f.node === n.name)!.geometry) as { areaM2: number };
			expect(Math.abs(dam.areaM2 / n.damAreaFullM2! - 1), n.name).toBeLessThan(0.01);
		}
		for (const f of features().filter((f) => f.kind !== 'catchment_boundary')) {
			for (const p of vertices(f.geometry)) expect(pointInGeometry(p, boundary()), `${f.name} ${p}`).toBe(true);
		}
	});

	it('lies on the lower Orange near Upington, inside the River network layer’s 2° bbox', () => {
		const v = vertices(boundary());
		const [w, e] = [Math.min(...v.map((p) => p[0])), Math.max(...v.map((p) => p[0]))];
		const [s, n] = [Math.min(...v.map((p) => p[1])), Math.max(...v.map((p) => p[1]))];
		expect(w).toBeLessThan(21.26);
		expect(e).toBeGreaterThan(21.26);
		expect(s).toBeLessThan(-28.45);
		expect(n).toBeGreaterThan(-28.45);
		expect(e - w).toBeLessThan(2);
		expect(n - s).toBeLessThan(2);
	});
});
