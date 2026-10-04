// End-to-end: a run resumed from a model-state snapshot (docs/model.md
// §2.16) carries everything that sets a unit's demand: the soil-water
// store mid-storm, a demand object's calendar schedule (weekdays, Easter,
// 29 February), the demand factor and a drought restriction level held
// from before the snapshot. Every demand series of the tail must equal the
// same days of the uninterrupted run to the bit. Invented names and values.
import { describe, expect, it } from 'vitest';
import type { DemandObject, DemandScheduleWindow, DroughtRestrictionRule, ModelInput, ModelOutput, NetworkNode } from '../project';
import { captureModelState, runModelFrom, runModelWithoutChecks } from '../run';
import { Rng } from '../testing/fuzz';

const DAY = 86_400_000;
const epoch = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const iso = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
const flat = (v: number) => new Array(12).fill(v);
const APAN = [150, 190, 230, 250, 200, 170, 110, 70, 50, 55, 80, 115];

function unit(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Unit ${id}`,
		kind: 'farm',
		downstreamNodeId: 'G',
		sortOrder: 0,
		areaKm2: 1,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0.5,
		damCapacityM3: 30_000,
		damInitialPct: 0.8,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 0.8,
		returnFlowFraction: 0.1,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}
const win = (over: Partial<DemandScheduleWindow>): DemandScheduleWindow => ({ label: '', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: null, factor: 1, ...over });

const town: DemandObject = {
	id: 'town',
	nodeId: 'A',
	name: 'Town (invented)',
	category: 'municipal',
	sizing: 'monthly',
	monthlyM3Day: flat(40),
	population: 1000,
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0.5,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: '',
	schedule: [win({ weekdays: [6, 7], factor: 0.5 }), win({ span: 'easter', easterFrom: -2, easterTo: 1, factor: 0 }), win({ span: 'yearly', from: '02-29', to: '02-29', factor: 2 })]
};

const START = '2023-10-01';
const END = '2024-06-30';

function input(rule: DroughtRestrictionRule | null): ModelInput {
	const days = epoch(END) - epoch(START) + 1;
	const rng = new Rng(42);
	const rain = Array.from({ length: days }, () => (rng.bool(0.75) ? 0 : Math.round(rng.logFloat(0.5, 70) * 10) / 10));
	// A storm on the day before each capture day, so the soil store is full there.
	rain[epoch('2024-02-28') - epoch(START)] = 60;
	rain[epoch('2024-03-27') - epoch(START)] = 60;
	return {
		settings: {
			apanMm: APAN as never,
			ewrPragmaticM3PerDay: flat(0) as never,
			simulationStart: START,
			simulationEnd: END,
			...(rule ? { droughtRestriction: rule } : {})
		},
		model: {
			nodes: [unit('A', { demandFactor: flat(0.9) }), unit('G', { kind: 'gauge', downstreamNodeId: null, areaKm2: 0, damCapacityM3: 0, damInitialPct: 0 })],
			crops: [{ id: 'c', name: 'Orchard', cropFactor: [0.4, 0.55, 0.7, 0.7, 0.65, 0.6, 0.45, 0.3, 0.2, 0.2, 0.25, 0.35] }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 40_000 }],
			transfers: [],
			demandObjects: [town]
		},
		series: { rain_catchment_mm: { startDate: START, values: rain } }
	};
}

const KEYS = ['gross_demand', 'effective_rain', 'soil_water', 'crop_requirement', 'demand', 'supplied', 'object_demand@town', 'object_supplied@town', 'basic_needs', 'dam_storage'];

function tailEqual(full: ModelOutput, tail: ModelOutput, at: string, extra: string[] = []) {
	const off = epoch(at) - epoch(full.startDate);
	expect(tail.startDate).toBe(at);
	for (const key of [...KEYS, ...extra]) {
		const a = full.series.find((s) => s.nodeId === 'A' && s.key === key) ?? full.series.find((s) => s.nodeId === null && s.key === key);
		const b = tail.series.find((s) => s.nodeId === a?.nodeId && s.key === key);
		expect(a && b, key).toBeTruthy();
		const want = a!.values.slice(off);
		for (let t = 0; t < want.length; t++) if (!Object.is(b!.values[t], want[t])) throw new Error(`${key} on ${iso(epoch(at) + t)}: resumed ${b!.values[t]}, uninterrupted ${want[t]}`);
	}
}

describe('resumed runs keep every demand setting (§2.16)', () => {
	for (const at of ['2024-02-29', '2024-03-28', '2023-12-31']) {
		it(`from ${at}: soil store, schedule, demand factor and floor`, () => {
			const i = input(null);
			const full = runModelWithoutChecks(i);
			const tail = runModelFrom(captureModelState(i, at), i);
			tailEqual(full, tail, at);
		});
	}

	it('a restriction level decided before the snapshot is held into the resumed run', () => {
		// Reviewed 1 March: the dam (30 000 m³) is below 99 % by then, so level 1 holds to 1 June.
		const rule: DroughtRestrictionRule = { reviewDates: ['03-01'], liftDates: ['06-01'], levels: [{ label: 'L1', belowPct: 0.99, cuts: { crops: 0.4, municipal: 0.9 } }] };
		const i = input(rule);
		const full = runModelWithoutChecks(i);
		const lv = full.series.find((s) => s.nodeId === null && s.key === 'restriction_level')!.values;
		expect(lv[epoch('2024-03-15') - epoch(START)]).toBe(1);
		const at = '2024-03-15';
		const tail = runModelFrom(captureModelState(i, at), i);
		tailEqual(full, tail, at, ['restricted_demand', 'restriction_level']);
	});
});
