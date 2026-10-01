// A demand object's source (engine 1.56.0, issue #54 Q11, docs/model.md
// §2.7f): where its number comes from, by rule. It is a record for the
// report, never an input to the balance: the run carries it on each object's
// summary and nothing else changes.
import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import type { DemandObject, DemandObjectSource, ModelInput, NetworkNode } from './project';
import { modelRuleIssues } from './modelRules';
import { runModel } from './run';
import { cloneInput, randomInput } from './testing/fuzz';
import { sameOutput } from './testing/invariants';

const flat = (v: number) => new Array(12).fill(v);

const node = (id: string, over: Partial<NetworkNode> = {}): NetworkNode => ({
	id,
	name: id,
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 1,
	areaHiKm2: 0,
	areaLoKm2: 0,
	flowShareManual: null,
	pctUpstreamToDam: 0,
	pctRunoffToDam: 0,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	lossReturnFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

const object = (id: string, over: Partial<DemandObject> = {}): DemandObject => ({
	id,
	nodeId: 'A',
	name: id,
	category: 'municipal',
	sizing: 'monthly',
	monthlyM3Day: flat(50),
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0.5,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: '',
	...over
});

function input(objects: DemandObject[]): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(3100) as unknown as Monthly },
		model: {
			nodes: [node('A', { downstreamNodeId: 'G', pctRunoffToDam: 1 }), node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 1 })],
			crops: [],
			cropAreas: [],
			transfers: [],
			demandObjects: objects
		},
		series: { rain_catchment_mm: { startDate: '2020-10-01', values: [0, 0, 0] } }
	};
}

const summaries = (i: ModelInput) => runModel(i).summary.farms.flatMap((f) => f.demandObjects ?? []);

describe('demand object source (engine 1.56.0)', () => {
	it('is carried on each object’s summary, and left off when not recorded', () => {
		const objects = [
			object('metered', { source: 'meter' }),
			object('strategy', { source: 'aadd' }),
			object('norm', { source: 'perCapita', category: 'domestic', sizing: 'perUnit', monthlyM3Day: null, count: 100, litresPerUnitDay: 200 }),
			object('other', { source: 'other' }),
			object('nullSource', { source: null }),
			object('noSource')
		];
		expect(modelRuleIssues(input(objects).model).size).toBe(0);
		const byId = new Map(summaries(input(objects)).map((s) => [s.id, s]));
		expect(byId.get('metered')!.source).toBe('meter');
		expect(byId.get('strategy')!.source).toBe('aadd');
		expect(byId.get('norm')!.source).toBe('perCapita');
		expect(byId.get('other')!.source).toBe('other');
		expect('source' in byId.get('nullSource')!).toBe(false);
		expect('source' in byId.get('noSource')!).toBe(false);
	});

	it('never echoes a value that isn’t a source (a document the save rules would refuse)', () => {
		const [s] = summaries(input([object('odd', { source: 'guess' as DemandObjectSource })]));
		expect('source' in s!).toBe(false);
	});

	it('changes no number: random networks run to the bit with every source, or none', () => {
		let withObjects = 0;
		for (let seed = 1; seed <= 60 && withObjects < 12; seed++) {
			const base = randomInput(seed, { maxDays: 200 });
			if (!base.model.demandObjects?.length) continue;
			withObjects++;
			const bare = cloneInput(base);
			for (const o of bare.model.demandObjects!) delete o.source;
			const other = cloneInput(base);
			for (const o of other.model.demandObjects!) o.source = 'other';
			const a = runModel(base);
			const b = runModel(bare);
			const c = runModel(other);
			// Only the summaries' own source differs.
			const strip = (out: ReturnType<typeof runModel>) => ({
				...out,
				summary: { ...out.summary, farms: out.summary.farms.map((f) => ({ ...f, ...(f.demandObjects ? { demandObjects: f.demandObjects.map(({ source: _, ...rest }) => rest) } : {}) })) }
			});
			expect(sameOutput(strip(a), strip(b)), `seed ${seed}`).toBe(true);
			expect(sameOutput(strip(a), strip(c)), `seed ${seed}`).toBe(true);
			// And the fuzz gives some objects a source, echoed as the model has it.
			const bySrc = new Map((base.model.demandObjects ?? []).map((o) => [o.id, o.source ?? undefined]));
			for (const s of a.summary.farms.flatMap((f) => f.demandObjects ?? [])) expect(s.source, `seed ${seed} ${s.id}`).toBe(bySrc.get(s.id));
		}
		expect(withObjects).toBeGreaterThan(3);
	}, 120_000);
});
