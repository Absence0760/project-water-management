import { applyScenario, blankEwrRuleTable, classifyOp, classifyScenario, type EwrRuleTable, type ModelInput, type Monthly, type ScenarioOp } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { newNode } from '$lib/model/editor.svelte';
import { OUTLET_SITE, buildOp, checkOp, describeOp, draftSpec, emptyDraft, nameIds, namesOf, opItems, snapshotInput, startTable, statusByOp, stepInputs, type OpDraft } from './ops';

// Synthetic ids (UUID-shaped, as the backend requires) and invented names.
const G = '00000000-0000-4000-8000-000000000001';
const UP = '00000000-0000-4000-8000-000000000002';
const LO = '00000000-0000-4000-8000-000000000003';
const CROP = '00000000-0000-4000-8000-0000000000c1';
const T = '00000000-0000-4000-8000-0000000000a1';
const P = '00000000-0000-4000-8000-0000000000b1';

function base(): ModelInput {
	const gauge = { ...newNode(0, null), id: G, name: 'Outflow gauge' };
	const upper = { ...newNode(1, G), id: UP, name: 'Upper farm', areaKm2: 12, damCapacityM3: 150_000 };
	const lower = { ...newNode(2, G), id: LO, name: 'Lower farm', areaKm2: 8, damCapacityM3: 90_000 };
	return snapshotInput(
		{
			nodes: [gauge, upper, lower],
			crops: [{ id: CROP, name: 'Orchard', cropFactor: new Array(12).fill(0.6) }],
			cropAreas: [{ nodeId: UP, cropId: CROP, areaM2: 200_000 }],
			transfers: [{ id: T, fromNodeId: UP, toNodeId: LO, months: [11, 12], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0.2, enabled: true, priority: 0 }],
			landCover: [{ id: P, nodeId: LO, coverClass: 'pine', areaKm2: 1.5, densityPct: 0.5, factors: null }]
		},
		{ flowShareMethod: 'area', simulationStart: null, apanMm: new Array(12).fill(100) }
	);
}

const raise: ScenarioOp = { op: 'node.set', nodeId: UP, field: 'damCapacityM3', value: 180_000 };

describe('snapshotInput and stepInputs', () => {
	it('fills in a missing model part and upgrades a legacy model', () => {
		const i = snapshotInput({ nodes: [] }, null);
		expect(i.model).toEqual({ nodes: [], crops: [], cropAreas: [], transfers: [], landCover: [] });
		expect(i.settings).toEqual({});
		expect(i.series).toEqual({});
	});

	it('gives each op the input the earlier ops left, never touching the base', () => {
		const b = base();
		const frozen = JSON.stringify(b);
		const add: ScenarioOp = { op: 'node.add', node: { ...newNode(3, UP), id: '00000000-0000-4000-8000-0000000000d1', name: 'New dam' } };
		const rename: ScenarioOp = { op: 'node.set', nodeId: '00000000-0000-4000-8000-0000000000d1', field: 'name', value: 'Big dam' };
		const { before, after } = stepInputs(b, [raise, add, rename]);
		expect(before).toHaveLength(3);
		expect(before[0]).toEqual(b);
		expect(before[1]!.model.nodes.find((n) => n.id === UP)!.damCapacityM3).toBe(180_000);
		expect(before[2]!.model.nodes.map((n) => n.name)).toContain('New dam');
		expect(after.model.nodes.map((n) => n.name)).toContain('Big dam');
		expect(JSON.stringify(b)).toBe(frozen);
		// The same result as applying the whole list at once.
		expect(after).toEqual(applyScenario(b, [raise, add, rename]).input);
	});

	it('an op in an edit group meets the group\'s earlier ops, and `after` keeps an incomplete last group for the next op', () => {
		const trig = applyScenario(base(), [{ op: 'node.set', nodeId: UP, field: 'supplyRule', value: 'trigger' }]).input;
		const rule: ScenarioOp = { op: 'node.set', nodeId: UP, field: 'supplyRule', value: 'runOfRiver' };
		// The rule alone doesn't apply (run of river has no dam), but the form's next op builds on it.
		const one = stepInputs(trig, [rule]);
		expect(one.after.model.nodes.find((n) => n.id === UP)!.supplyRule).toBe('runOfRiver');
		const two = stepInputs(trig, [rule, { op: 'node.set', nodeId: UP, field: 'damCapacityM3', value: 0 }]);
		expect(two.before[1]!.model.nodes.find((n) => n.id === UP)!.supplyRule).toBe('runOfRiver');
		expect(two.after.model.nodes.find((n) => n.id === UP)).toMatchObject({ supplyRule: 'runOfRiver', damCapacityM3: 0 });
	});
});

