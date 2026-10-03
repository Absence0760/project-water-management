// End-to-end differential test of demand objects (docs/model.md §2.7f) on
// random valid networks: each enabled object's daily demand (sizing, demand
// factor per part, schedule with its own Easter computus, basic-needs
// floor, abstraction date), the split of the unit's supply over its supply
// levels, and the unit's return flow, against a re-derivation written from
// model.md alone. Drought restrictions (§2.7i, their own file), full
// allocations and river abstractions (§2.7j) are taken out, since each
// changes what the split is taken against. Synthetic data only.
import { describe, expect, it } from 'vitest';
import type { DemandObject, DemandScheduleWindow, ModelInput, ModelOutput, NetworkNode } from '../project';
import { runModelWithoutChecks } from '../run';
import { randomInput, Rng } from '../testing/fuzz';

const DAY = 86_400_000;
const epoch = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const iso = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
const wyIndex = (d: number) => (new Date(d * DAY).getUTCMonth() + 1 + 2) % 12;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Easter Sunday by Oudin's (1940) algorithm, independent of the engine's Meeus/Jones/Butcher. */
function easter(y: number): number {
	const c = Math.floor(y / 100);
	const n = y - 19 * Math.floor(y / 19);
	const k = Math.floor((c - 17) / 25);
	let i = c - Math.floor(c / 4) - Math.floor((c - k) / 3) + 19 * n + 15;
	i = i - 30 * Math.floor(i / 30);
	i = i - Math.floor(i / 28) * (1 - Math.floor(i / 28) * Math.floor(29 / (i + 1)) * Math.floor((21 - n) / 11));
	let j = y + Math.floor(y / 4) + i + 2 - c + Math.floor(c / 4);
	j = j - 7 * Math.floor(j / 7);
	const l = i - j;
	const m = 3 + Math.floor((l + 40) / 44);
	const d = l + 28 - 31 * Math.floor(m / 4);
	return epoch(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
}

function windowOk(w: DemandScheduleWindow): boolean {
	if (!(fin(w.factor) && w.factor >= 0 && w.factor <= 10)) return false;
	if (w.weekdays != null && (!w.weekdays.length || w.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7))) return false;
	if (w.span === 'easter') return Number.isInteger(w.easterFrom) && Number.isInteger(w.easterTo) && Math.abs(w.easterFrom!) <= 60 && Math.abs(w.easterTo!) <= 60 && w.easterTo! >= w.easterFrom!;
	if (w.span === 'range') return !!w.from && !!w.to && w.to >= w.from;
	return w.span === 'always' || w.span === 'yearly';
}

/** §2.7f's schedule table: the last window covering the day sets its factor, 1 where none does. */
function scheduleFactor(windows: DemandScheduleWindow[], day: number): number {
	const date = iso(day);
	const md = date.slice(5);
	const wd = ((new Date(day * DAY).getUTCDay() + 6) % 7) + 1;
	let f = 1;
	for (const w of windows) {
		if (w.weekdays && !w.weekdays.includes(wd)) continue;
		let hit = false;
		if (w.span === 'always') hit = true;
		else if (w.span === 'yearly') hit = w.from! <= w.to! ? md >= w.from! && md <= w.to! : md >= w.from! || md <= w.to!;
		else if (w.span === 'range') hit = date >= w.from! && date <= w.to!;
		else if (w.span === 'easter') {
			const e = easter(new Date(day * DAY).getUTCFullYear());
			hit = day >= e + w.easterFrom! && day <= e + w.easterTo!;
		}
		if (hit) f = w.factor;
	}
	return f;
}

function monthlyOf(o: DemandObject): number[] {
	if (o.sizing === 'perUnit') {
		if (!(fin(o.count) && o.count >= 0 && fin(o.litresPerUnitDay) && o.litresPerUnitDay >= 0)) return new Array(12).fill(0);
		const loss = fin(o.lossPct) && o.lossPct >= 0 && o.lossPct < 1 ? o.lossPct : 0;
		return Array.from({ length: 12 }, (_, m) => {
			const x = o.monthlyFactor?.[m];
			const k = fin(x) && x >= 0 ? x : 1;
			return ((o.count! * o.litresPerUnitDay!) / 1000 / (1 - loss)) * k;
		});
	}
	return Array.from({ length: 12 }, (_, m) => {
		const x = o.monthlyM3Day?.[m];
		return fin(x) && x >= 0 ? x : 0;
	});
}

