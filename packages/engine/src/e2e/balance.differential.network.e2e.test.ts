// End-to-end differential, the wider set: random chains of up to four units
// and other water users (senior and junior, river pumps, returns), with the
// senior users' requirement passed by the farms above them (§2.7c), dam
// releases (§2.7a item 3), individual boreholes with annual caps, modes and
// dam targets (§2.7d WP-3.9), the river pump (§2.7e), development (§2.7g)
// and the dam storage reset — run through the whole model (runModelWith,
// fixed natural flow) against a re-implementation written from
// docs/model.md. Invented values only.
import { describe, expect, it } from 'vitest';
import type { Borehole, ModelInput, ModelOutput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModelWith } from '../run';

const APAN = [180, 230, 270, 285, 245, 210, 140, 90, 60, 65, 90, 130];
const DIM = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30];
const DAY = 86_400_000;
const epoch = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;
const iso = (e: number) => new Date(e * DAY).toISOString().slice(0, 10);
const wyMonth = (e: number) => (new Date(e * DAY).getUTCMonth() + 3) % 12;
const calMonth = (e: number) => new Date(e * DAY).getUTCMonth() + 1;

interface Bh {
	id: string;
	cap: number;
	annual: number | null;
	mode: 'supplemental' | 'primary' | 'emergency';
	below: number;
	target: 'direct' | 'dam';
	d: number;
}

interface Unit {
	id: string;
	kind: 'farm' | 'user';
	areaKm2: number;
	cap: number;
	init: number;
	minPct: number;
	pu: number;
	pr: number;
	divert: number;
	e: number;
	beta: number;
	Af: number;
	b: number;
	seep: number;
	seepRet: number;
	cropM2: number;
	rule: 'damFirst' | 'riverFirst' | 'trigger' | 'runOfRiver';
	pump: number | null;
	trig: number;
	stop: number;
	release: 'none' | 'fixed' | 'passInflow';
	releaseM3: number[] | null;
	outlet: number | null;
	bhs: Bh[];
	lag: number;
	survey: string | null;
	rate: number;
	inService: string | null;
	absFrom: string | null;
	// users
	userDemand: number[];
	userReturn: number;
	senior: boolean;
}

