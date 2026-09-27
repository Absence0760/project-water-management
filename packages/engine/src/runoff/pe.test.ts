// GR4J's potential-evaporation input (settings.pe, engine ≥ 0.31.0, issue #39):
// kind 'pan' is today's pan coefficient × A-pan, kind 'monthly' a PE row given
// directly. Irrigation demand and dam evaporation read A-pan either way.
// Synthetic catchment: invented values only (public repo).
import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, gr4jPeMonthlyMm, PE_SOURCE_MAX, resolvePe, type ModelInput, type PeInput } from '../project';
import { runModel } from '../run';
import { GR4J_NO_PET, hasPotentialEvaporation } from './pet';
import { runoffForcing } from './simulate';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep
const pe: number[] = [110, 130, 150, 160, 140, 115, 75, 45, 30, 30, 45, 75];
const monthly = (mm: number[] = pe, source = 'invented monthly PE'): PeInput => ({ kind: 'monthly', mm: mm as never, source });

/**
 * Two farms draining to a gauge, 2 years of daily rain from 2020-10-01. F
 * irrigates a crop; D has a dam that takes no runoff, inflow or diversion and
 * supplies nothing, so its storage (and so its surface and evaporation)
 * depends on rain on the dam and A-pan only, never on GR4J's flow.
 */