describe('describeOp', () => {
	const b = base();
	const d = (op: ScenarioOp, input: ModelInput | null = b) => describeOp(op, input, namesOf([b.model], [op]));

	it('says what each op changes, with the value it replaces', () => {
		expect(d(raise)).toBe('Upper farm: Dam capacity 150\u202f000 m³ → 180\u202f000 m³');
		expect(d({ op: 'node.set', nodeId: LO, field: 'irrigationEfficiency', value: 0.9 })).toBe('Lower farm: Irrigation efficiency 80 % → 90 %');
		expect(d({ op: 'node.remove', nodeId: LO })).toBe('Remove “Lower farm”');
		expect(d({ op: 'cropArea.set', nodeId: UP, cropId: CROP, areaM2: 250_000 })).toBe('Upper farm: Orchard 20 ha → 25 ha');
		expect(d({ op: 'cropArea.set', nodeId: UP, cropId: CROP, areaM2: 0 })).toBe('Upper farm: Orchard 20 ha → none');
		expect(d({ op: 'crop.add', crop: { id: 'c2', name: 'Vines', cropFactor: new Array(12).fill(0.3) } })).toBe('Add the crop “Vines”');
		expect(d({ op: 'transfer.set', transferId: T, field: 'maxRateM3s', value: 0.02 })).toBe('The transfer Upper farm → Lower farm: Maximum rate 0.01 m³/s → 0.02 m³/s');
		expect(d({ op: 'transfer.set', transferId: T, field: 'toNodeId', value: G })).toBe('The transfer Upper farm → Lower farm: Destination Lower farm → Outflow gauge');
		expect(d({ op: 'transfer.remove', transferId: T })).toBe('Remove the transfer Upper farm → Lower farm');
		expect(d({ op: 'landCover.remove', patchId: P })).toBe('Lower farm: remove Pine plantation (mature) (1.5 km²)');
		expect(d({ op: 'settings.set', path: 'flowShareMethod', value: 'manual' })).toBe('Flow-share method: By area → Manual');
		expect(d({ op: 'settings.set', path: 'simulationStart', value: '2022-01-01' })).toBe('Simulation start: first day with rain → 2022-01-01');
		// An unset PE input is pan × A-pan (a project saved before engine 0.31.0).
		expect(d({ op: 'settings.set', path: 'pe', value: { kind: 'monthly', mm: new Array<number>(12).fill(100) as unknown as Monthly, source: 'Station ET₀' } })).toBe(
			'GR4J potential evaporation: pan coefficient × A-pan → monthly, entered directly: 1\u202f200 mm a year (Station ET₀)'
		);
		expect(d({ op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.9 })).toBe('Rainfall — catchment: × 0.9 (−10 %)');
		expect(d({ op: 'series.scale', kind: 'rain_chirps_mm', factor: 1.25, from: '2022-01-01' })).toBe('Rainfall — CHIRPS: × 1.25 (+25 %), 2022-01-01 to end');
		expect(d({ op: 'demand.scale', factor: 0.85 })).toBe("Irrigation demand of every unit: 85 % of what they'd take (× 0.85)");
		expect(d({ op: 'demand.scale', factor: 0.7, nodeIds: [UP, LO], months: [12, 1, 2] })).toBe("Irrigation demand of Upper farm, Lower farm: 70 % of what they'd take (× 0.7), in Jan, Feb, Dec");
		expect(d({ op: 'demand.scale', factor: 1.1, category: 'user' })).toBe("Demand of every other water user: 110 % of what they'd take (× 1.1)");
		expect(d({ op: 'demand.scale', factor: 0.5, nodeIds: ['gone'] })).toBe("Irrigation demand of a node the base run doesn’t have: 50 % of what they'd take (× 0.5)");
	});

	it('describes a supply rule and river pump change in run comparison\'s words (WP-3.8)', () => {
		expect(d({ op: 'node.set', nodeId: UP, field: 'supplyRule', value: 'riverFirst' })).toBe('Upper farm: Supply rule dam only → river first');
		expect(d({ op: 'node.set', nodeId: UP, field: 'supplyRule', value: 'trigger' })).toBe('Upper farm: Supply rule dam only → dam, river when low');
		expect(d({ op: 'node.set', nodeId: LO, field: 'supplyRule', value: 'runOfRiver' })).toBe('Lower farm: Supply rule dam only → run of river');
		expect(d({ op: 'node.set', nodeId: UP, field: 'pumpCapacityM3Day', value: 1200 })).toBe('Upper farm: River pump capacity no limit → 1\u202f200 m³/day');
		expect(d({ op: 'node.set', nodeId: UP, field: 'supplyTriggerPct', value: 0.3 })).toBe('Upper farm: Supply switch-to-river level 40 % → 30 %');
		expect(d({ op: 'node.set', nodeId: UP, field: 'supplyStopPct', value: 0.75 })).toBe('Upper farm: Supply switch-back level 60 % → 75 %');
		// A pump change on the applicant's own farm is the proposal (the engine's classifyOp).
		expect(classifyOp({ op: 'node.set', nodeId: UP, field: 'pumpCapacityM3Day', value: 1200 }, [UP], b)).toBe('proposal');
	});

	it('describes additions from the op itself', () => {
		const node = { ...newNode(4, LO), id: 'n9', name: 'Pump scheme', damCapacityM3: 50_000 };
		expect(d({ op: 'node.add', node })).toBe('Add the unit “Pump scheme”, draining into Lower farm, dam 50\u202f000 m³');
		const user = { ...newNode(4, G), id: 'n10', name: 'Town', kind: 'user' as const, userDemandM3Day: new Array(12).fill(300) };
		expect(d({ op: 'node.add', node: user })).toBe('Add the other water user “Town”, draining into Outflow gauge, demand 300 m³/day every month');
		expect(
			d({ op: 'transfer.add', transfer: { id: 't2', fromNodeId: LO, toNodeId: UP, months: [1, 2], maxRateM3s: 0.005, dailyCapM3: 400, minStoragePct: 0, enabled: true, priority: 1 } })
		).toBe('Add a transfer Lower farm → Upper farm (Jan, Feb, up to 0.005 m³/s, at most 400 m³/day)');
		expect(d({ op: 'landCover.add', patch: { id: 'p2', nodeId: UP, coverClass: 'invasive', areaKm2: 0.4, densityPct: 0.3, factors: null } })).toBe(
			'Upper farm: add Invasive alien trees, dryland (wattle, pine, eucalypt), 0.4 km² at 30 % cover'
		);
	});

	it('names a target the input no longer has from the names it had, and leaves out an unknown “was”', () => {
		const gone = stepInputs(b, [{ op: 'node.remove', nodeId: LO }]).after;
		expect(describeOp({ op: 'node.remove', nodeId: LO }, gone, namesOf([b.model]))).toBe('Remove “Lower farm”');
		expect(describeOp({ op: 'node.remove', nodeId: 'nope' }, gone, namesOf([b.model]))).toBe('Remove “a node the base run doesn’t have”');
		expect(describeOp(raise, null, namesOf([b.model]))).toBe('Upper farm: Dam capacity → 180\u202f000 m³');
		expect(describeOp({ op: 'transfer.remove', transferId: 'x' }, null)).toBe('Remove a transfer');
	});

	it('shows a stored change to a legacy runoff setting (removed in engine 1.0.0) by its path, and checks it as retired', () => {
		const old = { op: 'settings.set', path: 'calibration.a', value: 0.2 } as unknown as ScenarioOp;
		expect(d(old)).toBe('calibration.a: → 0.2');
		expect(checkOp(old)).toEqual({ ok: false, error: expect.stringMatching(/legacy runoff model, removed in engine 1\.0\.0: delete this change/) });
	});
});

