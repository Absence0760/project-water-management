import { describe, expect, it } from 'vitest';
import type { MapFeature, StartPlan, StartProposal, StartState, StartUnit } from '$lib/api';
import {
	applySummary,
	candidatePoints,
	defaultChoice,
	defaultOutlet,
	drainsIntoName,
	duplicateName,
	emptyName,
	initialTicks,
	openStart,
	proposeBody,
	startShape,
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
	geometry,
	properties: {},
	areaM2: null,
	center: [20, -33],
	sourceId: null,
	createdBy: null,
	createdAt: '',
	updatedAt: ''
});
const SQUARE: MapFeature['geometry'] = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const unit = (key: string, over: Partial<StartUnit> = {}): StartUnit => ({
	key,
	featureName: key,
	role: 'dam',
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
	status,
	plan: plan([]),
	fromDem: true,
	dataset: 'DEM',
	datasetFingerprint: '0123456789abcdef',
	method: 'm',
	methodVersion: 'start-1',
	decision: null,
	createdBy: null,
	createdAt: '',
	decidedBy: null,
	decidedAt: null
});
const state = (over: Partial<StartState> = {}): StartState => ({ elevation: true, dataset: null, modelEmpty: true, proposals: [], ...over });

describe('startStep', () => {
	it('reads the step from the server: boundary, then points, then the open proposal', () => {
		expect(startStep(state(), [])).toBe('boundary');
		expect(startStep(state(), [], true)).toBe('points');
		expect(startStep(state(), [feature('b', 'catchment_boundary', SQUARE)])).toBe('points');
		expect(startStep(state({ proposals: [proposal('proposed')] }), [])).toBe('review');
		expect(openStart(state({ proposals: [proposal('superseded'), proposal('proposed')] }))?.id).toBe('proposed');
	});

	it('is at the data step once the model was started from the map, and closed for a model typed in', () => {
		expect(startStep(state({ modelEmpty: false, proposals: [proposal('applied')] }), [])).toBe('data');
		expect(startStep(state({ modelEmpty: false, proposals: [proposal('discarded')] }), [])).toBe('closed');
		expect(startStep(null, [])).toBe('boundary');
	});
});

describe('the points', () => {
	it('lists dams (points and polygons), and gauge and other points, as candidates', () => {
		const fs = [
			feature('d', 'dam'),
			feature('dp', 'dam', SQUARE),
			feature('o', 'other'),
			feature('op', 'other', SQUARE),
			feature('g', 'gauge'),
			feature('p', 'farm_parcel', SQUARE),
			feature('b', 'catchment_boundary', SQUARE)
		];
		expect(candidatePoints(fs).map((f) => f.id)).toEqual(['d', 'dp', 'o', 'g']);
		expect(candidatePoints(fs).map(defaultChoice)).toEqual(['dam', 'dam', 'abstraction', 'none']);
	});

	it('takes the boundary’s own outlet by default, else the only gauge', () => {
		expect(defaultOutlet([feature('b', 'catchment_boundary', SQUARE), feature('g', 'gauge')])).toBe('');
		expect(defaultOutlet([feature('g', 'gauge')])).toBe('g');
		expect(defaultOutlet([feature('g', 'gauge'), feature('h', 'gauge')])).toBe('');
	});

	it('sends the units only, never the outlet gauge as one', () => {
		expect(proposeBody({ d: 'dam', o: 'abstraction', g: 'user', x: 'none' }, 'g')).toEqual({
			outletFeatureId: 'g',
			points: [
				{ featureId: 'd', role: 'dam' },
				{ featureId: 'o', role: 'abstraction' }
			]
		});
		expect(proposeBody({}, '').outletFeatureId).toBeNull();
	});
});

describe('the ticks', () => {
	const p = plan([unit('top', { drainsInto: 'low', role: 'abstraction' }), unit('low'), unit('town', { role: 'user', areaM2: null, totalAreaM2: null, geometry: null })]);

	it('open with every value unticked and the proposed names', () => {
		const t = initialTicks(p);
		expect(t.units.every((u) => !u.area && !u.drainsInto && !u.runoffToDam)).toBe(true);
		expect(t.rest).toEqual({ include: false, name: 'Rest of the catchment', area: false });
		expect(t.outletName).toBe('Outflow gauge');
	});

	it('tick every value ticks only what was proposed', () => {
		const t = tickAll(p, initialTicks(p));
		expect(t.units.map((u) => [u.key, u.area, u.drainsInto, u.runoffToDam])).toEqual([
			['top', true, true, false],
			['low', true, true, true],
			['town', false, true, false]
		]);
		expect(t.rest).toMatchObject({ include: true, area: true });
		// Without an elevation model nothing but the rest's area (the boundary) is offered.
		const bare = plan([unit('a', { areaM2: null, geometry: null, drainsIntoProposed: false })], { fromDem: false });
		expect(unitOffers(bare.units[0]!)).toEqual({ area: false, drainsInto: false, runoffToDam: false });
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
			'The empty model gets 5 nodes, with 3 areas (each saved as its unit’s parcel) and 3 drains-into from the proposal. Everything not ticked stays to be typed: an area of 0, draining into the outflow gauge.'
		);
	});
});

describe('startShape (the open proposal drawn on the map)', () => {
	it('gathers every unit’s outline and the rest’s, with the outlet', () => {
		const p = { ...proposal('proposed'), plan: plan([unit('a'), unit('town', { role: 'user', geometry: null })]) };
		const shape = startShape(p)!;
		expect(shape.geometry.type).toBe('MultiPolygon');
		expect(shape.geometry.coordinates).toHaveLength(2);
		expect(shape.outlet).toEqual([20, -33]);
	});

	it('is null with nothing to draw', () => {
		expect(startShape(null)).toBeNull();
		const bare = { ...proposal('proposed'), plan: plan([], { rest: { name: 'Rest', areaM2: null, geometry: null } }) };
		expect(startShape(bare)).toBeNull();
		const noOutlet = { ...proposal('proposed'), plan: plan([unit('a')], { outlet: { featureId: null, name: 'O', point: null, snapDistanceM: null, foundIn: null } }) };
		expect(startShape(noOutlet)).toBeNull();
	});
});
