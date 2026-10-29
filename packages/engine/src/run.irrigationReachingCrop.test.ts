// The irrigation reaching the crop, as the observed-ET check reads it from a
// run (docs/model.md §2.10o, backend/src/water-use/observed/compare.ts
// cropUse): each day F × G′ ÷ D′, from `crop_requirement` (F), `supplied` and
// `demand` less the unit's demand objects (`object_supplied@…`,
// `object_demand@…`). That is e*·G′ (§2.7: the crop gets e·G of the G
// supplied) only while `demand` = F ÷ e* + Σ object demand every day (§2.3
// item 6, §2.7f), with F and the objects' demand unrestricted: a drought
// restriction (§2.7i) cuts what the unit asks its sources for, never the
// reported demand. Pinned here on a unit with two plantings on different
// irrigation systems (a blended e*), two demand objects, a drought restriction
// that cuts crops and the town, and a dam too small for the demand.
// Synthetic values only.
import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import { objectDemandKey, objectSuppliedKey } from './network/demandObjects';
import { RESTRICTION_SERIES, restrictionCutKey } from './network/restriction';
import { DEFAULT_IRRIGATION_SYSTEMS, type DemandObject, type ModelInput, type NetworkNode, type RunSeries } from './project';
import { runModelWith, withVerification } from './run';
import { runEfficiency } from './verify/workings';

const flat = (v: number) => new Array(12).fill(v);

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 1,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 1,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 0.8,
		returnFlowFraction: 0.2,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const object = (over: Partial<DemandObject>): DemandObject => ({
	id: 'town',
	nodeId: 'A',
	name: 'Town',
	category: 'municipal',
	sizing: 'monthly',
	monthlyM3Day: flat(40),
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0.3,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: '',
	...over
});

const DAYS = 120;

/**
 * Unit A: lucerne on drip (0.90) and citrus on flood (0.70), so e* lies
 * between them; a town (40 m³/day, first) and livestock (15 m³/day, shared with the
 * crops); a 1 600 m³ dam, 51 % full on 1 October 2020, that a trickle of
 * runoff can't keep up with. The restriction is reviewed every ten days:
 * below 50 % of capacity the crops lose 40 % and the town 20 %, below 20 %
 * the crops 70 % and the town 40 %.
 */
function input(): ModelInput {
	return {
		settings: {
			ewrPragmaticM3PerDay: flat(0) as unknown as Monthly,
			apanMm: [180, 210, 240, 250, 210, 180, 120, 80, 60, 60, 90, 130] as unknown as Monthly,
			lakeEvapFactor: 0,
			droughtRestriction: {
				reviewDates: ['10-01', '10-11', '10-21', '11-01', '11-11', '11-21', '12-01', '12-11', '12-21', '01-01', '01-11', '01-21'],
				levels: [
					{ label: 'Level 1', belowPct: 0.5, cuts: { crops: 0.4, municipal: 0.2 } },
					{ label: 'Level 2', belowPct: 0.2, cuts: { crops: 0.7, municipal: 0.4 } }
				]
			}
		},
		model: {
			nodes: [node('A', { downstreamNodeId: 'G', damCapacityM3: 1600, damInitialPct: 0.51 }), node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 1 })],
			crops: [
				{ id: 'lucerne', name: 'Lucerne', cropFactor: [0.9, 1, 1, 1, 1, 0.9, 0.7, 0.6, 0.6, 0.6, 0.7, 0.8] },
				{ id: 'citrus', name: 'Citrus', cropFactor: [0.6, 0.65, 0.7, 0.7, 0.7, 0.65, 0.6, 0.55, 0.55, 0.55, 0.6, 0.6] }
			],
			cropAreas: [
				{ nodeId: 'A', cropId: 'lucerne', areaM2: 6000, irrigationSystemId: 'drip' },
				{ nodeId: 'A', cropId: 'citrus', areaM2: 9000, irrigationSystemId: 'surface' }
			],
			irrigationSystems: DEFAULT_IRRIGATION_SYSTEMS.map((s) => ({ ...s })),
			transfers: [],
			demandObjects: [object({}), object({ id: 'stock', name: 'Cattle', category: 'livestock', monthlyM3Day: flat(15), priority: 'shared', returnPct: 0 })]
		},
		series: { rain_catchment_mm: { startDate: '2020-10-01', values: Array.from({ length: DAYS }, (_, t) => (t % 9 === 0 ? 12 : 0)) } }
	};
}