describe('statusByOp', () => {
	it('lines problems and notes up with their ops and keeps a problem that names none', () => {
		const s = statusByOp(3, [{ index: 0, op: raise, notes: ['moved'] }], [
			'op 2 (node.remove): node x not found',
			'op 2 (node.remove): and more',
			'op 9 (node.set): out of range',
			'something else'
		]);
		expect(s.ops).toEqual([
			{ problem: null, notes: ['moved'] },
			{ problem: 'node x not found; and more', notes: [] },
			{ problem: null, notes: [] }
		]);
		expect(s.other).toEqual(['op 9 (node.set): out of range', 'something else']);
	});

	it('gives an edit group\'s problem to every op it names, a node name with parentheses included', () => {
		const s = statusByOp(5, [{ index: 0, op: raise, notes: [] }], [
			'op 3 (node.set): damInitialPct must be at most 1',
			'ops 2–4 (node.set, "Kalkoenkrans (2)"): run of river has no dam',
			'ops 1, 5 (node.set, "Farm A"): stop level must be at least its trigger level',
			'ops 4–9 (node.set, "Farm B"): out of range'
		]);
		expect(s.ops.map((o) => o.problem)).toEqual([
			'stop level must be at least its trigger level',
			'run of river has no dam',
			'damInitialPct must be at most 1; run of river has no dam',
			'run of river has no dam',
			'stop level must be at least its trigger level'
		]);
		// A group reaching past the list names ops that aren't there: kept whole, never half-assigned.
		expect(s.other).toEqual(['ops 4–9 (node.set, "Farm B"): out of range']);
	});
});