function floorOf(o: DemandObject): number | null {
	if (o.category !== 'domestic' && o.category !== 'municipal') return null;
	const p = o.population != null ? o.population : o.sizing === 'perUnit' ? o.count : null;
	if (!(fin(p) && p > 0)) return null;
	const loss = o.sizing === 'perUnit' && fin(o.lossPct) && o.lossPct >= 0 && o.lossPct < 1 ? o.lossPct : 0;
	return (p * 25) / 1000 / (1 - loss);
}

const row = (r: unknown): number[] | null => (Array.isArray(r) ? Array.from({ length: 12 }, (_, m) => (fin(r[m]) && r[m] >= 0 ? r[m] : 1)) : null);

function prepared(seed: number): ModelInput {
	const input = randomInput(seed, { maxNodes: 5, maxDays: 700, allocationModes: false });
	const rng = new Rng(seed ^ 0x7f4a7c15);
	const settings: ModelInput['settings'] = { ...input.settings, droughtRestriction: null };
	const rain = input.series.rain_catchment_mm ?? input.series.rain_chirps_mm;
	if (rain && rng.bool(0.3)) settings.demandFactorFrom = iso(epoch(rain.startDate) + rng.int(-10, rain.values.length + 10));
	const parts = ['domestic', 'municipal', 'industrial', 'livestock', 'other'] as const;
	const nodes = input.model.nodes.map((n): NetworkNode => {
		const base: NetworkNode = { ...n, cropWaterSource: 'dam' };
		if (n.kind !== 'farm' || !rng.bool(0.5)) return base;
		const f = () => Array.from({ length: 12 }, () => (rng.bool(0.3) ? 1 : rng.pick([0, rng.float(0, 1), rng.float(1, 1.5)])));
		const p = rng.pick(parts);
		return { ...base, demandFactor: f(), ...(rng.bool(0.5) ? { partDemandFactor: { [p]: f() } } : {}) };
	});
	const demandObjects = (input.model.demandObjects ?? []).map((o) => ({ ...o, waterSource: null }));
	return { ...input, settings, model: { ...input.model, nodes, demandObjects } };
}

const close = (a: number, b: number, rel = 1e-8) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

