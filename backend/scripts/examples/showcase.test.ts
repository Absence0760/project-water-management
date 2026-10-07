// The showcase example (showcase.ts) as `pnpm seed:examples` imports it: a
// valid project document, every engine field present, every self-check
// passing, and each feature it exists to show actually in the model and
// doing something in a run.
import { applyScenario, runModelChecked, upgradeLegacyModel, validateScenarioOps, type ModelOutput } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { modelProblems } from '../../src/model/validate.js';
import { ProjectFile } from '../../src/projects/document.js';
import { inputOf, type ExampleProject } from './catchments.js';
import { buildShowcase, OWN_SYSTEM_ID, SHOWCASE_NAME, showcaseNodeId, UNITS } from './showcase.js';
import { showcaseMap } from './showcaseMap.js';
import { showcaseScenarios } from './showcaseSeed.js';

let ex: ExampleProject;
let out: ModelOutput;
beforeAll(() => {
	ex = buildShowcase({ fit: false });
	out = runModelChecked(inputOf(ex));
});

describe('the showcase example', () => {
	it('parses as a project document with no model problems, every engine field present', () => {
		const parsed = ProjectFile.safeParse(ex);
		expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
		expect(modelProblems(ex.model)).toEqual([]);
		expect(upgradeLegacyModel(ex.model)).toEqual(ex.model);
		expect(ex.name).toBe(SHOWCASE_NAME);
	});

	it('runs with every self-check passing', () => {
		expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
	});

	it('has each model feature it exists to show', () => {
		const m = ex.model;
		const kinds = new Set(m.nodes.map((n) => n.kind));
		expect([...kinds].sort()).toEqual(['farm', 'gauge', 'user']);
		expect(m.nodes.filter((n) => n.kind === 'farm' && n.damCapacityM3 > 0)).toHaveLength(3);
		expect(m.nodes.filter((n) => n.kind === 'gauge' && n.ewrSite).map((n) => n.name).sort()).toEqual([UNITS.gauge, UNITS.outlet].sort());
		expect(m.boreholes?.map((b) => b.mode).sort()).toEqual(['emergency', 'supplemental']);
		expect(m.landCover).toHaveLength(2);
		// Transfers: one by months, one with a rate per month.
		expect(m.transfers.map((t) => t.monthlyRateM3s === null)).toEqual([true, false]);
		// Demands in m³/day, in l/s and per unit.
		const d = m.demandObjects!;
		expect(d.some((o) => o.sizing === 'monthly' && !o.monthlyUnit)).toBe(true);
		expect(d.some((o) => o.monthlyUnit === 'ls')).toBe(true);
		expect(d.filter((o) => o.sizing === 'perUnit')).toHaveLength(2);
		// A river abstraction for the crops, in a crop supply table with a share from the upper unit's dam (engine 1.73.0).
		expect(m.nodes.find((n) => n.name === UNITS.lower)).toMatchObject({ cropWaterSource: 'river', cropShareDam: 0.4, cropShareRiver: 0.4, cropShareRemote: 0.2, cropRemoteNodeId: showcaseNodeId(UNITS.upper) });
		// The project's own irrigation systems: an edited efficiency, a row of its own, crop defaults and one per-unit override.
		expect(m.irrigationSystems!.find((s) => s.id === 'micro')!.efficiency).toBe(0.78);
		expect(m.irrigationSystems!.find((s) => s.id === OWN_SYSTEM_ID)!.preset).toBeNull();
		expect(m.crops.every((c) => c.irrigationSystemId)).toBe(true);
		expect(m.cropAreas.filter((a) => a.irrigationSystemId)).toEqual([expect.objectContaining({ nodeId: showcaseNodeId(UNITS.middle), irrigationSystemId: OWN_SYSTEM_ID })]);
	});

	it('the features do something in a run', () => {
		const sum = (key: string, nodeId: string | null) => (out.series.find((s) => s.key === key && s.nodeId === nodeId)?.values ?? []).reduce((a: number, v) => a + (v ?? 0), 0);
		// Every transfer moves water, the boreholes pump and the town takes from the river.
		for (const t of ex.model.transfers) expect(sum(`transfer_rule@${t.id}`, showcaseNodeId(UNITS.upper)), t.id).toBeGreaterThan(0);
		expect(sum('groundwater_used', showcaseNodeId(UNITS.upper)) + sum('groundwater_used', showcaseNodeId(UNITS.lower))).toBeGreaterThan(0);
		expect(sum('supplied', showcaseNodeId(UNITS.town))).toBeGreaterThan(0);
		expect(sum('river_take@crops', showcaseNodeId(UNITS.lower))).toBeGreaterThan(0);
		// The upper dam gives the lower unit's crops their share (engine 1.73.0).
		expect(sum('remote_dam_in', showcaseNodeId(UNITS.lower))).toBeGreaterThan(0);
		expect(sum('remote_dam_out', showcaseNodeId(UNITS.upper))).toBeCloseTo(sum('remote_dam_in', showcaseNodeId(UNITS.lower)), 3);
		expect(sum('landcover_reduction', null)).toBeGreaterThan(0);
		// The losing reach below the gauge (engine 1.75.0) loses water into the bed.
		expect(sum('reach_loss', showcaseNodeId(UNITS.gauge))).toBeGreaterThan(0);
	});

	it('its map links a parcel and a dam to every unit, and every gauge to its node', () => {
		const f = showcaseMap(ex.model);
		expect(f.filter((x) => x.kind === 'catchment_boundary')).toHaveLength(1);
		for (const name of [UNITS.upper, UNITS.middle, UNITS.lower]) {
			expect(f.some((x) => x.kind === 'farm_parcel' && x.node === name), name).toBe(true);
			expect(f.some((x) => x.kind === 'dam' && x.node === name), name).toBe(true);
		}
		for (const name of [UNITS.outlet, UNITS.gauge]) expect(f.some((x) => x.kind === 'gauge' && x.node === name), name).toBe(true);
	});

	it('each scenario is valid, applies cleanly to the model and changes its run', () => {
		const scenarios = showcaseScenarios(ex.model);
		expect(new Set(scenarios.map((x) => x.name)).size).toBe(scenarios.length);
		const outflow = (o: ModelOutput) => o.series.find((x) => x.key === 'simulated_outflow' && x.nodeId === null)!.values.reduce((a: number, v) => a + (v ?? 0), 0);
		const base = outflow(out);
		for (const sc of scenarios) {
			expect(validateScenarioOps(sc.ops).errors, sc.name).toEqual([]);
			const applied = applyScenario(inputOf(ex), sc.ops);
			expect(applied.problems, sc.name).toEqual([]);
			expect(outflow(runModelChecked(applied.input)), sc.name).not.toBeCloseTo(base, 0);
		}
	});
});