function randomUnit(g: Rng, id: string, start: number, days: number): Unit {
	const user = g.bool(0.3);
	const hasDam = !user && g.bool(0.75);
	const cap = hasDam ? g.logFloat(500, 200_000) : 0;
	const rule = user ? 'damFirst' : hasDam ? g.pick(['damFirst', 'damFirst', 'riverFirst', 'trigger'] as const) : g.pick(['damFirst', 'riverFirst', 'runOfRiver'] as const);
	const trig = g.float(0.1, 0.6);
	const dated = (p: number) => (g.bool(p) ? iso(start + g.int(-200, days + 50)) : null);
	const rate = hasDam && g.bool(0.25) ? g.float(0.001, 0.2) : 0;
	const release = hasDam && g.bool(0.3) ? g.pick(['fixed', 'passInflow'] as const) : 'none';
	const nb = g.bool(0.4) ? g.int(1, 3) : 0;
	const bhs: Bh[] = Array.from({ length: nb }, (_, k) => ({
		id: `${id}-bh${k}`,
		cap: g.logFloat(5, 2000),
		annual: g.bool(0.5) ? g.logFloat(50, 100_000) : null,
		mode: hasDam ? g.pick(['supplemental', 'primary', 'emergency'] as const) : g.pick(['supplemental', 'primary'] as const),
		below: g.float(0.1, 0.7),
		target: hasDam && g.bool(0.4) ? 'dam' : 'direct',
		d: g.bool(0.6) ? g.float(0, 1) : 0
	}));
	return {
		id,
		kind: user ? 'user' : 'farm',
		areaKm2: user ? 0 : g.float(0.2, 5),
		cap,
		init: g.float(0, 1),
		minPct: g.bool(0.4) ? g.float(0, 0.4) : 0,
		pu: g.pick([0, 1, g.float(0, 1)]),
		pr: g.pick([0, 1, g.float(0, 1)]),
		divert: g.bool(0.3) ? g.float(0, 2000) : 0,
		e: g.float(0.6, 1),
		beta: g.float(0, 1),
		Af: hasDam ? g.float(0.05, 1.5) * cap : 0,
		b: g.float(0.5, 1),
		seep: g.bool(0.4) ? g.float(0, 0.01) : 0,
		seepRet: g.bool(0.5) ? 1 : g.float(0, 1),
		cropM2: user ? 0 : g.logFloat(1_000, 400_000),
		rule,
		pump: user ? (g.bool(0.5) ? g.logFloat(10, 20_000) : null) : rule === 'damFirst' ? null : g.bool(0.2) ? 0 : g.logFloat(10, 20_000),
		trig,
		stop: trig + g.float(0, 0.3),
		release,
		releaseM3: release === 'fixed' || (release === 'passInflow' && g.bool(0.5)) ? Array.from({ length: 12 }, () => g.logFloat(1, 3000)) : null,
		outlet: release !== 'none' && g.bool(0.5) ? g.logFloat(10, 5000) : null,
		bhs,
		lag: g.bool(0.5) ? g.float(0, 10) : 0,
		survey: rate > 0 ? iso(start + g.int(-1000, days + 400)) : null,
		rate,
		inService: hasDam ? dated(0.25) : null,
		absFrom: dated(0.25),
		userDemand: Array.from({ length: 12 }, () => (g.bool(0.2) ? 0 : g.logFloat(10, 20_000))),
		userReturn: g.bool(0.5) ? 0 : g.float(0, 1),
		senior: g.bool(0.6)
	};
}

function toNode(u: Unit, down: string): NetworkNode {
	const base: NetworkNode = {
		id: u.id,
		name: u.id,
		kind: u.kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: u.areaKm2,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: u.pu,
		pctRunoffToDam: u.pr,
		damCapacityM3: u.cap,
		damInitialPct: u.init,
		damMinPct: u.minPct,
		divertCapacityM3Day: u.divert,
		irrigationEfficiency: u.e,
		lossReturnFraction: u.beta,
		damAreaFullM2: u.Af,
		damAreaExponent: u.b,
		damSeepagePerDay: u.seep,
		damSeepageReturnPct: u.seepRet,
		pumpCapacityM3Day: u.pump,
		streamDepletionLagDays: u.lag,
		abstractionFrom: u.absFrom
	};
	if (u.kind === 'user') return { ...base, pctUpstreamToDam: 0, pctRunoffToDam: 0, divertCapacityM3Day: 0, damCapacityM3: 0, userDemandM3Day: u.userDemand, userReturnPct: u.userReturn, userPriority: u.senior ? 'senior' : 'junior' };
	return {
		...base,
		supplyRule: u.rule,
		supplyTriggerPct: u.trig,
		supplyStopPct: u.stop,
		damReleaseRule: u.release,
		damReleaseM3Day: u.releaseM3,
		damOutletCapacityM3Day: u.outlet,
		damSurveyDate: u.survey,
		damSedimentPctPerYear: u.rate || null,
		damInServiceFrom: u.inService
	};
}

type Cols = Record<string, number[]>;

