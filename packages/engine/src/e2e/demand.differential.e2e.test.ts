// End-to-end differential test of the irrigation demand chain (docs/model.md
// §2.3 steps 1–6, §2.3a, item 4a) on random valid networks: every farm's
// gross_demand, effective_rain, soil_water, crop_requirement and demand
// series from runModel against a re-derivation written from model.md alone,
// reading only the run's own rain_final (the rain the doc says demand
// reads, before the threshold) and the input. The fuzz generator's networks
// get, on top, a daily A-pan record, demand factors (unit and crops part)
// and a demand-factor start date in some seeds. Synthetic data only.
import { describe, expect, it } from 'vitest';
import type { DailySeries, ModelInput, ModelOutput, NetworkNode } from '../project';
import { runModelWithoutChecks } from '../run';
import { randomInput, Rng } from '../testing/fuzz';

const DAY = 86_400_000;
const epoch = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const iso = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
const wyIndex = (d: number) => (new Date(d * DAY).getUTCMonth() + 1 + 2) % 12;
const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

/** Seed-dependent extras on a random network: a daily A-pan record, demand factors, a factor start date. */
function withExtras(input: ModelInput, seed: number): ModelInput {
	const rng = new Rng(seed ^ 0x51ed270b);
	const rain = input.series.rain_catchment_mm ?? input.series.rain_chirps_mm ?? input.series.rain_forecast_mm;
	const start = rain ? epoch(rain.startDate) : epoch('2000-01-01');
	const len = rain ? rain.values.length : 30;
	const series = { ...input.series };
	if (rng.bool(0.4)) {
		const off = rng.int(-40, 40);
		const values: (number | null)[] = Array.from({ length: Math.max(1, len + rng.int(-40, 40)) }, () => (rng.bool(0.1) ? null : rng.bool(0.05) ? -1 : Math.round(rng.float(0, 12) * 10) / 10));
		series.evap_apan_mm = { startDate: iso(start + off), values } as DailySeries;
	}
	const nodes = input.model.nodes.map((n): NetworkNode => {
		if (n.kind !== 'farm' || !rng.bool(0.4)) return n;
		const f = Array.from({ length: 12 }, () => (rng.bool(0.2) ? 1 : Math.round(rng.float(0, 1.5) * 100) / 100));
		return { ...n, demandFactor: f, ...(rng.bool(0.5) ? { partDemandFactor: { crops: Array.from({ length: 12 }, () => rng.float(0.2, 1)) } } : {}) };
	});
	const settings = { ...input.settings, ...(rng.bool(0.3) ? { demandFactorFrom: iso(start + rng.int(-10, len + 10)) } : {}) };
	return { ...input, settings, series, model: { ...input.model, nodes } };
}

interface Ref {
	gross: number[];
	used: number[];
	soilMm: number[];
	F: number[];
	e: number;
}

