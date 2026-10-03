import { describe, expect, it } from 'vitest';
import type { DividePlan, DivideUnit, MapFeature } from '$lib/api';
import {
	defaultDivideChoice,
	divideBody,
	divideDrainsIntoName,
	divideAreaAfterKm2,
	divideOffers,
	divideOverlap,
	divideProblem,
	divideApplyTicks,
	divideSummary,
	doubleNode,
	initialDivideTicks,
	NEW_GAUGE,
	NONE,
	nodeOptions,
	outflowOf,
	sameAsNow,
	tickAllDivide
} from './divideFlow';

const feature = (id: string, kind: MapFeature['kind'], nodeId: string | null = null): MapFeature => ({
	id,
	kind,
	name: id,
	nodeId,
	nodeName: null,
	damPosition: null,
	geometry: { type: 'Point', coordinates: [20, -33] },
	properties: {},
	areaM2: null,
	center: [20, -33],
	nonContributingM2: null,
	sourceId: null,
	createdBy: null,
	createdAt: '',
	updatedAt: ''
});
const nodes = [
	{ id: 'out', name: 'Outflow', kind: 'gauge' as const, downstreamNodeId: null },
	{ id: 'dam', name: 'Dam unit', kind: 'farm' as const, downstreamNodeId: 'out' },
	{ id: 'town', name: 'Town', kind: 'user' as const, downstreamNodeId: 'out' },
	{ id: 'mid', name: 'Mid weir', kind: 'gauge' as const, downstreamNodeId: 'out' }
];
const unit = (key: string, over: Partial<DivideUnit> = {}): DivideUnit => ({
	key,
	featureName: key,
	nodeId: key,
	name: key,
	role: 'dam',
	point: [20, -33],
	snapDistanceM: 0,
	areaM2: 2e6,
	totalAreaM2: 2e6,
	geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
	drainsInto: null,
	current: { areaKm2: 5, areaSource: 'typed', downstreamNodeId: 'out', downstreamName: 'Outflow', pctRunoffToDam: 0 },
	...over
});
const plan = (units: DivideUnit[]): DividePlan => ({
	mode: 'divide',
	outlet: { featureId: null, nodeId: 'out', name: 'Outflow', point: [20, -33], snapDistanceM: 0, foundIn: 'boundary' },
	catchment: { areaM2: 9e6, boundaryAreaM2: null },
	units,
	rest: { areaM2: 4e6, geometry: null },
	untouched: [],
	dropped: [],
	warnings: [],
	cellSizeM: 30,
	zoom: 11,
	windowCells: 1024
});

describe('the points', () => {
	it('finds the one outflow, and offers each point the nodes its kind may stand for, never the outflow', () => {
		expect(outflowOf(nodes)).toBe('out');
		expect(outflowOf([...nodes, { id: 'x', downstreamNodeId: null }])).toBeNull();
		expect(nodeOptions(feature('d', 'dam'), nodes).map((n) => n.id)).toEqual(['dam', 'town']);
		expect(nodeOptions(feature('g', 'gauge'), nodes).map((n) => n.id)).toEqual(['mid']);
		expect(nodeOptions(feature('o', 'other'), nodes).map((n) => n.id)).toEqual(['dam', 'town', 'mid']);
	});

	it('defaults to the node a point stands for, a new gauge for an unlinked gauge, else nothing', () => {
		expect(defaultDivideChoice(feature('d', 'dam', 'dam'), nodes)).toBe('dam');
		expect(defaultDivideChoice(feature('g', 'gauge'), nodes)).toBe(NEW_GAUGE);
		expect(defaultDivideChoice(feature('g', 'gauge', 'mid'), nodes)).toBe('mid');
		expect(defaultDivideChoice(feature('o', 'other'), nodes)).toBe(NONE);
		// Linked to the outflow: that's where the division ends, not a point of it.
		expect(defaultDivideChoice(feature('g', 'gauge', 'out'), nodes)).toBe(NONE);
	});

	it('sends the points (a new gauge as no node), never the outlet; finds a node two points stand for', () => {
		expect(divideBody({ d: 'dam', g: NEW_GAUGE, o: NONE, w: 'mid' }, 'w')).toEqual({
			outletFeatureId: 'w',
			points: [
				{ featureId: 'd', nodeId: 'dam' },
				{ featureId: 'g', nodeId: null }
			]
		});
		expect(divideBody({}, '').outletFeatureId).toBeNull();
		expect(doubleNode({ a: 'dam', b: 'dam' }, '')).toBe('dam');
		expect(doubleNode({ a: 'dam', b: 'dam' }, 'b')).toBeNull();
		expect(doubleNode({ a: NEW_GAUGE, b: NEW_GAUGE }, '')).toBeNull();
	});
});