describe('demand objects on random networks (differential, §2.7f)', () => {
	const SEEDS = Array.from({ length: 900 }, (_, i) => i + 1);
	it(`object demand, the supply split and the return flow match the re-derivation (${SEEDS.length} seeds)`, () => {
		const failures: string[] = [];
		let unitsChecked = 0;
		for (const seed of SEEDS) {
			const input = prepared(seed);
			const objs = (input.model.demandObjects ?? []).filter((o) => o.enabled !== false);
			if (!objs.length) continue;
			let out: ModelOutput;
			try {
				out = runModelWithoutChecks(input);
			} catch {
				continue;
			}
			const d0 = epoch(out.startDate);
			const days = out.days;
			const s = input.settings;
			const dff = typeof s.demandFactorFrom === 'string' ? Math.min(Math.max(epoch(s.demandFactorFrom) - d0, 0), days) : 0;
			for (const n of input.model.nodes) {
				if (n.kind !== 'farm') continue;
				const mine = objs.filter((o) => o.nodeId === n.id).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
				if (!mine.length) continue;
				if (mine.some((o) => (o.schedule ?? []).some((w) => !windowOk(w)))) continue;
				const ser = (key: string) => out.series.find((x) => x.nodeId === n.id && x.key === key)?.values;
				unitsChecked++;
				const absFrom = typeof n.abstractionFrom === 'string' ? Math.min(Math.max(epoch(n.abstractionFrom) - d0, 0), days) : 0;
				const uf = row(n.demandFactor);
				// Each object's demand (§2.7f): month × factor (unit × its category's part) × schedule; the floor under a cut.
				const want = mine.map((o) => {
					const monthly = monthlyOf(o);
					const pf = row((n.partDemandFactor as Record<string, unknown> | null | undefined)?.[o.category]);
					const fac = uf || pf ? Array.from({ length: 12 }, (_, m) => (uf ? uf[m]! : 1) * (pf ? pf[m]! : 1)) : null;
					const B = floorOf(o);
					const sched = (o.schedule ?? []).length ? o.schedule! : null;
					return Array.from({ length: days }, (_, t) => {
						if (t < absFrom) return 0;
						const m = wyIndex(d0 + t);
						const sv = sched ? scheduleFactor(sched, d0 + t) : 1;
						const f = fac && t >= dff ? fac[m]! : 1;
						let d = monthly[m]! * f * sv;
						if (B !== null && fac && t >= dff && fac[m]! < 1) d = Math.max(d, Math.min(B, monthly[m]! * sv));
						return d;
					});
				});
				mine.forEach((o, k) => {
					const got = ser(`object_demand@${o.id}`);
					if (!got) return void failures.push(`seed ${seed} ${o.id}: no object_demand`);
					const t = want[k]!.findIndex((w, i) => !close(got[i]!, w));
					if (t >= 0) failures.push(`seed ${seed} ${o.id} demand on ${iso(d0 + t)}: engine ${got[t]}, doc ${want[k]![t]}`);
				});
				// The split: levels first by rank → crops with shared → last by rank; pro rata within a level.
				const G = ser('supplied')!;
				const D = ser('demand')!;
				const T = ser('return_flow')!;
				const level = (o: DemandObject) => {
					const r = o.rank != null && Number.isInteger(o.rank) && o.rank >= 1 && o.rank <= 99 ? o.rank : 1;
					return o.priority === 'first' ? r : o.priority === 'last' ? 200 + r : 100;
				};
				const levels = [...new Set([100, ...mine.map(level)])].sort((a, b) => a - b);
				const e = ser('crop_requirement')!.map((f, t) => {
					const oSum = want.reduce((x, w) => x + w[t]!, 0);
					return { crop: D[t]! - oSum, f };
				});
				const beta = fin(n.lossReturnFraction) ? Math.min(Math.max(n.lossReturnFraction, 0), 1) : 0;
				for (let t = 0; t < days; t++) {
					const crop = e[t]!.crop;
					const effE = crop > 0 ? e[t]!.f / crop : 1;
					let rem = Math.max(G[t]!, 0);
					const gotK = new Array<number>(mine.length).fill(0);
					let cropGot = 0;
					const total = crop + want.reduce((x, w) => x + w[t]!, 0);
					if (G[t]! >= total * (1 - 1e-12)) {
						mine.forEach((_, k) => (gotK[k] = want[k]![t]!));
						cropGot = crop;
					} else
						for (const L of levels) {
							const members = mine.map((o, k) => [o, k] as const).filter(([o]) => level(o) === L);
							const w = (L === 100 ? crop : 0) + members.reduce((x, [, k]) => x + want[k]![t]!, 0);
							if (!(w > 0)) continue;
							const share = rem >= w ? 1 : rem / w;
							for (const [, k] of members) gotK[k] = want[k]![t]! * share;
							if (L === 100) cropGot = crop * share;
							rem = rem >= w ? rem - w : 0;
						}
					for (let k = 0; k < mine.length; k++) {
						const got = ser(`object_supplied@${mine[k]!.id}`)![t]!;
						if (!close(got, gotK[k]!, 1e-7)) {
							failures.push(`seed ${seed} ${mine[k]!.id} supplied on ${iso(d0 + t)}: engine ${got}, doc ${gotK[k]} (G ${G[t]}, D ${D[t]})`);
							break;
						}
					}
					// T = β(1 − e)·G_crops + Σ r_k·G_k (r_k = 0 when piped out).
					const r = (o: DemandObject) => (o.destination === 'external' ? 0 : fin(o.returnPct) ? Math.min(Math.max(o.returnPct, 0), 1) : 0);
					const Tw = beta * (1 - effE) * cropGot + mine.reduce((x, o, k) => x + r(o) * gotK[k]!, 0);
					if (!close(T[t]!, Tw, 1e-7)) {
						failures.push(`seed ${seed} ${n.id} return_flow on ${iso(d0 + t)}: engine ${T[t]}, doc ${Tw}`);
						break;
					}
				}
			}
		}
		expect(unitsChecked).toBeGreaterThan(50);
		expect(failures.slice(0, 15)).toEqual([]);
	});
});