it('swaps ids in an engine message for names', () => {
	expect(nameIds(`"Upper farm" now drains into ${G}; node ${LO.toUpperCase()} x`, new Map([[G, 'Outflow gauge']]))).toBe(
		`"Upper farm" now drains into “Outflow gauge”; node ${LO.toUpperCase()} x`
	);
});

describe('buildOp', () => {
	const m = base().model;
	let n = 0;
	const id = () => `11111111-0000-4000-8000-${String(++n).padStart(12, '0')}`;
	const draft = (o: Partial<OpDraft>): OpDraft => ({ ...emptyDraft(o.kind), ...o });

	it('builds a dam raise from the typed capacity, and a percentage field from its percent', () => {
		expect(buildOp(draft({ kind: 'node.set', nodeId: UP, field: 'damCapacityM3', value: '180 000' }), m)).toEqual({ ok: true, op: raise });
		expect(buildOp(draft({ kind: 'node.set', nodeId: UP, field: 'damMinPct', value: '15' }), m)).toEqual({
			ok: true,
			op: { op: 'node.set', nodeId: UP, field: 'damMinPct', value: 0.15 }
		});
		expect(draftSpec({ kind: 'node.set', field: 'damMinPct' })).toMatchObject({ t: 'number', unit: '%' });
		expect(draftSpec({ kind: 'crop.add', field: 'x' })).toBeNull();
	});

	it('builds a farm\'s supply rule and river pump (WP-3.8): a rule from the list, a pump in m³/day, blank for no limit, levels in %', () => {
		const ok = (field: string, value: string) => buildOp(draft({ kind: 'node.set', nodeId: UP, field, value }), m);
		expect(ok('supplyRule', 'riverFirst')).toEqual({ ok: true, op: { op: 'node.set', nodeId: UP, field: 'supplyRule', value: 'riverFirst' } });
		expect(ok('pumpCapacityM3Day', '1 200')).toEqual({ ok: true, op: { op: 'node.set', nodeId: UP, field: 'pumpCapacityM3Day', value: 1200 } });
		expect(ok('pumpCapacityM3Day', '')).toEqual({ ok: true, op: { op: 'node.set', nodeId: UP, field: 'pumpCapacityM3Day', value: null } });
		expect(ok('supplyTriggerPct', '30')).toEqual({ ok: true, op: { op: 'node.set', nodeId: UP, field: 'supplyTriggerPct', value: 0.3 } });
		expect(ok('supplyStopPct', '120')).toEqual({ ok: false, error: 'Must be at most 100 %' });
		expect(ok('pumpCapacityM3Day', '-1')).toEqual({ ok: false, error: 'Must be at least 0' });
		expect(ok('supplyRule', '')).toEqual({ ok: false, error: 'Supply rule: pick one' });
		expect(draftSpec({ kind: 'node.set', field: 'supplyRule' })).toMatchObject({ t: 'enum' });
	});

	it('says what is wrong with a PE input before anything is saved', () => {
		expect(buildOp(draft({ kind: 'settings.set', field: 'pe', pe: { kind: 'monthly', mm: '100', source: '' } }), m)).toEqual({
			ok: false,
			error: 'GR4J potential evaporation: say where the monthly PE comes from: its source is required'
		});
		expect(buildOp(draft({ kind: 'settings.set', field: 'pe', pe: { kind: 'pan', mm: '', source: '' } }), m)).toEqual({
			ok: true,
			op: { op: 'settings.set', path: 'pe', value: { kind: 'pan' } }
		});
	});

	it('says what is missing or out of range, in the units typed', () => {
		expect(buildOp(draft({ kind: 'node.set', field: 'damCapacityM3', value: '1' }), m)).toEqual({ ok: false, error: 'Pick a node' });
		expect(buildOp(draft({ kind: 'node.set', nodeId: UP, value: '1' }), m)).toEqual({ ok: false, error: 'Pick what to change' });
		expect(buildOp(draft({ kind: 'node.set', nodeId: UP, field: 'damMinPct', value: '150' }), m)).toEqual({ ok: false, error: 'Must be at most 100 %' });
		expect(buildOp(draft({ kind: 'node.set', nodeId: UP, field: 'damCapacityM3', value: 'big' }), m)).toEqual({ ok: false, error: 'Dam capacity: “big” isn\'t a number' });
		expect(buildOp(draft({ kind: 'series.scale', changePct: '-150' }), m)).toEqual({ ok: false, error: 'The change must be between −100 % and +900 %' });
		expect(buildOp(draft({ kind: 'node.add', downstreamNodeId: UP }), m)).toEqual({ ok: false, error: 'Enter a name for the new node' });
		expect(buildOp(draft({ kind: 'demand.scale', demandPct: '250' }), m)).toEqual({ ok: false, error: "The demand must be between 0 % and 200 % of what they'd take" });
		expect(buildOp(draft({ kind: 'demand.scale', demandPct: '-5' }), m)).toEqual({ ok: false, error: "The demand must be between 0 % and 200 % of what they'd take" });
		expect(buildOp(draft({ kind: 'demand.scale' }), m)).toEqual({ ok: false, error: 'Enter the demand' });
	});

	it('builds a new leaf node with every field the engine needs, placed after the others', () => {
		const r = buildOp(draft({ kind: 'node.add', newName: ' Pump scheme ', downstreamNodeId: LO, damCapacityM3: '50000' }), m, id);
		expect(r.ok).toBe(true);
		const op = (r as { op: Extract<ScenarioOp, { op: 'node.add' }> }).op;
		expect(op.node).toMatchObject({ name: 'Pump scheme', kind: 'farm', downstreamNodeId: LO, damCapacityM3: 50_000, sortOrder: 3 });
		// It applies to the base: the engine accepts the node as built.
		expect(applyScenario(base(), [op]).problems).toEqual([]);

		const u = buildOp(draft({ kind: 'node.add', newKind: 'user', newName: 'Town', downstreamNodeId: G, demandM3Day: '300' }), m, id);
		expect(u.ok && u.op.op === 'node.add' && u.op.node.userDemandM3Day).toEqual(new Array(12).fill(300));
		expect(applyScenario(base(), [(u as { op: ScenarioOp }).op]).problems).toEqual([]);
	});

	it('builds every other kind of op the form offers, each one the engine applies', () => {
		const ops = [
			draft({ kind: 'node.remove', nodeId: LO }),
			draft({ kind: 'cropArea.set', nodeId: LO, cropId: CROP, areaHa: '12,5' }),
			draft({ kind: 'crop.add', cropName: 'Vines', cropFactors: '0.3' }),
			draft({ kind: 'transfer.add', fromNodeId: LO, toNodeId: UP, months: [2, 1], maxRateM3s: '0.005', dailyCapM3: '', minStoragePct: '10', priority: '2' }),
			draft({ kind: 'transfer.set', transferId: T, field: 'months', months: [12, 1] }),
			draft({ kind: 'transfer.set', transferId: T, field: 'enabled', value: 'false' }),
			draft({ kind: 'transfer.remove', transferId: T }),
			draft({ kind: 'landCover.add', nodeId: UP, coverClass: 'invasive', coverAreaKm2: '0.4', densityPct: '30' }),
			draft({ kind: 'landCover.remove', patchId: P }),
			draft({ kind: 'settings.set', field: 'flowShareMethod', value: 'hiLo' }),
			draft({ kind: 'settings.set', field: 'calibration.rainThresholdMm', value: '3' }),
			draft({ kind: 'settings.set', field: 'pe', pe: { kind: 'monthly', mm: '100', source: ' Station ET₀ ' } }),
			draft({ kind: 'series.scale', seriesKind: 'rain_catchment_mm', changePct: '-10', from: '2022-01-01', to: '' })
		].map((x) => buildOp(x, m, id));
		for (const r of ops) expect(r.ok, JSON.stringify(r)).toBe(true);
		const built = ops.map((r) => (r as { op: ScenarioOp }).op);
		expect(built[1]).toEqual({ op: 'cropArea.set', nodeId: LO, cropId: CROP, areaM2: 125_000 });
		expect(built[3]).toMatchObject({ op: 'transfer.add', transfer: { months: [1, 2], dailyCapM3: null, minStoragePct: 0.1, priority: 2, enabled: true } });
		expect(built[4]).toEqual({ op: 'transfer.set', transferId: T, field: 'months', value: [1, 12] });
		expect(built[5]).toEqual({ op: 'transfer.set', transferId: T, field: 'enabled', value: false });
		expect(built[7]).toMatchObject({ op: 'landCover.add', patch: { nodeId: UP, areaKm2: 0.4, densityPct: 0.3, factors: null } });
		expect(built[11]).toEqual({ op: 'settings.set', path: 'pe', value: { kind: 'monthly', mm: new Array(12).fill(100), source: 'Station ET₀' } });
		expect(built[12]).toEqual({ op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.9, from: '2022-01-01' });
		// Each applies to the base on its own (series.scale needs the run's stored rain, so it is the server's).
		for (const op of built.slice(0, 12)) expect(applyScenario(base(), [op]).problems, op.op).toEqual([]);
		// A settings change, the PE input included, is a baseline assumption whoever owns what.
		expect(classifyOp(built[11]!, [UP, LO, G])).toBe('baseline');
	});

	it('builds a demand scaling (issue #53 R1): none ticked is all, every month is none, farms are the default', () => {
		const b = (o: Partial<OpDraft>) => buildOp(draft({ kind: 'demand.scale', ...o }), m);
		expect(b({ demandPct: '85' })).toEqual({ ok: true, op: { op: 'demand.scale', factor: 0.85 } });
		expect(b({ demandPct: '70', demandNodeIds: [LO, UP, LO], months: [2, 12, 1] })).toEqual({ ok: true, op: { op: 'demand.scale', factor: 0.7, nodeIds: [LO, UP], months: [1, 2, 12] } });
		expect(b({ demandPct: '85', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] })).toEqual({ ok: true, op: { op: 'demand.scale', factor: 0.85 } });
		expect(b({ demandPct: '90', demandCategory: 'user' })).toEqual({ ok: true, op: { op: 'demand.scale', factor: 0.9, category: 'user' } });
		// Each farm op applies to the base; on the author's own farm alone it is the proposal, else a baseline assumption.
		const own = (b({ demandPct: '85', demandNodeIds: [UP] }) as { op: ScenarioOp }).op;
		const all = (b({ demandPct: '85' }) as { op: ScenarioOp }).op;
		const r = applyScenario(base(), [own, all]);
		expect(r.problems).toEqual([]);
		expect(r.input.model.nodes.find((n) => n.id === UP)!.demandFactor![0]).toBeCloseTo(0.85 * 0.85, 12);
		expect(classifyOp(own, [UP])).toBe('proposal');
		expect(classifyOp(all, [UP])).toBe('baseline');
		// The base has no other water user, so a user scaling of all of them is the server's problem to report.
		expect(applyScenario(base(), [(b({ demandPct: '90', demandCategory: 'user' }) as { op: ScenarioOp }).op]).problems).toEqual(['op 1 (demand.scale): the model has no other water user to scale']);
	});

	it('builds and describes a borehole to add and one to remove (WP-3.9)', () => {
		const add = buildOp(draft({ kind: 'borehole.add', nodeId: UP, bhName: ' BH new ', bhCapacityM3Day: '250', bhAnnualCapM3: '40000', bhMode: 'primary', bhDepletionPct: '20' }), m, id);
		expect(add.ok, JSON.stringify(add)).toBe(true);
		const op = (add as { op: ScenarioOp }).op;
		expect(op).toMatchObject({ op: 'borehole.add', borehole: { nodeId: UP, name: 'BH new', capacityM3Day: 250, annualCapM3: 40_000, mode: 'primary', target: 'direct', emergencyBelowPct: 0.3, depletionFactor: 0.2 } });
		expect(describeOp(op, base())).toBe('Upper farm: add the borehole “BH new”, 250 m³/day primary, at most 40\u202f000 m³/a, depletion 20 %');
		const after = applyScenario(base(), [op]);
		expect(after.problems).toEqual([]);
		const boreholeId = (op as { borehole: { id: string } }).borehole.id;
		const remove = buildOp(draft({ kind: 'borehole.remove', boreholeId }), m, id);
		expect(remove).toEqual({ ok: true, op: { op: 'borehole.remove', boreholeId } });
		expect(describeOp((remove as { op: ScenarioOp }).op, after.input)).toBe('Upper farm: remove the borehole “BH new”');
		expect(buildOp(draft({ kind: 'borehole.add', nodeId: UP, bhName: '', bhCapacityM3Day: '1' }), m, id)).toMatchObject({ ok: false });
	});
});