describe('the ticks', () => {
	const p = plan([unit('top', { role: 'abstraction', drainsInto: 'gauge' }), unit('gauge', { nodeId: null, name: 'G1', role: 'gauge', areaM2: null, geometry: null, current: null })]);

	it('open unticked, a new gauge named as its point; tick every value ticks what was proposed', () => {
		const t = initialDivideTicks(p);
		expect(t).toEqual({
			units: [
				{ key: 'top', area: false, drainsInto: false, runoffToDam: false, add: false },
				{ key: 'gauge', area: false, drainsInto: false, runoffToDam: false, add: false, name: 'G1' }
			],
			rest: { to: 'none' }
		});
		expect(divideOffers(p.units[0]!)).toEqual({ add: false, area: true, drainsInto: true, runoffToDam: false, upstreamToDam: false });
		expect(divideOffers(p.units[1]!)).toEqual({ add: true, area: false, drainsInto: true, runoffToDam: false, upstreamToDam: false });
		expect(tickAllDivide(p, t).units).toEqual([
			{ key: 'top', area: true, drainsInto: true, runoffToDam: false, add: false },
			{ key: 'gauge', area: false, drainsInto: true, runoffToDam: false, add: true, name: 'G1' }
		]);
	});

	it('refuses an order into a new gauge not added, a value on one not added, a clashing or empty name', () => {
		const names = nodes.map((n) => n.name);
		const t = initialDivideTicks(p);
		t.units[0]!.drainsInto = true;
		expect(divideProblem(p, t, names)).toMatch(/new gauge G1, which isn’t being added/);
		t.units[1]!.add = true;
		expect(divideProblem(p, t, names)).toBeNull();
		t.units[1]!.name = 'mid weir';
		expect(divideProblem(p, t, names)).toMatch(/Two nodes would be called “mid weir”/);
		t.units[1]!.name = ' ';
		expect(divideProblem(p, t, names)).toMatch(/Name the new gauge/);
		t.units[1] = { ...t.units[1]!, add: false, name: 'G1', drainsInto: true };
		t.units[0]!.drainsInto = false;
		expect(divideProblem(p, t, names)).toMatch(/tick Add it before/);
		const r = initialDivideTicks(p);
		r.rest = { to: 'new', name: 'Town' };
		expect(divideProblem(p, r, names)).toMatch(/rest of the catchment a name of its own/);
	});

	it('names what a point drains into, a new gauge by its name as typed', () => {
		const t = initialDivideTicks(p);
		t.units[1]!.name = 'Halfway weir';
		expect(divideDrainsIntoName(p, t, p.units[0]!)).toBe('Halfway weir');
		expect(divideDrainsIntoName(p, t, p.units[1]!)).toBe('Outflow');
	});

	it('says when a proposed value is what the node has already', () => {
		const same = plan([unit('a', { areaM2: 5e6 })]);
		expect(sameAsNow(same, same.units[0]!, 'area')).toBe(true);
		expect(sameAsNow(same, same.units[0]!, 'drainsInto')).toBe(true);
		expect(sameAsNow(same, same.units[0]!, 'runoffToDam')).toBe(false);
		expect(sameAsNow(p, p.units[0]!, 'drainsInto')).toBe(false);
	});

	it('offers, compares and counts a marked dam’s shares (194)', () => {
		const shares = { pctUpstreamToDam: 0 as const, pctRunoffToDam: 0.025, damCatchmentM2: 0.05e6 };
		const marked = plan([unit('off', { damShares: shares, current: { areaKm2: 5, areaSource: 'typed', downstreamNodeId: 'out', downstreamName: 'Outflow', pctRunoffToDam: 0.025, pctUpstreamToDam: 1 } }), unit('plain')]);
		expect(sameAsNow(marked, marked.units[0]!, 'runoffToDam')).toBe(true);
		expect(sameAsNow(marked, marked.units[0]!, 'upstreamToDam')).toBe(false);
		// An unmarked dam proposes no upstream share: never "the same".
		expect(sameAsNow(marked, marked.units[1]!, 'upstreamToDam')).toBe(false);
		const t = tickAllDivide(marked, initialDivideTicks(marked));
		expect(t.units.map((u) => u.upstreamToDam)).toEqual([true, undefined]);
		expect(divideSummary(t)).toBe('The model takes 2 areas (each saved as its unit’s parcel), 2 drains-into and 2 runoffs to the dam, 1 upstream inflow to a dam. Every value not ticked stays as it is.');
	});

	it('says what apply will do in counts', () => {
		const t = tickAllDivide(p, initialDivideTicks(p));
		t.rest = { to: 'new', name: 'Rest' };
		expect(divideSummary(t)).toBe(
			'The model takes 2 areas (each saved as its unit’s parcel), 2 drains-into and 0 runoffs to the dam, and 1 new gauge, and a new unit for the rest of the catchment. Every value not ticked stays as it is.'
		);
	});

	it('sends an area’s basis only with its area ticked, and counts the effective areas (195)', () => {
		const t = tickAllDivide(p, initialDivideTicks(p));
		t.units[0]!.areaBasis = 'effective';
		t.units[1]!.areaBasis = 'effective';
		t.rest = { to: 'new', name: 'Rest', areaBasis: 'effective' };
		const body = divideApplyTicks(t);
		// The gauge's area isn't ticked (it owns no land), so its basis goes.
		expect(body.units.map((u) => [u.key, u.areaBasis])).toEqual([
			['top', 'effective'],
			['gauge', undefined]
		]);
		expect(body.rest).toEqual({ to: 'new', name: 'Rest', areaBasis: 'effective' });
		expect(divideSummary(t)).toMatch(/^The model takes 2 areas \(each saved as its unit’s parcel; 2 without what drains into pans\), /);
	});
});

