import { defaultProjectSettings, newNetworkNode, type Monthly, type NetworkNode, type ProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { dataCount, dataDone, nextItem, startDataItems, type DataInput, type DataItemId } from './startData';

const unit = (id: string, name: string, over: Partial<NetworkNode> = {}): NetworkNode => ({ ...newNetworkNode(id, 0, 'out'), kind: 'farm', name, areaKm2: 10, ...over });
const APAN: Monthly = [150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150];
const outlet: NetworkNode = { ...newNetworkNode('out', 0, null), kind: 'gauge', name: 'Weir', areaKm2: 0 };

/** A model just started from the map: two units with areas, nothing else filled in. */
function fresh(over: Partial<DataInput> = {}): DataInput {
	return {
		model: { nodes: [outlet, unit('a', 'Upper'), unit('b', 'Lower')], cropAreas: [] },
		settings: defaultProjectSettings(),
		feeds: [],
		series: [],
		features: [],
		hasBoundary: true,
		rain: 'none',
		runs: [],
		owner: true,
		...over
	};
}
/** A stored fit (settings.fitRecord) as Apply to form leaves it: only its date is read here. */
const fitRecord = (fittedAt: string) => ({ fittedAt }) as unknown as NonNullable<ProjectSettings['fitRecord']>;
const status = (input: DataInput) => Object.fromEntries(startDataItems(input).map((i) => [i.id, i.status])) as Record<DataItemId, string>;
const item = (input: DataInput, id: DataItemId) => startDataItems(input).find((i) => i.id === id)!;

describe('startDataItems', () => {
	it('lists every proposal in the order a run reads them, each to do on a fresh start, the next one marked', () => {
		const items = startDataItems(fresh());
		expect(items.map((i) => i.id)).toEqual(['network', 'method', 'rain', 'catchment-map', 'unit-rain', 'unit-map', 'evaporation', 'wr2012', 'flow', 'dams', 'crops', 'ewr', 'run', 'calibrate']);
		expect(status(fresh())).toMatchObject({ network: 'done', method: 'done', rain: 'todo', 'unit-rain': 'todo', 'unit-map': 'todo', evaporation: 'todo', wr2012: 'todo', flow: 'todo', dams: 'done', crops: 'todo', ewr: 'todo', run: 'todo', calibrate: 'todo' });
		expect(nextItem(items)!.id).toBe('rain');
		expect(dataDone(items)).toBe(false);
		expect(dataCount(items)).toBe('3 of 14');
		// Each links where it is accepted; observed flow lands on the DWS form (F4).
		expect(item(fresh(), 'unit-rain').href).toBe('?tab=series&rain=units#data-feeds');
		expect(item(fresh(), 'unit-map').href).toBe('?tab=settings#set-unit-map');
		expect(item(fresh(), 'wr2012').href).toBe('?tab=calibration#set-wr2012');
		expect(item(fresh(), 'flow').href).toBe('?tab=series&feed=dws#data-feeds');
		expect(item(fresh(), 'evaporation').more).toEqual({ href: '?tab=calibration#set-evaporation', text: 'Evaporation from the map' });
	});

	it('derives each status from what the project holds: done for every unit, started for some', () => {
		const settings = defaultProjectSettings();
		settings.apanMm = APAN;
		settings.wr2012 = { ...settings.wr2012, reference: { quaternary: 'Z99A', areaKm2: 100, marMm3: 5, monthlyMm3: Array(12).fill(0.4), years: null } as never };
		settings.unitRain = { mode: 'perUnit' };
		const input = fresh({
			model: { nodes: [outlet, unit('a', 'Upper', { mapMm: 600, damCapacityM3: 50_000 }), unit('b', 'Lower', { mapMm: 650 })], cropAreas: [{ nodeId: 'a', cropId: 'c', areaM2: 1e5 }] },
			settings,
			rain: 'current',
			feeds: [
				{ source: 'chirps', config: { unit: { nodeId: 'a' } } },
				{ source: 'dws', config: {} }
			],
			features: [{ kind: 'dam', nodeId: 'a' }],
			runs: [{ createdAt: '2026-10-28T10:00:00Z' }]
		});
		expect(status(input)).toMatchObject({ method: 'done', rain: 'done', 'catchment-map': 'partial', 'unit-rain': 'partial', 'unit-map': 'done', evaporation: 'done', wr2012: 'done', flow: 'partial', dams: 'done', crops: 'partial', run: 'done' });
		expect(item(input, 'method').detail).toMatch(/^Per unit/);
		expect(item(input, 'unit-rain').detail).toBe('1 of 2 units have their own CHIRPS feed.');
		expect(item(input, 'catchment-map').detail).toMatch(/units’ area-weighted mean MAP stands in/);
		expect(item(input, 'wr2012').detail).toBe('Against quaternary Z99A.');
		expect(nextItem(startDataItems(input))!.id).toBe('unit-rain');
	});

	it('is done once every item a run needs is, the optional ones aside', () => {
		const settings = defaultProjectSettings();
		settings.apanMm = APAN;
		const input = fresh({
			model: { nodes: [outlet, unit('a', 'Upper', { mapMm: 600 })], cropAreas: [] },
			settings,
			rain: 'current',
			feeds: [{ source: 'chirps', config: { unit: { nodeId: 'a' } } }],
			series: [{ kind: 'flow_observed_m3s', siteNodeId: null, length: 3650 }],
			runs: [{ createdAt: '2026-10-28T10:00:00Z' }]
		});
		// With observed flow at the outlet, a first calibrated run is still to do: the fit, then a run since it (WP-4.10).
		expect(nextItem(startDataItems(input))!.id).toBe('calibrate');
		expect(dataDone(startDataItems(input))).toBe(false);
		settings.fitRecord = fitRecord('2026-10-28T09:00:00Z');
		const items = startDataItems(input);
		expect(items.filter((i) => i.status !== 'done').map((i) => i.id)).toEqual(['catchment-map', 'wr2012', 'crops', 'ewr']);
		expect(dataDone(items)).toBe(true);
		expect(nextItem(items)).toBeNull();
	});

	it('a first calibrated run: the fit to the outlet’s observed flow, then a run since it (WP-4.10)', () => {
		// The fit's day is the viewer's calendar day (rule 7: under a skewed TZ, here 14 hours ahead of UTC).
		const tz = process.env.TZ;
		process.env.TZ = 'Pacific/Kiritimati';
		try {
			calibrateCases();
		} finally {
			process.env.TZ = tz;
		}
		// 11 hours behind UTC, the same moment is the day before.
		process.env.TZ = 'Pacific/Pago_Pago';
		try {
			const settings = defaultProjectSettings();
			settings.fitRecord = fitRecord('2026-10-29T08:00:00Z');
			expect(item(fresh({ settings, runs: [] }), 'calibrate').detail).toBe('GR4J fitted on 28 Oct 2026: run the model again so the results use the fit.');
		} finally {
			process.env.TZ = tz;
		}
	});

	function calibrateCases() {
		const observed = [{ kind: 'flow_observed_m3s', siteNodeId: null, length: 3650 }];
		// No observed record: nothing to fit to, so the item never holds the list open.
		const none = item(fresh(), 'calibrate');
		expect(none).toMatchObject({ status: 'todo', optional: true, href: '?tab=calibration#set-fit', where: 'Calibration → Fit the parameters' });
		expect(none.detail).toMatch(/^Needs an observed flow record at the outlet first/);
		// A record to fit to: required, and next once the run is done.
		const toFit = item(fresh({ series: observed }), 'calibrate');
		expect(toFit).toMatchObject({ status: 'todo', optional: false });
		expect(toFit.detail).toMatch(/Fit the parameters fits them to the outlet’s observed flow/);
		// Fitted after the last run: run again so the results use it.
		const settings = defaultProjectSettings();
		settings.fitRecord = fitRecord('2026-10-29T08:00:00Z');
		const stale = item(fresh({ settings, series: observed, runs: [{ createdAt: '2026-10-28T10:00:00Z' }] }), 'calibrate');
		expect(stale.status).toBe('partial');
		expect(stale.detail).toBe('GR4J fitted on 29 Oct 2026: run the model again so the results use the fit.');
		// A run since the fit: done.
		const done = item(fresh({ settings, series: observed, runs: [{ createdAt: '2026-10-28T10:00:00Z' }, { createdAt: '2026-10-29T09:00:00Z' }] }), 'calibrate');
		expect(done.status).toBe('done');
		expect(done.detail).toMatch(/^GR4J fitted on 29 Oct 2026, and the latest run uses the fit\./);
		// A fit held without an observed record now (the series deleted) still asks for the run since it.
		expect(item(fresh({ settings, runs: [] }), 'calibrate')).toMatchObject({ status: 'partial', optional: false });
		// Still reading: never done.
		expect(item(fresh({ settings: null }), 'calibrate').status).toBe('unknown');
		expect(item(fresh({ runs: null }), 'calibrate').status).toBe('unknown');
	}

	it('the EWR: optional, done once the pragmatic row or a daily EWR from the DRM tables is set', () => {
		expect(item(fresh(), 'ewr')).toMatchObject({ status: 'todo', optional: true, href: '?tab=settings#set-ewr' });
		const settings = defaultProjectSettings();
		settings.ewrPragmaticM3PerDay = APAN;
		expect(item(fresh({ settings }), 'ewr').status).toBe('done');
		expect(item(fresh({ settings: null }), 'ewr').status).toBe('unknown');
	});

	it('the cultivated area links to the first unit still to plant, whose drawer land cover proposes it in', () => {
		expect(item(fresh(), 'crops')).toMatchObject({ href: '?tab=crops&farm=a', where: 'Crops → Upper’s planted areas' });
		const planted = fresh({ model: { nodes: [outlet, unit('a', 'Upper'), unit('b', 'Lower')], cropAreas: [{ nodeId: 'a', cropId: 'c', areaM2: 1e5 }] } });
		expect(item(planted, 'crops').href).toBe('?tab=crops&farm=b');
		const all = fresh({ model: { nodes: [outlet, unit('a', 'Upper'), unit('b', 'Lower')], cropAreas: ['a', 'b'].map((nodeId) => ({ nodeId, cropId: 'c', areaM2: 1e5 })) } });
		expect(item(all, 'crops')).toMatchObject({ href: '?tab=crops', where: 'Crops' });
	});

	it('a unit’s rain feed counts only for that unit; a gauge’s observed flow inside the network isn’t the outlet’s record', () => {
		const input = fresh({ feeds: [{ source: 'chirps', config: { unit: { nodeId: 'zz' } } }, { source: 'chirps', config: {} }], series: [{ kind: 'flow_observed_m3s', siteNodeId: 'a', length: 100 }] });
		expect(status(input)).toMatchObject({ 'unit-rain': 'todo', flow: 'todo' });
	});

	it('says Checking while a source is still read, and never counts it done', () => {
		const items = startDataItems(fresh({ settings: null, feeds: null, series: null, rain: null, runs: null }));
		expect(Object.fromEntries(items.map((i) => [i.id, i.status]))).toMatchObject({ method: 'unknown', rain: 'unknown', 'unit-rain': 'unknown', evaporation: 'unknown', flow: 'unknown', run: 'unknown' });
		expect(dataDone(items)).toBe(false);
		expect(nextItem(items)!.id).toBe('unit-map');
	});

	it('names what an owner does for an editor, the units with no area, and the dams with no volume', () => {
		const input = fresh({ owner: false, model: { nodes: [outlet, unit('a', 'Upper'), unit('r', 'Rest', { areaKm2: 0 })], cropAreas: [] }, features: [{ kind: 'dam', nodeId: 'a' }] });
		expect(item(input, 'unit-rain').detail).toMatch(/An owner of the project attaches it\.$/);
		expect(item(input, 'flow').detail).toMatch(/An owner of the project attaches it\.$/);
		expect(item(input, 'network')).toMatchObject({ status: 'partial', optional: true });
		expect(item(input, 'network').detail).toMatch(/^1 unit has no area yet \(Rest\)/);
		expect(item(input, 'dams')).toMatchObject({ status: 'todo' });
		expect(item(input, 'dams').detail).toMatch(/^0 of 1 unit with dams have a volume/);
	});

	it('without a boundary: rain from the boundary is optional, each unit’s own rain standing in', () => {
		const rain = item(fresh({ hasBoundary: false, rain: null }), 'rain');
		expect(rain).toMatchObject({ status: 'todo', optional: true });
		expect(rain.detail).toMatch(/each unit’s own rain stands in/);
	});

	it('says the A-pan isn’t set until the monthly row or a daily A-pan series is (issue #646 item 5)', () => {
		const none = item(fresh(), 'evaporation');
		expect(none.status).toBe('todo');
		expect(none.optional).toBeFalsy();
		expect(none.detail).toMatch(/^A-pan not set: crop demand and dam evaporation are zero\./);
		const daily = item(fresh({ series: [{ kind: 'evap_apan_mm', length: 365 }] }), 'evaporation');
		expect(daily.status).toBe('done');
		expect(daily.detail).toMatch(/^A daily A-pan series is read/);
		// An empty daily series is no A-pan; while the series load, a row with no monthly A-pan is still being checked.
		expect(item(fresh({ series: [{ kind: 'evap_apan_mm', length: 0 }] }), 'evaporation').status).toBe('todo');
		expect(item(fresh({ series: null }), 'evaporation').status).toBe('unknown');
		const settings = defaultProjectSettings();
		settings.apanMm = APAN;
		expect(item(fresh({ settings, series: null }), 'evaporation').status).toBe('done');
	});

	it('flags a value read over an outline redrawn since as Started, naming the unit (issue #646 F7, F8)', () => {
		const settings = defaultProjectSettings();
		settings.apanMm = APAN;
		const input = fresh({
			settings,
			model: { nodes: [outlet, unit('a', 'Upper', { mapMm: 600 }), unit('b', 'Lower', { mapMm: 650 })], cropAreas: [{ nodeId: 'a', cropId: 'c', areaM2: 1e5 }, { nodeId: 'b', cropId: 'c', areaM2: 1e5 }] },
			feeds: [
				{ source: 'chirps', config: { unit: { nodeId: 'a' } } },
				{ source: 'chirps', config: { unit: { nodeId: 'b' } } }
			]
		});
		expect(status(input)).toMatchObject({ 'unit-rain': 'done', 'unit-map': 'done', crops: 'done', evaporation: 'done' });
		const stale = fresh({
			...input,
			stale: [
				{ kind: 'unit-rain', nodeId: 'a', featureId: 'p1' },
				{ kind: 'unit-map', nodeId: 'b', featureId: 'p2' },
				{ kind: 'land-cover', nodeId: 'a', featureId: 'p1', what: 'Citrus' },
				{ kind: 'evaporation', nodeId: null, featureId: 'bd', what: 'GR4J’s PE' }
			]
		});
		expect(status(stale)).toMatchObject({ 'unit-rain': 'partial', 'unit-map': 'partial', crops: 'partial', evaporation: 'partial' });
		expect(item(stale, 'unit-rain').detail).toMatch(/^Changed since: Upper reads the cells of an earlier outline/);
		expect(item(stale, 'unit-map').detail).toMatch(/^Changed since: the MAP of Lower is from an earlier outline/);
		expect(item(stale, 'crops').detail).toMatch(/^Changed since: the planted area from land cover of Upper/);
		expect(item(stale, 'evaporation').detail).toContain('Changed since: the evaporation from the map (GR4J’s PE) was summarised over an earlier boundary.');
		expect(dataDone(startDataItems(stale))).toBe(false);
	});

	it('says up front that a boundary past ~2 500 km² is too large for rain from the boundary (F14)', () => {
		const big = item(fresh({ boundaryAreaM2: 3_100e6 }), 'rain');
		expect(big.detail).toContain('The boundary is 3');
		expect(big.detail).toContain('km², more than the about 2');
		expect(item(fresh({ boundaryAreaM2: 2_000e6 }), 'rain').detail).not.toContain('more than the about');
		// A feed that reads it already is past the question.
		expect(item(fresh({ boundaryAreaM2: 3_100e6, rain: 'current' }), 'rain').detail).not.toContain('more than the about');
	});
});
