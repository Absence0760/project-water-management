// The catchment column catalogues name every runoff series a run stores
// (GR4J_COLUMNS; LEGACY_RUNOFF_COLUMNS only reads runs saved before engine 1.0.0), and the GR4J formulas they print redo a
// day from the stored numbers (docs/ui.md § Self-checks, the catchment trace).
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { GR4J_COLUMNS, LEGACY_RUNOFF_COLUMNS } from './columns';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const rain = Array.from({ length: 120 }, (_, i) => (i % 13 === 0 ? 35 : i % 4 === 0 ? 2 : 0));

function input(settings: ModelInput['settings']): ModelInput {
	const node = {
		sortOrder: 0,
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
		damSeepagePerDay: 0
	};
	return {
		settings: { apanMm: apan as never, ...settings },
		model: {
			nodes: [
				{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
				{ ...node, id: 'F', name: 'Farm', kind: 'farm', downstreamNodeId: 'G', areaKm2: 8 }
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2020-10-01', values: rain } }
	};
}

const cat = (out: ModelOutput, key: string) => out.series.find((s) => s.nodeId === null && s.key === key)?.values;

describe('GR4J_COLUMNS', () => {
	// X2 ≠ 0 so the exchange series is stored too.
	const out = runModel(input({ runoffModel: 'gr4j', gr4j: { x1: 250, x2: -0.4, x3: 70, x4: 2.2, warmupDays: 365 } }));

	it('names every catchment series GR4J stores for the trace, once', () => {
		const keys = GR4J_COLUMNS.map((c) => c.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const k of keys) expect(cat(out, k), k).toHaveLength(out.days);
		expect(GR4J_COLUMNS.every((c) => c.letter && c.formula)).toBe(true);
	});

	it('its formulas redo AET and the production store from the day before', () => {
		const { x1 } = out.summary.runoff!.params as { x1: number };
		const [P, E, aet, S] = ['rain_used', 'pet', 'aet', 'production_store'].map((k) => cat(out, k)!);
		for (let t = 1; t < out.days; t++) {
			const s = S![t - 1]!;
			const pn = Math.max(P![t]! - E![t]!, 0);
			const en = Math.max(E![t]! - P![t]!, 0);
			const ps = pn > 0 ? (x1 * (1 - (s / x1) ** 2) * Math.tanh(pn / x1)) / (1 + (s / x1) * Math.tanh(pn / x1)) : 0;
			const es = en > 0 ? (s * (2 - s / x1) * Math.tanh(en / x1)) / (1 + (1 - s / x1) * Math.tanh(en / x1)) : 0;
			expect(aet![t]).toBeCloseTo(Math.min(P![t]!, E![t]!) + es, 9);
			const s1 = s + ps - es;
			expect(S![t]).toBeCloseTo(s1 - s1 * (1 - (1 + ((4 * s1) / (9 * x1)) ** 4) ** -0.25), 9);
		}
	});

	it("closes each day's store balance: before + P + F − AET − Q = after", () => {
		const b = out.summary.runoff!;
		const [P, aet, F, nat, S, R, UH] = ['rain_used', 'aet', 'exchange', 'natural_flow', 'production_store', 'routing_store', 'uh_store'].map((k) => cat(out, k)!);
		let before = b.storageStartMm;
		for (let t = 0; t < out.days; t++) {
			const after = S![t]! + R![t]! + UH![t]!;
			const q = nat![t]! / (b.areaKm2 * 1000);
			expect(Math.abs(before + P![t]! + F![t]! - aet![t]! - q - after)).toBeLessThan(1e-9);
			before = after;
		}
		expect(F!.some((x) => x !== 0)).toBe(true);
	});
});

describe('LEGACY_RUNOFF_COLUMNS', () => {
	it('describes only stored runs: a run today stores none of its legacy-only series (engine 1.0.0)', () => {
		const out = runModel(input({}));
		const shared = new Set(GR4J_COLUMNS.map((c) => c.key));
		const legacyOnly = LEGACY_RUNOFF_COLUMNS.filter((c) => !shared.has(c.key));
		expect(legacyOnly.map((c) => c.key)).toEqual(['is_summer', 'rain_flow', 'base_flow', 'response_flow', 'resultant_flow']);
		for (const c of legacyOnly) expect(cat(out, c.key), c.key).toBeUndefined();
		// Positive control: the GR4J series are there (exchange only when X2 ≠ 0).
		for (const c of GR4J_COLUMNS) if (c.key !== 'exchange') expect(cat(out, c.key), c.key).toHaveLength(out.days);
	});
});