/** The model.md day, re-implemented for a chain units[0] → units[1] → … → outlet. */
function reference(units: Unit[], start: number, days: number, natural: number[], rain: number[], lake: number, ewr: number[], reset: { day: number; id: string; v: number } | null) {
	const farms = units.filter((u) => u.kind === 'farm');
	const totalArea = farms.reduce((a, f) => a + f.areaKm2, 0);
	const share = (u: Unit) => (u.kind === 'farm' && totalArea > 0 ? u.areaKm2 / totalArea : 0);
	const out = new Map<string, Cols>();
	const kOf = (f: Unit, day: number) => {
		if (!(f.cap > 0)) return 0;
		if (f.inService && day < epoch(f.inService)) return 0;
		if (f.rate > 0 && f.survey) return Math.max(0, 1 - (f.rate * (day - epoch(f.survey))) / 365.25);
		return 1;
	};
	const st = units.map((u) => ({ q: u.init * u.cap * kOf(u, start), onRiver: false, store: 0, owed: 0, used: u.bhs.map(() => 0) }));
	for (const u of units) out.set(u.id, { supplied: [], dam_storage: [], spill: [], outflow: [], groundwater_used: [], groundwater_to_dam: [], baseflow_depletion: [], river_abstraction: [], dam_release: [], senior_requirement: [] });
	for (let t = 0; t < days; t++) {
		const day = start + t;
		const m = wyMonth(day);
		const depth = (lake * APAN[m]!) / DIM[m]!;
		if (t === 0 || calMonth(day) === 10 && calMonth(day - 1) !== 10) for (const s of st) s.used.fill(0);
		const userD = (u: Unit) => (!u.absFrom || day >= epoch(u.absFrom) ? u.userDemand[m]! : 0);
		const claim = (u: Unit) => (u.pump === null ? userD(u) : Math.min(userD(u), u.pump));
		let Hup = 0;
		let ZsUp = 0;
		let Zup = 0;
		units.forEach((u, p) => {
			const s = st[p]!;
			const o = out.get(u.id)!;
			const H = Hup;
			const abstracts = !u.absFrom || day >= epoch(u.absFrom);
			// Boreholes and the stream-depletion lag (§2.7d): units in order, combined first (none here), then by id.
			const room = (k: number) => Math.max(0, Math.min(u.bhs[k]!.cap, (u.bhs[k]!.annual ?? Infinity) - s.used[k]!));
			let dep = 0;
			const take = (k: number, v: number) => {
				s.used[k]! += v;
				dep += u.bhs[k]!.d * v;
			};
			const deplete = (flow: number) => {
				if (!u.bhs.length) return 0;
				const alpha = u.lag > 0 ? 1 - Math.exp(-1 / u.lag) : 1;
				s.store += dep;
				const due = alpha * s.store;
				s.store -= due;
				const owed = s.owed + due;
				const taken = Math.min(owed, Math.max(flow, 0));
				s.owed = owed - taken;
				return taken;
			};
			if (u.kind === 'user') {
				const D = userD(u);
				const avail = u.senior ? H : Math.max(0, H - ZsUp);
				const reach = u.pump === null ? avail : Math.min(avail, u.pump);
				let g = 0;
				u.bhs.forEach((b, k) => {
					if (b.mode !== 'primary') return;
					const v = Math.max(0, Math.min(room(k), D - g));
					take(k, v);
					g += v;
				});
				const Gs = Math.min(reach, D - g);
				u.bhs.forEach((b, k) => {
					if (b.mode !== 'supplemental') return;
					const v = Math.max(0, Math.min(room(k), D - Gs - g));
					take(k, v);
					g += v;
				});
				const G = Gs + g;
				const T = u.userReturn * G;
				const Ur = H - Gs + T;
				const U = Ur - deplete(Ur);
				const claimed = u.senior && units.slice(0, p).some((x) => share(x) > 0);
				const Zs = claimed ? Math.max(0, ZsUp - claim(u)) : ZsUp;
				o.supplied!.push(G);
				o.outflow!.push(U);
				o.groundwater_used!.push(g);
				o.senior_requirement!.push(Zs);
				for (const k of ['dam_storage', 'spill', 'groundwater_to_dam', 'baseflow_depletion', 'river_abstraction', 'dam_release']) o[k]!.push(NaN);
				Hup = U;
				ZsUp = Zs;
				return;
			}
			const sh = share(u);
			const I = natural[t]! * sh;
			const ror = u.rule === 'runOfRiver';
			let K = ror ? 0 : H * u.pu;
			let L = H - K;
			let M = ror ? 0 : I * u.pr;
			let N = I - M;
			let O = ror || u.pu >= 1 ? 0 : Math.min(u.divert, L + N);
			// Senior users below (§2.7c): this farm's claim, by flow share among the farms above each senior user.
			let Y_s = 0;
			units.forEach((x, q) => {
				if (q <= p || x.kind !== 'user' || !x.senior) return;
				const above = units.slice(0, q).reduce((a, y) => a + share(y), 0);
				if (above > 0) Y_s += (claim(x) * sh) / above;
			});
			const Zs = ZsUp + Y_s;
			if (Zs > 0) {
				let short = Math.min(Zs, H + I) - (L + N - O);
				if (short > 0) {
					const dO = Math.min(short, O);
					O -= dO;
					short -= dO;
					const into = K + M;
					if (short > 0 && into > 0) {
						const cut = Math.min(short, into);
						if (cut >= into) {
							K = 0;
							M = 0;
						} else {
							const dK = (cut * K) / into;
							K -= dK;
							M -= cut - dK;
						}
						L = H - K;
						N = I - M;
					}
				}
			}
			const Z = ewr[m]! * sh + Zup;
			const k = kOf(u, day);
			const cap = u.cap * k;
			let qPrev = s.q;
			if (reset && reset.day === t && reset.id === u.id && u.cap > 0) qPrev = Math.min(Math.max(reset.v, 0), cap);
			const dead = u.minPct * cap;
			const qLevel = k > 0 ? qPrev / k : 0;
			let A = 0;
			let E0 = 0;
			let Sp0 = 0;
			let Pd = 0;
			if (cap > 0 && qPrev > 0) {
				A = u.Af * Math.pow(Math.min(qPrev / cap, 1), u.b);
				Pd = (rain[t]! * A) / 1000;
				E0 = (depth * A) / 1000;
				Sp0 = u.seep * qPrev;
			}
			const there = Math.max(qPrev + Pd, 0);
			const E = Math.min(E0, there);
			const Sp = Math.min(Sp0, there - E);
			let avail = qPrev + Pd - E - Sp + M + O + K;
			const S = L + N - O;
			// Release before irrigation (§2.7a item 3); none on a day the dam has no capacity (§2.7g: no dam that day).
			let X = 0;
			if (cap > 0 && u.release === 'passInflow') {
				const target = u.releaseM3 ? u.releaseM3[m]! : Z;
				X = Math.max(0, Math.min(K + M + O, target - S, u.outlet ?? Infinity, Math.max(avail, 0)));
			} else if (cap > 0 && u.release === 'fixed' && u.releaseM3) X = Math.max(0, Math.min(u.releaseM3[m]!, u.outlet ?? Infinity, Math.max(avail, 0) - dead));
			avail -= X;
			const D = abstracts ? (u.cropM2 * APAN[m]!) / 1000 / DIM[m]! / u.e : 0;
			// The river pump (§2.7e); trigger and run of river resolved as the doc's "invalid combinations" say.
			const rule = u.rule === 'trigger' && !(u.cap > 0) ? 'riverFirst' : u.rule === 'runOfRiver' && u.cap > 0 ? 'riverFirst' : u.rule;
			let on = false;
			if (rule === 'riverFirst' || rule === 'runOfRiver') on = true;
			else if (rule === 'trigger') on = s.onRiver ? qLevel < u.stop * u.cap : qLevel < u.trig * u.cap;
			s.onRiver = on;
			const target = cap > 0 && u.release === 'passInflow' ? (u.releaseM3 ? u.releaseM3[m]! : Z) : 0;
			const pump = u.pump ?? Infinity;
			const riverRoom = on ? Math.max(0, Math.min(pump, S - Math.max(Zs, target))) : 0;
			// Supply order (§2.7d WP-3.9).
			const dam = u.cap > 0;
			const mode = (b: Bh) => (b.mode === 'emergency' && !dam ? 'supplemental' : b.mode);
			// A dam-target borehole pumps direct on a day the dam has no capacity (§2.7d, §2.7g).
			const toDam = (b: Bh) => b.target === 'dam' && cap > 0;
			let g = 0;
			u.bhs.forEach((b, kk) => {
				if (toDam(b) || mode(b) !== 'primary') return;
				const v = Math.max(0, Math.min(room(kk), D - g));
				take(kk, v);
				g += v;
			});
			const rem = riverRoom > 0 && rule !== 'runOfRiver' ? D - g - Math.min(riverRoom, D - g) : D - g;
			const drawn = rem > D * 1e-12;
			let gd = 0;
			let topped = false;
			u.bhs.forEach((b, kk) => {
				if (!toDam(b)) return;
				const head = cap - (avail + gd);
				const md = mode(b);
				const want = md === 'primary' ? (drawn ? head : 0) : md === 'emergency' ? (drawn && qLevel < b.below * u.cap ? head : 0) : rem - (avail + gd - dead);
				const v = Math.max(0, Math.min(room(kk), want, head));
				take(kk, v);
				gd += v;
				if (md === 'supplemental' && v > 0 && v === want) topped = true;
			});
			const damAvail = topped ? Math.max(avail + gd - dead, rem, 0) : Math.max(avail + gd - dead, 0);
			let Gs: number;
			let Gr = 0;
			if (riverRoom > 0) {
				if (rule === 'runOfRiver') {
					Gs = Math.min(damAvail, D - g);
					Gr = Math.max(0, Math.min(riverRoom, D - g - Gs));
				} else {
					Gr = Math.max(0, Math.min(riverRoom, D - g));
					Gs = Math.min(damAvail, D - g - Gr);
				}
			} else Gs = Math.min(damAvail, D - g);
			for (const pass of ['supplemental', 'emergency'] as const) {
				u.bhs.forEach((b, kk) => {
					if (toDam(b) || mode(b) !== pass || (pass === 'emergency' && !(qLevel < b.below * u.cap))) return;
					const v = Math.max(0, Math.min(room(kk), D - Gs - g - Gr));
					take(kk, v);
					g += v;
				});
			}
			const G = Math.min(Gs + g + Gr, D);
			const P = avail + gd - Gs;
			const Q = Math.min(P, cap);
			const R = Math.max(P - cap, 0);
			const T = u.beta * (1 - u.e) * G;
			const Ur = R + (S - Gr) + T + Sp * u.seepRet + X;
			const U = Ur - deplete(Ur);
			s.q = Q;
			o.supplied!.push(G);
			o.dam_storage!.push(Q);
			o.spill!.push(R);
			o.outflow!.push(U);
			o.groundwater_used!.push(g);
			o.groundwater_to_dam!.push(gd);
			o.baseflow_depletion!.push(deplete.length ? 0 : 0);
			o.river_abstraction!.push(Gr);
			o.dam_release!.push(X);
			o.senior_requirement!.push(Zs);
			Hup = U;
			ZsUp = Zs;
			Zup = Z;
		});
	}
	return out;
}