function catchment(settings: ModelInput['settings'] = {}): ModelInput {
	const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0.5, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, lossReturnFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const rain = Array.from({ length: 730 }, (_, i) => (i % 17 === 0 ? 40 : i % 5 === 0 ? 1 : 0));
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, ...settings },
		model: {
			nodes: [
				{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0, pctRunoffToDam: 0 },
				{ ...node, id: 'F', name: 'Farm', kind: 'farm', downstreamNodeId: 'G', areaKm2: 12.5, divertCapacityM3Day: 5000 },
				{ ...node, id: 'D', name: 'Dam farm', kind: 'farm', downstreamNodeId: 'G', areaKm2: 4, pctRunoffToDam: 0, damCapacityM3: 300_000, damInitialPct: 0.8, damAreaFullM2: 60_000 }
			],
			crops: [{ id: 'c', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: [{ nodeId: 'F', cropId: 'c', areaM2: 200_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2020-10-01', values: rain } }
	};
}

type Out = ReturnType<typeof runModel>;
const series = (out: Out, key: string, nodeId: string | null = null) => out.series.find((s) => s.nodeId === nodeId && s.key === key)?.values;

describe('settings.pe: kind pan', () => {
	it('gives exactly the output of a project with no pe (every run before engine 0.31.0)', () => {
		const none = runModel(catchment());
		const pan = runModel(catchment({ pe: { kind: 'pan' } }));
		expect(pan).toEqual(none);
		expect(JSON.stringify(pan)).toBe(JSON.stringify(none));
	});

	it('is the default', () => {
		expect(defaultProjectSettings().pe).toEqual({ kind: 'pan' });
	});
});

describe('settings.pe: kind monthly', () => {
	it('spreads each month’s PE evenly over its calendar days', () => {
		const days = 366; // 2020-10-01 … 2021-10-01
		const f = runoffForcing(
			{ apanMm: apan as never, panCoefficient: defaultProjectSettings().panCoefficient, pe: monthly() },
			{ startDate: '2020-10-01', days, aligned: () => new Array(days).fill(null) }
		);
		expect(f.petMm[0]).toBeCloseTo(110 / 31, 12); // October
		const feb = 31 + 30 + 31 + 31; // 1 Feb 2021, water-year month 4, 28 days
		expect(f.petMm[feb]).toBeCloseTo(140 / 28, 12);
		let total = 0;
		for (let t = 0; t < 365; t++) total += f.petMm[t]!;
		expect(total).toBeCloseTo(pe.reduce((a, v) => a + v, 0), 9);
		// The run's PET series is the same row.
		const out = runModel(catchment({ pe: monthly() }));
		expect(series(out, 'pet')![0]).toBeCloseTo(110 / 31, 12);
		expect(series(out, 'pet')![feb]).toBeCloseTo(140 / 28, 12);
	});

	it('moves GR4J only: crop demand and dam evaporation stay identical, natural flow changes', () => {
		const pan = runModel(catchment());
		const lower = runModel(catchment({ pe: monthly() }));
		const other = runModel(catchment({ pe: monthly(pe.map((v) => v * 1.5)) }));
		for (const out of [lower, other]) {
			for (const [key, node] of [['crop_requirement', 'F'], ['gross_demand', 'F'], ['demand', 'F'], ['dam_evaporation', 'D']] as const) {
				const a = series(pan, key, node);
				expect(a, key).toBeDefined();
				expect(a!.some((v) => v > 0), `${key} is not all zero`).toBe(true);
				expect(series(out, key, node), key).toEqual(a);
			}
			expect(series(out, 'natural_flow')).not.toEqual(series(pan, 'natural_flow'));
			expect(series(out, 'pet')).not.toEqual(series(pan, 'pet'));
		}
		// More PE, less flow.
		const sum = (o: Out) => series(o, 'natural_flow')!.reduce((a, v) => a + v, 0);
		expect(sum(other)).toBeLessThan(sum(lower));
		// And A-pan still drives demand and dam evaporation under a monthly PE (positive control).
		const moreApan = runModel(catchment({ pe: monthly(), apanMm: apan.map((v) => v * 1.2) as never }));
		expect(series(moreApan, 'demand', 'F')).not.toEqual(series(lower, 'demand', 'F'));
		expect(series(moreApan, 'dam_evaporation', 'D')).not.toEqual(series(lower, 'dam_evaporation', 'D'));
		expect(series(moreApan, 'natural_flow')).toEqual(series(lower, 'natural_flow'));
	});

	it('refuses GR4J when the monthly row is 0 in every month, even with A-pan', () => {
		const zeros = new Array(12).fill(0);
		expect(() => runModel(catchment({ pe: monthly(zeros) }))).toThrow(GR4J_NO_PET);
		expect(hasPotentialEvaporation({ apanMm: apan as never, panCoefficient: defaultProjectSettings().panCoefficient, pe: monthly(zeros) })).toBe(false);
		// With A-pan (and the pan coefficient) all 0, a monthly row still runs.
		const out = runModel(catchment({ pe: monthly(), apanMm: zeros as never, panCoefficient: zeros as never }));
		expect(out.summary.runoff!.petMm).toBeGreaterThan(0);
		expect(hasPotentialEvaporation({ apanMm: zeros as never, panCoefficient: zeros as never, pe: monthly() })).toBe(true);
	});

	it('warns about the pan coefficient only when GR4J uses it (kind pan)', () => {
		const odd = [0.5, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.95] as never;
		const kp = (o: Out) => o.summary.warnings.filter((w) => w.includes("FAO-56's typical Class A pan range"));
		expect(kp(runModel(catchment({ panCoefficient: odd })))).toHaveLength(1);
		expect(kp(runModel(catchment({ panCoefficient: odd, pe: { kind: 'pan' } })))).toHaveLength(1);
		expect(kp(runModel(catchment({ panCoefficient: odd, pe: monthly() })))).toEqual([]);
	});

	it('gr4jPeMonthlyMm picks the row by kind', () => {
		const k = new Array(12).fill(0.5);
		expect(gr4jPeMonthlyMm({ apanMm: apan, panCoefficient: k })).toEqual(apan.map((v) => v * 0.5));
		expect(gr4jPeMonthlyMm({ apanMm: apan, panCoefficient: k, pe: { kind: 'pan' } })).toEqual(apan.map((v) => v * 0.5));
		expect(gr4jPeMonthlyMm({ apanMm: apan, panCoefficient: k, pe: monthly() })).toEqual(pe);
	});
});

describe('resolvePe', () => {
	const resolve = (raw: unknown) => {
		const warnings: string[] = [];
		return { pe: resolvePe(raw, warnings), warnings };
	};

	it('reads absent and pan as pan, silently', () => {
		expect(resolve(undefined)).toEqual({ pe: { kind: 'pan' }, warnings: [] });
		expect(resolve(null)).toEqual({ pe: { kind: 'pan' }, warnings: [] });
		expect(resolve({ kind: 'pan' })).toEqual({ pe: { kind: 'pan' }, warnings: [] });
		// Stray fields on a pan input are dropped.
		expect(resolve({ kind: 'pan', mm: pe })).toEqual({ pe: { kind: 'pan' }, warnings: [] });
	});

	it('keeps a good monthly row as given (positive control)', () => {
		expect(resolve({ kind: 'monthly', mm: pe, source: 'station ET₀' })).toEqual({ pe: monthly(pe, 'station ET₀'), warnings: [] });
	});

	it('falls back to pan, with a warning, for an unknown kind or a row that is not a list', () => {
		for (const raw of [{ kind: 'penman' }, 'monthly', 7, { kind: 'monthly' }, { kind: 'monthly', mm: 'x' }]) {
			const r = resolve(raw);
			expect(r.pe).toEqual({ kind: 'pan' });
			expect(r.warnings).toHaveLength(1);
			expect(r.warnings[0]).toMatch(/^unknown potential-evaporation input .*; using pan coefficient × A-pan$/);
		}
	});

	it('pads or cuts a row of the wrong length to 12 months, with a warning', () => {
		const short = resolve({ kind: 'monthly', mm: pe.slice(0, 10), source: 's' });
		expect(short.pe).toEqual(monthly([...pe.slice(0, 10), 0, 0], 's'));
		expect(short.warnings).toEqual(['monthly PE should have 12 values, has 10; missing months are 0']);
		const long = resolve({ kind: 'monthly', mm: [...pe, 99], source: 's' });
		expect(long.pe).toEqual(monthly(pe, 's'));
		expect(long.warnings).toEqual(['monthly PE should have 12 values, has 13; missing months are 0']);
	});

	it('uses 0 for a negative, non-finite or non-numeric month, naming the months', () => {
		const r = resolve({ kind: 'monthly', mm: [-5, NaN, Infinity, null, 'x', ...pe.slice(5)], source: 's' });
		expect(r.pe).toEqual(monthly([0, 0, 0, 0, 0, ...pe.slice(5)], 's'));
		// null reads as 0 (Number(null)), a real value, so it isn't named.
		expect(r.warnings).toEqual(['monthly PE is not a number ≥ 0 in month(s) 1, 2, 3, 5 of the water year; using 0']);
	});

	it(`keeps at most ${PE_SOURCE_MAX} characters of the source, and a missing source is empty`, () => {
		const r = resolve({ kind: 'monthly', mm: pe, source: 'x'.repeat(PE_SOURCE_MAX + 50) });
		expect(r.pe.kind === 'monthly' && r.pe.source).toBe('x'.repeat(PE_SOURCE_MAX));
		expect(r.warnings).toEqual([]);
		expect(resolve({ kind: 'monthly', mm: pe }).pe).toEqual(monthly(pe, ''));
		expect(resolve({ kind: 'monthly', mm: pe, source: 42 }).pe).toEqual(monthly(pe, ''));
	});

	it('panCoefficientSource is provenance only: the run is identical with or without it, and it is capped', () => {
		const none = runModel(catchment());
		const noted = runModel(catchment({ panCoefficientSource: 'FAO-56 Table 5, Case A' }));
		expect(noted.series).toEqual(none.series);
		expect(noted.summary).toEqual(none.summary);
		const long = runModel(catchment({ panCoefficientSource: 'x'.repeat(PE_SOURCE_MAX + 50), pe: { kind: 'pan' } }));
		expect(long.series).toEqual(none.series);
	});

	it('the run reports what it resolved', () => {
		const out = runModel(catchment({ pe: { kind: 'penman' } as never }));
		expect(out.summary.warnings).toContain('unknown potential-evaporation input {"kind":"penman"}; using pan coefficient × A-pan');
	});
});