function get(out: { series: RunSeries[] }, key: string, nodeId: string | null = 'A'): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values as number[];
}

describe('the irrigation reaching the crop the observed-ET check reads (§2.10o)', () => {
	const x = input();
	// A trickle of runoff into the dam every few days: far short of the demand.
	const out = withVerification(x, runModelWith(x, (ctx) => ({ naturalFlowM3Day: Array.from({ length: ctx.days }, (_, t) => (t % 5 === 0 ? 60 : 0)) })));
	const nodeA = x.model.nodes[0]!;
	const e = runEfficiency(x, nodeA);
	const F = get(out, 'crop_requirement');
	const D = get(out, 'demand');
	const G = get(out, 'supplied');
	const R = get(out, RESTRICTION_SERIES.restricted.key);
	const objD = (t: number) => ['town', 'stock'].reduce((s, id) => s + get(out, objectDemandKey(id))[t]!, 0);
	const objG = (t: number) => ['town', 'stock'].reduce((s, id) => s + get(out, objectSuppliedKey(id))[t]!, 0);

	it("the run is self-consistent (the engine's own checks pass)", () => {
		expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
	});

	it('exercises what it means to: a blended e*, restricted days, short days with the restriction off and on', () => {
		expect(e).toBeGreaterThan(0.7);
		expect(e).toBeLessThan(0.9);
		let restricted = 0;
		let shortUnrestricted = 0;
		let shortRestricted = 0;
		for (let t = 0; t < DAYS; t++) {
			const cut = R[t]! < D[t]! - 1e-9;
			if (cut) restricted++;
			if (F[t]! > 0 && G[t]! < D[t]! - 1e-6) cut ? shortRestricted++ : shortUnrestricted++;
		}
		expect(restricted).toBeGreaterThan(20);
		expect(shortRestricted).toBeGreaterThan(5);
		expect(shortUnrestricted).toBeGreaterThan(0);
	});

	it('demand less the objects is F ÷ e* every day, restricted or not, so F × G′ ÷ D′ = e*·G′', () => {
		for (let t = 0; t < DAYS; t++) {
			const Dp = D[t]! - objD(t);
			const Gp = G[t]! - objG(t);
			expect(Math.abs(Dp - F[t]! / e), `day ${t}: demand ${D[t]} − objects ${objD(t)} vs F ${F[t]} ÷ e* ${e}`).toBeLessThanOrEqual(1e-9 * Math.max(1, D[t]!));
			expect(Gp, `day ${t}: irrigation supplied`).toBeGreaterThanOrEqual(-1e-9);
			expect(Gp, `day ${t}: irrigation supplied ${Gp} above its demand ${Dp}`).toBeLessThanOrEqual(Dp + 1e-9 * Math.max(1, Dp));
			if (Dp > 0 && F[t]! > 0) {
				// compare.ts cropUse: F × MIN(1, MAX(0, G′ ÷ D′)).
				const reaching = F[t]! * Math.min(1, Math.max(0, Gp / Dp));
				expect(Math.abs(reaching - e * Gp), `day ${t}`).toBeLessThanOrEqual(1e-9 * Math.max(1, F[t]!));
				// The crop never gets more than its requirement (a restricted day: the next test).
				expect(e * Gp).toBeLessThanOrEqual(F[t]! + 1e-9 * F[t]!);
			}
		}
	});

	it("on a restricted day the crop's water is at most its cut requirement", () => {
		const cropCut = get(out, restrictionCutKey('crops'), null);
		let seen = 0;
		for (let t = 0; t < DAYS; t++) {
			if (!(cropCut[t]! > 0) || !(F[t]! > 0)) continue;
			seen++;
			expect(e * (G[t]! - objG(t))).toBeLessThanOrEqual(F[t]! * (1 - cropCut[t]!) * (1 + 1e-9));
		}
		expect(seen).toBeGreaterThan(20);
	});
});