describe('land counted twice (persona-hydrologist, round 4)', () => {
	// A 9 km² catchment: the dam's piece 5 km², the rest 4 km²; Hillside, which no point stands for, keeps 3 km².
	const p = { ...plan([unit('dam', { areaM2: 5e6 })]), untouched: [{ nodeId: 'hill', name: 'Hillside', areaKm2: 3 }] };
	const ticked = () => tickAllDivide(p, initialDivideTicks(p));

	it('adds up the pieces taken, the areas kept and the rest where it goes', () => {
		// Unticked: the dam keeps its 5 km² now, Hillside its 3.
		expect(divideAreaAfterKm2(p, initialDivideTicks(p))).toBeCloseTo(8, 9);
		const t = ticked();
		t.rest = { to: 'new', name: 'Rest' };
		expect(divideAreaAfterKm2(p, t)).toBeCloseTo(12, 9);
		t.rest = { to: 'node', nodeId: 'hill' };
		expect(divideAreaAfterKm2(p, t)).toBeCloseTo(9, 9);
	});

	it('says so before Apply when the units would add up to more than the catchment, naming who keeps a typed area', () => {
		const t = ticked();
		t.rest = { to: 'new', name: 'Rest' };
		expect(divideOverlap(p, t)).toBe(
			'After Apply the units would add up to 12.00 km², more than the 9.00 km² above the outlet, so some land would count twice and its runoff with it. Hillside keeps its typed area: give it the rest of the catchment or a point of its own, or check it.'
		);
		// Nothing taken yet: the model's own typed areas, and the point whose typed area is bigger than its piece, named.
		const big = { ...p, units: [unit('dam', { areaM2: 5e6, current: { areaKm2: 300, areaSource: 'typed', downstreamNodeId: 'out', downstreamName: 'Outflow', pctRunoffToDam: 0 } })] };
		expect(divideOverlap(big, initialDivideTicks(big))).toBe(
			'The model’s areas already add up to 303.00 km², more than the 9.00 km² above the outlet, so some land counts twice and its runoff with it. dam keeps its typed 300.00 km²: tick its area to take its piece. Hillside keeps its typed area: give it the rest of the catchment or a point of its own, or check it.'
		);
		// Hillside takes the rest: the units are the catchment exactly.
		t.rest = { to: 'node', nodeId: 'hill' };
		expect(divideOverlap(p, t)).toBeNull();
		// Within the tolerance: no sentence.
		expect(divideOverlap({ ...p, untouched: [{ nodeId: 'hill', name: 'Hillside', areaKm2: 0.05 }] }, { ...t, rest: { to: 'new', name: 'Rest' } })).toBeNull();
	});
});