describe('ewrRule.set: a site\'s Reserve rule table (engine ≥ 1.6.0, WP-3.7)', () => {
	const W = '00000000-0000-4000-8000-0000000000e1';
	/** The base with a second gauge, the Weir, above the outlet, and a desktop table at the outlet keyed by its node id. */
	const withTables = (): ModelInput => {
		const b = base();
		b.model.nodes.push({ ...newNode(3, G), id: W, name: 'Weir', kind: 'gauge' });
		b.settings = { ...b.settings, ewrRules: [{ ...blankEwrRuleTable(G), source: 'Invented desktop run', sourceKind: 'desktop' }] };
		return b;
	};
	const draft = (o: Partial<OpDraft>): OpDraft => ({ ...emptyDraft('ewrRule.set'), ...o });
	const filled = (t: EwrRuleTable): EwrRuleTable => ({
		...t,
		source: '  Invented gazette notice, table 2 ',
		sourceKind: 'gazetted',
		ewr: t.ewr.map((row) => row.map((_, i) => 10 - i))
	});

	it('starts from the site\'s table (the outlet\'s, however it is keyed), or a blank one', () => {
		const b = withTables();
		expect(startTable(b, OUTLET_SITE)).toMatchObject({ siteNodeId: null, source: 'Invented desktop run', sourceKind: 'desktop' });
		expect(startTable(b, W)).toEqual(blankEwrRuleTable(W));
		// A copy: editing it leaves the base alone.
		startTable(b, OUTLET_SITE).source = 'changed';
		expect(b.settings.ewrRules![0]!.source).toBe('Invented desktop run');
	});

	it('builds the op from the Settings editor\'s table, checked with the Settings form\'s own words', () => {
		const b = withTables();
		expect(buildOp(draft({}), b.model)).toEqual({ ok: false, error: 'Pick an EWR site' });
		expect(buildOp(draft({ ewrSite: W }), b.model)).toEqual({ ok: false, error: 'The table was removed: pick the site again' });
		expect(buildOp(draft({ ewrSite: W, ewrTables: [startTable(b, W)] }), b.model)).toEqual({
			ok: false,
			error: 'Say where the table comes from (Reserve determination, gazette notice, table).'
		});
		// A blank cell in the editor is NaN: named, not sent.
		const gap = filled(startTable(b, W));
		gap.ewr[0]![3] = NaN;
		expect(buildOp(draft({ ewrSite: W, ewrTables: [gap] }), b.model)).toEqual({ ok: false, error: "EWR values must be numbers from 0 to 1\u202f000\u202f000 (Oct has one that isn't)." });
		const r = buildOp(draft({ ewrSite: OUTLET_SITE, ewrTables: [filled(startTable(b, OUTLET_SITE))] }), b.model);
		expect(r.ok, JSON.stringify(r)).toBe(true);
		const op = (r as { op: ScenarioOp }).op;
		expect(op).toMatchObject({ op: 'ewrRule.set', table: { siteNodeId: null, source: 'Invented gazette notice, table 2', sourceKind: 'gazetted' } });
		// It applies (replacing the outlet's table) and is a baseline assumption even with every node owned.
		const applied = applyScenario(b, [op]);
		expect(applied.problems).toEqual([]);
		expect(applied.input.settings.ewrRules).toHaveLength(1);
		expect(classifyScenario(b, [op], b.model.nodes.map((x) => x.id))).toEqual(['baseline']);
	});

	it('describes the table it sets and the one it replaces, each with its source and confidence line', () => {
		const b = withTables();
		const set = (t: EwrRuleTable): ScenarioOp => ({ op: 'ewrRule.set', table: t });
		const gazette = filled(blankEwrRuleTable(null));
		expect(describeOp(set(gazette), b)).toBe(
			'Reserve rule table at the outlet (Outflow gauge): “Invented desktop run” (Desktop estimate, low confidence) → “Invented gazette notice, table 2” (Gazetted Reserve), total flow, 10 % points'
		);
		expect(describeOp(set({ ...gazette, siteNodeId: W, sourceKind: null, component: 'lowFlow' }), b)).toBe(
			'Reserve rule table at Weir: none → “Invented gazette notice, table 2” (kind of source not stated), low flows, 10 % points'
		);
		// No base (a scenario run compared with another run): only what it set.
		expect(describeOp(set(gazette), null)).toBe('Reserve rule table at the outlet: → “Invented gazette notice, table 2” (Gazetted Reserve), total flow, 10 % points');
		const { items } = opItems([set(gazette)], ['baseline'], null, b, new Map());
		expect(items[0]).toMatchObject({ cls: 'baseline', problem: null });
	});
});