const N = Number(process.env.BAL_N ?? 300);

describe(`random chains of units and other water users against a re-implementation of model.md (${N} seeds)`, () => {
	it('supply, storage, spill, outflow, groundwater, the pump, releases and the senior requirement match day by day', () => {
		const failures: string[] = [];
		let compared = 0;
		for (let seed = 1; seed <= N; seed++) {
			const g = new Rng(seed * 104_729 + 3);
			const days = g.int(30, 420);
			const start = epoch('2018-01-01') + g.int(0, 1500);
			const n = g.int(2, 4);
			const units = Array.from({ length: n }, (_, k) => randomUnit(g, `N${k}`, start, days));
			if (!units.some((u) => u.kind === 'farm')) units[0] = { ...randomUnit(new Rng(seed), 'N0', start, days), kind: 'farm', areaKm2: 1, cropM2: 5000, userDemand: [] };
			const natural = Array.from({ length: days }, () => (g.bool(0.3) ? 0 : g.logFloat(1, 50_000)));
			const rain = Array.from({ length: days }, () => (g.bool(0.7) ? 0 : g.float(0, 60)));
			const lake = g.pick([0, 0.75, g.float(0.3, 1.2)]);
			const ewr = Array.from({ length: 12 }, () => (g.bool(0.5) ? 0 : g.logFloat(1, 20_000)));
			const damIds = units.filter((u) => u.cap > 0).map((u) => u.id);
			const reset = damIds.length && g.bool(0.3) ? { day: g.int(0, days - 1), id: g.pick(damIds), v: g.float(-1000, 250_000) } : null;
			const boreholes: Borehole[] = units.flatMap((u) =>
				u.bhs.map((b) => ({ id: b.id, nodeId: u.id, name: b.id, capacityM3Day: b.cap, annualCapM3: b.annual, mode: b.mode, emergencyBelowPct: b.below, target: b.target, depletionFactor: b.d }))
			);
			const input: ModelInput = {
				settings: {
					apanMm: APAN as never,
					effectiveRainFraction: 0,
					lakeEvapFactor: lake,
					ewrPragmaticM3PerDay: ewr as never,
					...(reset ? { damStorageReset: { date: iso(start + reset.day), storageM3: { [reset.id]: reset.v } } } : {})
				},
				model: {
					nodes: [
						{ id: 'OUT', name: 'OUT', kind: 'gauge', downstreamNodeId: null, sortOrder: 0, areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 1, pctRunoffToDam: 1, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 1, lossReturnFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 },
						...units.map((u, k) => toNode(u, k + 1 < n ? units[k + 1]!.id : 'OUT'))
					],
					crops: [{ id: 'c', name: 'Crop', cropFactor: new Array(12).fill(1) }],
					cropAreas: units.filter((u) => u.kind === 'farm').map((u) => ({ nodeId: u.id, cropId: 'c', areaM2: u.cropM2 })),
					transfers: [],
					boreholes
				},
				series: { rain_catchment_mm: { startDate: iso(start), values: rain } }
			};
			let o: ModelOutput;
			try {
				o = runModelWith(input, () => ({ naturalFlowM3Day: natural }));
			} catch (err) {
				failures.push(`seed ${seed}: threw ${String(err)}`);
				continue;
			}
			const want = reference(units, start, days, natural, rain, lake, ewr, reset);
			const scale = Math.max(1, ...natural, ...units.map((u) => u.cap));
			for (const u of units) {
				for (const [key, exp] of Object.entries(want.get(u.id)!)) {
					if (key === 'baseflow_depletion') continue;
					const got = o.series.find((s) => s.nodeId === u.id && s.key === key)?.values;
					if (!got) {
						if (exp.some((v) => Number.isFinite(v) && Math.abs(v) > 1e-9)) failures.push(`seed ${seed} ${u.id}/${key}: missing but expected non-zero`);
						continue;
					}
					compared++;
					for (let t = 0; t < days; t++) {
						if (!Number.isFinite(exp[t]!)) continue;
						if (!(Math.abs(got[t]! - exp[t]!) <= 1e-7 * scale)) {
							failures.push(`seed ${seed} ${u.id}/${key} day ${t} (${iso(start + t)}): engine ${got[t]} hand ${exp[t]} — ${JSON.stringify({ units, reset, lake })}`);
							break;
						}
					}
				}
			}
			if (failures.length > 6) break;
		}
		expect(failures.slice(0, 6)).toEqual([]);
		expect(compared).toBeGreaterThan(N);
	});
});
