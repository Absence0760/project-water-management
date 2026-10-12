import { describe, expect, it } from 'vitest';
import type { MapFeature, StartPlan, StartProposal, StartState, StartUnit } from '$lib/api';
import {
	applySummary,
	applyTicks,
	candidatePoints,
	defaultChoice,
	defaultOutlet,
	drainsIntoName,
	duplicateName,
	emptyName,
	initialTicks,
	openStart,
	openDivide,
	choicesFor,
	countText,
	planBeforeBoundaries,
	proposeBody,
	startStep,
	tickAll,
	unitOffers
} from './startFlow';

const feature = (id: string, kind: MapFeature['kind'], geometry: MapFeature['geometry'] = { type: 'Point', coordinates: [20, -33] }): MapFeature => ({
	id,
	kind,
	name: id,
	nodeId: null,
	nodeName: null,
	damPosition: null,
	geometry,
	properties: {},
	areaM2: null,
	center: [20, -33],
	nonContributingM2: null,
	sourceId: null,
	createdBy: null,
	createdAt: '',
	updatedAt: ''
});
const SQUARE: MapFeature['geometry'] = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const unit = (key: string, over: Partial<StartUnit> = {}): StartUnit => ({
	key,
	featureName: key,
	role: 'unit',
	name: key,
	point: [20, -33],
	snapDistanceM: 10,
	areaM2: 2e6,
	totalAreaM2: 2e6,
	geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
	drainsInto: null,
	drainsIntoProposed: true,
	...over
});
const plan = (units: StartUnit[], over: Partial<StartPlan> = {}): StartPlan => ({
	fromDem: true,
	outlet: { featureId: null, name: 'Outflow gauge', point: [20, -33], snapDistanceM: 0, foundIn: 'boundary' },
	catchment: { areaM2: 9e6, boundaryAreaM2: 9e6 },
	units,
	rest: { name: 'Rest of the catchment', areaM2: 5e6, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
	dropped: [],
	warnings: [],
	cellSizeM: 30,
	zoom: 11,
	windowCells: 1024,
	...over
});
const proposal = (status: StartProposal['status']): StartProposal => ({
	id: status,
	mode: 'start',
	status,
	plan: plan([]),
	fromDem: true,
	dataset: 'DEM',
	datasetFingerprint: '0123456789abcdef',
	method: 'm',
	methodVersion: 'start-2',
	decision: null,
	createdBy: null,
	createdAt: '',
	decidedBy: null,
	decidedAt: null
});
const state = (over: Partial<StartState> = {}): StartState => ({ elevation: true, dataset: null, modelEmpty: true, startedFromMap: false, proposals: [], ...over });

describe('startStep', () => {
	it('reads the step from the server: boundary, then points, then the open proposal', () => {
		expect(startStep(state(), [])).toBe('boundary');
		expect(startStep(state(), [], true)).toBe('points');
		expect(startStep(state(), [feature('b', 'catchment_boundary', SQUARE)])).toBe('points');
		expect(startStep(state({ proposals: [proposal('proposed')] }), [])).toBe('review');
		expect(openStart(state({ proposals: [proposal('superseded'), proposal('proposed')] }))?.id).toBe('proposed');
	});

	it('is at the data step once the model was started from the map, and closed for a model typed in', () => {
		expect(startStep(state({ modelEmpty: false, startedFromMap: true, proposals: [proposal('applied')] }), [])).toBe('data');
		// Started from the map long ago (the applied start no longer among the newest listed): still the data step.
		expect(startStep(state({ modelEmpty: false, startedFromMap: true, proposals: [] }), [])).toBe('data');
		expect(startStep(state({ modelEmpty: false, proposals: [proposal('discarded')] }), [])).toBe('closed');
		expect(startStep(null, [])).toBe('boundary');
	});
});

describe('the points', () => {
	it('lists units’ boundaries (other areas, parcels), dams (points and polygons), and gauge and other points, as candidates', () => {
		const fs = [
			feature('d', 'dam'),
			feature('dp', 'dam', SQUARE),
			feature('o', 'other'),
			feature('op', 'other', SQUARE),
			feature('g', 'gauge'),
			feature('p', 'farm_parcel', SQUARE),
			feature('b', 'catchment_boundary', SQUARE)
		];
		expect(candidatePoints(fs).map((f) => f.id)).toEqual(['d', 'dp', 'o', 'op', 'g', 'p']);
		// An area is a unit by default; a dam part of its unit's composite dam, an other point its river pump (start-16); a gauge
		// a gauge node in the network (the outlet's is left out by proposeBody).
		expect(candidatePoints(fs).map(defaultChoice)).toEqual(['dam', 'dam', 'abstraction', 'unit', 'gauge', 'unit']);
	});

	it('offers an area only as a unit, a gauge only as a gauge node, a dam or a point as part of a unit or a water user (start-16)', () => {
		expect(choicesFor(feature('a', 'other', SQUARE))).toEqual(['unit', 'none']);
		expect(choicesFor(feature('g', 'gauge'))).toEqual(['gauge', 'none']);
		expect(choicesFor(feature('d', 'dam'))).toEqual(['dam', 'user', 'none']);
		expect(choicesFor(feature('dp', 'dam', SQUARE))).toEqual(['dam', 'user', 'none']);
		expect(choicesFor(feature('o', 'other'))).toEqual(['abstraction', 'user', 'none']);
	});

	it('counts the units, the order’s gauges and users, and the dams and pumps that are parts of units', () => {
		expect(countText([])).toBe('No units’ boundaries: the catchment becomes one unit.');
		expect(countText(['unit', 'unit', 'gauge', 'dam', 'abstraction', 'dam'])).toBe('2 units, 1 gauge, plus the rest of the catchment; 3 dams and pumps as parts of the units around them.');
		expect(countText(['unit', 'user', 'user', 'gauge', 'gauge'])).toBe('1 unit, 2 gauges and 2 other water users, plus the rest of the catchment.');
		expect(countText(['dam'])).toBe('No units’ boundaries: the catchment becomes one unit; 1 dam or pump as part of the unit around it.');
	});

	it('tells a plan from before start-16 (a unit at each dam and abstraction point), which can only be proposed again', () => {
		expect(planBeforeBoundaries(plan([unit('a', { role: 'dam' })]))).toBe(true);
		expect(planBeforeBoundaries(plan([unit('a'), unit('g', { role: 'gauge' })]))).toBe(false);
	});

	it('tells a start proposal from a division (the GET lists both modes)', () => {
		const div = { ...proposal('proposed'), id: 'div', mode: 'divide' as const, plan: {} as never };
		expect(openStart(state({ proposals: [div, proposal('superseded')] }))).toBeNull();
		expect(openDivide(state({ proposals: [div] }))?.id).toBe('div');
		expect(openDivide(state({ proposals: [proposal('proposed')] }))).toBeNull();
	});

	it('takes the boundary’s own outlet by default, else the only gauge', () => {
		expect(defaultOutlet([feature('b', 'catchment_boundary', SQUARE), feature('g', 'gauge')])).toBe('');
		expect(defaultOutlet([feature('g', 'gauge')])).toBe('g');
		expect(defaultOutlet([feature('g', 'gauge'), feature('h', 'gauge')])).toBe('');
	});

	it('sends the units only, never the outlet gauge as one', () => {
		expect(proposeBody({ d: 'dam', o: 'abstraction', g: 'gauge', m: 'gauge', x: 'none' }, 'g')).toEqual({
			outletFeatureId: 'g',
			points: [
				{ featureId: 'd', role: 'dam' },
				{ featureId: 'o', role: 'abstraction' },
				{ featureId: 'm', role: 'gauge' }
			]
		});
		expect(proposeBody({}, '').outletFeatureId).toBeNull();
	});
});

describe('the ticks', () => {
	const p = plan([unit('top', { drainsInto: 'low' }), unit('low'), unit('town', { role: 'user', areaM2: null, totalAreaM2: null, geometry: null })]);

	it('open with every value unticked and the proposed names', () => {
		const t = initialTicks(p);
		expect(t.units.every((u) => !u.area && !u.drainsInto && !u.runoffToDam)).toBe(true);
		expect(t.rest).toEqual({ include: false, name: 'Rest of the catchment', area: false });
		expect(t.outletName).toBe('Outflow gauge');
	});

	it('tick every value ticks only what was proposed', () => {
		const t = tickAll(p, initialTicks(p));
		// The composite dam's share of runoff is never proposed or ticked (start-16).
		expect(t.units.map((u) => [u.key, u.area, u.drainsInto, u.runoffToDam])).toEqual([
			['top', true, true, false],
			['low', true, true, false],
			['town', false, true, false]
		]);
		expect(t.rest).toMatchObject({ include: true, area: true });
		// Without an elevation model a unit's boundary's area is offered, never its order.
		const bare = plan([unit('a', { drainsIntoProposed: false }), unit('g', { role: 'gauge', areaM2: null, geometry: null, drainsIntoProposed: false })], { fromDem: false });
		expect(unitOffers(bare.units[0]!)).toEqual({ area: true, drainsInto: false });
		expect(unitOffers(bare.units[1]!)).toEqual({ area: false, drainsInto: false });
	});

	it('offers the rest’s area beside units’ boundaries, with no outline (start-16)', () => {
		const beside = plan([unit('a')], { rest: { name: 'Rest of the catchment', areaM2: 1e6, geometry: null } });
		expect(tickAll(beside, initialTicks(beside)).rest).toMatchObject({ include: true, area: true });
		const none = plan([unit('a')], { rest: { name: 'Rest of the catchment', areaM2: null, geometry: null } });
		expect(tickAll(none, initialTicks(none)).rest).toMatchObject({ include: true, area: false });
	});

	it('names what each unit drains into by the names as typed', () => {
		const t = initialTicks(p);
		t.units[1]!.name = 'Big dam';
		t.outletName = 'Weir';
		expect(drainsIntoName(p, t, p.units[0]!)).toBe('Big dam');
		expect(drainsIntoName(p, t, p.units[1]!)).toBe('Weir');
	});

	it('finds a name used twice or left empty', () => {
		const t = initialTicks(p);
		expect(duplicateName(t)).toBeNull();
		t.units[0]!.name = ' low ';
		expect(duplicateName(t)).toBe('low');
		t.units[0]!.name = '';
		expect(emptyName(t)).toBe(true);
		// The rest's name counts only when it is included.
		const u = initialTicks(p);
		u.rest.name = 'low';
		expect(duplicateName(u)).toBeNull();
		u.rest.include = true;
		expect(duplicateName(u)).toBe('low');
	});

	it('says what apply will do in counts', () => {
		const t = tickAll(p, initialTicks(p));
		expect(applySummary(t)).toBe(
			'The empty model gets 5 hydrological units, with 3 areas (a unit’s is its boundary on the map) and 3 drains-into from the proposal. Each unit’s dams and pump are linked to it, their sizes yours to enter. Everything not ticked stays to be typed: an area of 0, draining into the outflow gauge.'
		);
	});

	it('sends an area’s basis only with its area ticked, and says which areas are effective (195)', () => {
		const t = tickAll(p, initialTicks(p));
		// Gross unless chosen: nothing is sent, the server's default.
		expect(applyTicks(t).units.every((u) => !('areaBasis' in u))).toBe(true);
		t.units[1]!.areaBasis = 'effective';
		t.rest.areaBasis = 'effective';
		// Chosen, then the area unticked: not sent (the server refuses an effective area not taken).
		t.units[0]!.areaBasis = 'effective';
		t.units[0]!.area = false;
		const body = applyTicks(t);
		expect(body.units.map((u) => [u.key, u.area, u.areaBasis])).toEqual([
			['top', false, undefined],
			['low', true, 'effective'],
			['town', false, undefined]
		]);
		expect(body.rest).toEqual({ include: true, name: 'Rest of the catchment', area: true, areaBasis: 'effective' });
		expect(applySummary(t)).toBe(
			'The empty model gets 5 hydrological units, with 2 areas (a unit’s is its boundary on the map; low, Rest of the catchment without what drains into pans) and 3 drains-into from the proposal. Each unit’s dams and pump are linked to it, their sizes yours to enter. Everything not ticked stays to be typed: an area of 0, draining into the outflow gauge.'
		);
	});
});