describe('opItems', () => {
	it('describes each op against the input it meets, with its class, problem and notes, ids named', () => {
		const b = base();
		const again: ScenarioOp = { op: 'node.set', nodeId: UP, field: 'damCapacityM3', value: 200_000 };
		const gone: ScenarioOp = { op: 'node.remove', nodeId: LO };
		const ops = [raise, again, gone];
		const { items, other } = opItems(
			ops,
			['proposal', 'proposal', 'baseline'],
			{
				applied: [
					{ index: 0, op: raise, notes: [] },
					{ index: 1, op: again, notes: [`re-linked ${G}`] }
				],
				problems: [`op 3 (node.remove): node ${LO} not found`, 'stray']
			},
			b,
			namesOf([b.model], ops)
		);
		expect(items).toEqual([
			{ text: 'Upper farm: Dam capacity 150\u202f000 m³ → 180\u202f000 m³', cls: 'proposal', problem: null, notes: [] },
			// The second raise replaces the first one's value, not the base's.
			{ text: 'Upper farm: Dam capacity 180\u202f000 m³ → 200\u202f000 m³', cls: 'proposal', problem: null, notes: ['re-linked “Outflow gauge”'] },
			{ text: 'Remove “Lower farm”', cls: 'baseline', problem: 'node “Lower farm” not found', notes: [] }
		]);
		expect(other).toEqual(['stray']);
	});

	it('shows an incomplete edit group\'s problem, and every op of it OK once the last op completes it', () => {
		const trig = applyScenario(base(), [{ op: 'node.set', nodeId: UP, field: 'supplyRule', value: 'trigger' }]).input;
		const rule: ScenarioOp = { op: 'node.set', nodeId: UP, field: 'supplyRule', value: 'runOfRiver' };
		const dam: ScenarioOp = { op: 'node.set', nodeId: UP, field: 'damCapacityM3', value: 0 };
		const names = namesOf([trig.model]);
		// The server's check is the engine's applyScenario on the run's input.
		const shown = (ops: ScenarioOp[]) => opItems(ops, null, applyScenario(trig, ops), trig, names).items;
		const half = shown([rule]);
		expect(half).toEqual([{ text: 'Upper farm: Supply rule dam, river when low → run of river', cls: null, problem: expect.stringMatching(/^"Upper farm": run of river has no dam/), notes: [] }]);
		const whole = shown([rule, dam]);
		expect(whole.map((i) => i.problem)).toEqual([null, null]);
		expect(whole[1]!.text).toBe('Upper farm: Dam capacity 150\u202f000 m³ → 0 m³');
		// A group that still breaks a rule marks each of its ops.
		const broken = shown([rule, { op: 'node.set', nodeId: UP, field: 'pumpCapacityM3Day', value: 900 }]);
		expect(broken.map((i) => i.problem)).toEqual([expect.stringMatching(/run of river has no dam/), expect.stringMatching(/run of river has no dam/)]);
	});

	it('still lists the ops with no base and no check', () => {
		const { items } = opItems([raise], null, null, null, namesOf([base().model]));
		expect(items).toEqual([{ text: 'Upper farm: Dam capacity → 180\u202f000 m³', cls: null, problem: null, notes: [] }]);
	});
});