/** model.md §2.3 written out for one farm, from the input and the run's rain_final. */
function reference(input: ModelInput, out: ModelOutput, n: NetworkNode): Ref | null {
	const s = input.settings;
	const feb = num(s.februaryDays, 28.25);
	const dim = [31, 30, 31, 31, feb, 31, 30, 31, 30, 31, 31, 30];
	const apan = Array.from({ length: 12 }, (_, m) => num((s.apanMm as unknown as number[] | undefined)?.[m], 0));
	const thr = num((s.calibration as { rainThresholdMm?: number } | undefined)?.rainThresholdMm, 2);
	const erM = s.effectiveRainFractionMonthly as number[] | null | undefined;
	const erMonthly = Array.isArray(erM) && erM.length === 12 && erM.every((x) => typeof x === 'number' && x >= 0 && x <= 1) ? erM : null;
	const er = num(s.effectiveRainFraction, 0.65);
	const storeMm = num(s.effectiveRainStoreMm, 25);
	const known = new Map(input.model.crops.map((c) => [c.id, c]));
	const areas = new Map<string, number>();
	for (const a of input.model.cropAreas) if (a.nodeId === n.id && known.has(a.cropId)) areas.set(a.cropId, (areas.get(a.cropId) ?? 0) + a.areaM2);
	const cropped = [...areas.values()].reduce((x, y) => x + y, 0);
	if (!(cropped > 0)) return null;
	const cf = (id: string, m: number) => num(known.get(id)!.cropFactor[m], 0);
	const d0 = epoch(out.startDate);
	const days = out.days;
	const rainFinal = out.series.find((x) => x.nodeId === null && x.key === 'rain_final')?.values;
	const ap = input.series.evap_apan_mm;
	const apOff = ap ? d0 - epoch(ap.startDate) : 0;
	// Demand factor (unit × crops part) from demandFactorFrom; nothing before the abstraction date.
	const okRow = (r: unknown): number[] | null => (Array.isArray(r) ? Array.from({ length: 12 }, (_, m) => (typeof r[m] === 'number' && Number.isFinite(r[m]) && r[m] >= 0 ? r[m] : 1)) : null);
	const uf = okRow(n.demandFactor);
	const pf = okRow((n.partDemandFactor as { crops?: unknown } | null | undefined)?.crops);
	const dff = typeof s.demandFactorFrom === 'string' ? Math.min(Math.max(epoch(s.demandFactorFrom) - d0, 0), days) : 0;
	const absFrom = typeof n.abstractionFrom === 'string' ? Math.min(Math.max(epoch(n.abstractionFrom) - d0, 0), days) : 0;
	const smax = (cropped * storeMm) / 1000;
	let W = 0;
	const r: Ref = { gross: [], used: [], soilMm: [], F: [], e: 1 };
	for (let t = 0; t < days; t++) {
		const m = wyIndex(d0 + t);
		const a = ap && t + apOff >= 0 ? ap.values[t + apOff] : undefined;
		const daily = typeof a === 'number' && Number.isFinite(a) && a >= 0;
		let gross = 0;
		for (const [id, area] of areas) gross += daily ? (area * cf(id, m) * a) / 1000 : (area * apan[m]! * cf(id, m)) / 1000 / dim[m]!;
		const rf = rainFinal ? rainFinal[t]! : 0;
		const rain = Number.isFinite(rf) && rf > thr ? rf : 0;
		const pe = cropped * ((erMonthly ? erMonthly[m]! : er) / 1000) * rain;
		const avail = W + pe;
		const need = Math.max(0, gross);
		const used = need - avail <= 1e-12 * need ? need : avail;
		W = Math.min(smax, Math.max(0, avail - used));
		let F = need - used;
		if (t >= dff) F *= (uf ? uf[m]! : 1) * (pf ? pf[m]! : 1);
		if (t < absFrom) F = 0;
		r.gross.push(gross);
		r.used.push(used);
		r.soilMm.push((W * 1000) / cropped);
		r.F.push(F);
	}
	// §2.3 item 6: the harmonic mean weighted by each crop's annual gross at the monthly A-pan.
	const eF = n.irrigationEfficiency > 0 && n.irrigationEfficiency <= 1 ? n.irrigationEfficiency : 1;
	const own = (id: string) => {
		const e = known.get(id)!.irrigationEfficiency;
		return typeof e === 'number' && e > 0 && e <= 1 ? e : null;
	};
	if ([...areas].some(([id, area]) => area > 0 && own(id) !== null)) {
		let w = 0, wOverE = 0, k = 0, kOverE = 0;
		for (const [id, area] of areas) {
			if (!(area > 0)) continue;
			const e = own(id) ?? eF;
			let byApan = 0, byFactor = 0;
			for (let m = 0; m < 12; m++) {
				const f = Math.max(0, cf(id, m));
				byApan += f * Math.max(0, apan[m]!);
				byFactor += f;
			}
			w += area * byApan;
			wOverE += (area * byApan) / e;
			k += area * byFactor;
			kOverE += (area * byFactor) / e;
		}
		r.e = w > 0 ? w / wOverE : k > 0 ? k / kOverE : eF;
	} else r.e = eF;
	return r;
}

function close(a: number, b: number, rel = 1e-8) {
	return Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
}

describe('irrigation demand on random networks (differential, §2.3)', () => {
	const SEEDS = Array.from({ length: 700 }, (_, i) => i + 1);
	it(`every farm’s demand chain matches the re-derivation (${SEEDS.length} seeds)`, () => {
		const failures: string[] = [];
		let farmsChecked = 0;
		for (const seed of SEEDS) {
			const input = withExtras(randomInput(seed, { maxNodes: 5, maxDays: 900, allocationModes: false }), seed);
			let out: ModelOutput;
			try {
				out = runModelWithoutChecks(input);
			} catch {
				continue; // inputs the run refuses (no PE, …) are other tests' business
			}
			for (const n of input.model.nodes) {
				if (n.kind !== 'farm') continue;
				const ref = reference(input, out, n);
				const s = (key: string) => out.series.find((x) => x.nodeId === n.id && x.key === key)?.values;
				if (!ref) continue;
				farmsChecked++;
				const D = s('demand')!;
				const objects = out.series.filter((x) => x.nodeId === n.id && x.key.startsWith('object_demand@'));
				const checks: [string, number[] | undefined, number[]][] = [
					['gross_demand', s('gross_demand'), ref.gross],
					['effective_rain', s('effective_rain'), ref.used],
					['soil_water', s('soil_water'), ref.soilMm],
					['crop_requirement', s('crop_requirement'), ref.F],
					['demand', D, ref.F.map((f, t) => f / ref.e + objects.reduce((x, o) => x + o.values[t]!, 0))]
				];
				for (const [key, got, want] of checks) {
					if (!got) {
						failures.push(`seed ${seed} ${n.id}: no ${key}`);
						continue;
					}
					const t = want.findIndex((w, i) => !close(got[i]!, w));
					if (t >= 0) failures.push(`seed ${seed} ${n.id} ${key} on ${iso(epoch(out.startDate) + t)}: engine ${got[t]}, doc ${want[t]}`);
				}
			}
		}
		expect(farmsChecked).toBeGreaterThan(100);
		expect(failures.slice(0, 15)).toEqual([]);
	});
});
