// End-to-end differential: random two-unit chains run through the whole model
// (runModelWith, fixed natural flow) against a from-scratch re-implementation
// of the farm day written from docs/model.md §2.7, §2.7a, §2.7d, §2.7e and
// §2.7g — not from the engine's code. Every input to the day (yesterday's
// storage, the day's capacity, the month's evaporation depth, the river pump
// switch, the depletion lag) is derived here independently, so a wrong input
// fed to a correct formula shows, which the engine's self-checks (they replay
// the published columns) can't see. Invented values only.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModelWith } from '../run';

const APAN = [180, 230, 270, 285, 245, 210, 140, 90, 60, 65, 90, 130];
const DIM = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30];
const DAY = 86_400_000;
const epoch = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;
const iso = (e: number) => new Date(e * DAY).toISOString().slice(0, 10);
/** Water-year month index (Oct = 0) of epoch day e. */
const wyMonth = (e: number) => (new Date(e * DAY).getUTCMonth() + 3) % 12;

interface Farm {
	id: string;
	down: string;
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
	pump: number;
	trig: number;
	stop: number;
	bhCap: number;
	bhRule: 'supplemental' | 'primary' | 'drought';
	bhTrig: number;
	d: number;
	lag: number;
	survey: string | null;
	rate: number;
	inService: string | null;
	absFrom: string | null;
}

function randomFarm(g: Rng, id: string, down: string, start: number, days: number): Farm {
	const hasDam = g.bool(0.75);
	const cap = hasDam ? g.logFloat(500, 200_000) : 0;
	const rule = hasDam ? g.pick(['damFirst', 'damFirst', 'riverFirst', 'trigger'] as const) : g.pick(['damFirst', 'riverFirst', 'runOfRiver'] as const);
	const trig = g.float(0.1, 0.6);
	const dated = (p: number) => (g.bool(p) ? iso(start + g.int(-200, days + 50)) : null);
	const rate = hasDam && g.bool(0.3) ? g.float(0.001, 0.2) : 0;
	return {
		id,
		down,
		areaKm2: g.float(0.2, 5),
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
		cropM2: g.logFloat(1_000, 400_000),
		rule,
		pump: g.bool(0.2) ? 0 : g.logFloat(10, 20_000),
		trig,
		stop: trig + g.float(0, 0.3),
		bhCap: g.bool(0.4) ? g.logFloat(5, 3000) : 0,
		bhRule: hasDam ? g.pick(['supplemental', 'primary', 'drought'] as const) : g.pick(['supplemental', 'primary'] as const),
		bhTrig: g.float(0.1, 0.6),
		d: g.bool(0.6) ? g.float(0, 1) : 0,
		lag: g.bool(0.5) ? g.float(0, 10) : 0,
		survey: rate > 0 ? iso(start + g.int(-1000, days + 400)) : null,
		rate,
		inService: hasDam ? dated(0.25) : null,
		absFrom: dated(0.25)
	};
}

function toNode(f: Farm): NetworkNode {
	return {
		id: f.id,
		name: f.id,
		kind: 'farm',
		downstreamNodeId: f.down,
		sortOrder: 0,
		areaKm2: f.areaKm2,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: f.pu,
		pctRunoffToDam: f.pr,
		damCapacityM3: f.cap,
		damInitialPct: f.init,
		damMinPct: f.minPct,
		divertCapacityM3Day: f.divert,
		irrigationEfficiency: f.e,
		returnFlowFraction: f.beta * (1 - f.e),
		damAreaFullM2: f.Af,
		damAreaExponent: f.b,
		damSeepagePerDay: f.seep,
		damSeepageReturnPct: f.seepRet,
		supplyRule: f.rule,
		pumpCapacityM3Day: f.rule === 'damFirst' ? null : f.pump,
		supplyTriggerPct: f.trig,
		supplyStopPct: f.stop,
		boreholeCapacityM3Day: f.bhCap || null,
		boreholeRule: f.bhRule,
		boreholeTriggerPct: f.bhTrig,
		streamDepletionFrac: f.d,
		streamDepletionLagDays: f.lag,
		damSurveyDate: f.survey,
		damSedimentPctPerYear: f.rate || null,
		damInServiceFrom: f.inService,
		abstractionFrom: f.absFrom
	};
}

/** The model.md day, re-implemented. Returns per farm the columns compared. */
function reference(farms: Farm[], start: number, days: number, natural: number[], rain: number[], lake: number) {
	const totalArea = farms.reduce((a, f) => a + f.areaKm2, 0);
	const out = new Map<string, Record<string, number[]>>();
	const state = new Map<string, { q: number; onRiver: boolean; store: number; owed: number }>();
	const kOf = (f: Farm, day: number) => {
		if (!(f.cap > 0)) return 0;
		if (f.inService && day < epoch(f.inService)) return 0;
		if (f.rate > 0 && f.survey) return Math.max(0, 1 - (f.rate * (day - epoch(f.survey))) / 365.25);
		return 1;
	};
	for (const f of farms) {
		out.set(f.id, { supplied: [], dam_storage: [], spill: [], outflow: [], groundwater_used: [], baseflow_depletion: [], river_abstraction: [], dam_evaporation: [], demand: [] });
		state.set(f.id, { q: f.init * f.cap * kOf(f, start), onRiver: false, store: 0, owed: 0 });
	}
	for (let t = 0; t < days; t++) {
		const day = start + t;
		const m = wyMonth(day);
		const depth = (lake * APAN[m]!) / DIM[m]!;
		const Uof = new Map<string, number>();
		for (const f of farms) {
			const s = state.get(f.id)!;
			const o = out.get(f.id)!;
			const H = farms.filter((x) => x.down === f.id).reduce((a, x) => a + Uof.get(x.id)!, 0);
			const I = natural[t]! * (f.areaKm2 / totalArea);
			const ror = f.rule === 'runOfRiver';
			const K = ror ? 0 : H * f.pu;
			const L = H - K;
			const M = ror ? 0 : I * f.pr;
			const N = I - M;
			const O = ror || f.pu >= 1 ? 0 : Math.min(f.divert, L + N);
			const k = kOf(f, day);
			const cap = f.cap * k;
			const qPrev = s.q;
			const dead = f.minPct * cap;
			const qLevel = k > 0 ? qPrev / k : 0;
			let A = 0;
			let E0 = 0;
			let Sp0 = 0;
			let Pd = 0;
			if (cap > 0 && qPrev > 0) {
				A = f.Af * Math.pow(Math.min(qPrev / cap, 1), f.b);
				Pd = (rain[t]! * A) / 1000;
				E0 = (depth * A) / 1000;
				Sp0 = f.seep * qPrev;
			}
			const there = Math.max(qPrev + Pd, 0);
			const E = Math.min(E0, there);
			const Sp = Math.min(Sp0, there - E);
			const avail = qPrev + Pd - E - Sp + M + O + K;
			const S = L + N - O;
			const abstracts = !f.absFrom || day >= epoch(f.absFrom);
			const F = abstracts ? (f.cropM2 * APAN[m]!) / 1000 / DIM[m]! : 0;
			const D = F / f.e;
			// The river pump (§2.7e).
			let on = false;
			if (f.rule === 'riverFirst' || f.rule === 'runOfRiver') on = true;
			else if (f.rule === 'trigger') on = s.onRiver ? qLevel < f.stop * f.cap : qLevel < f.trig * f.cap;
			s.onRiver = on;
			const room = on ? Math.max(0, Math.min(f.pump, S)) : 0;
			// Boreholes (§2.7d), the node's combined capacity.
			const gwOn = f.bhCap > 0 && (f.bhRule !== 'drought' || qLevel < f.bhTrig * f.cap);
			const GWp = gwOn && f.bhRule === 'primary' ? Math.min(f.bhCap, D) : 0;
			const damAvail = Math.max(avail - dead, 0);
			let Gs: number;
			let Gr = 0;
			if (ror) {
				Gs = Math.min(damAvail, D - GWp);
				Gr = Math.max(0, Math.min(room, D - GWp - Gs));
			} else {
				Gr = Math.max(0, Math.min(room, D - GWp));
				Gs = Math.min(damAvail, D - GWp - Gr);
			}
			const GWs = gwOn && f.bhRule !== 'primary' ? Math.max(0, Math.min(f.bhCap, D - Gs - Gr)) : 0;
			const GW = GWp + GWs;
			const G = Gs + Gr + GW;
			const P = avail - Gs;
			const Q = Math.min(P, cap);
			const R = Math.max(P - cap, 0);
			const T = f.beta * (1 - f.e) * G;
			const Uriver = R + S - Gr + T + Sp * f.seepRet;
			// Stream depletion: a linear reservoir, α = 1 − e^(−1/k) (1 for k = 0), owed while there's no flow.
			const alpha = f.lag > 0 ? 1 - Math.exp(-1 / f.lag) : 1;
			s.store += f.d * GW;
			const due = alpha * s.store;
			s.store -= due;
			const owed = s.owed + due;
			const Dep = f.bhCap > 0 ? Math.min(owed, Math.max(Uriver, 0)) : 0;
			s.owed = owed - Dep;
			const U = Uriver - Dep;
			s.q = Q;
			Uof.set(f.id, U);
			o.supplied!.push(G);
			o.dam_storage!.push(Q);
			o.spill!.push(R);
			o.outflow!.push(U);
			o.groundwater_used!.push(GW);
			o.baseflow_depletion!.push(Dep);
			o.river_abstraction!.push(Gr);
			o.dam_evaporation!.push(E);
			o.demand!.push(D);
		}
	}
	return out;
}

const N = Number(process.env.BAL_N ?? 300);

describe(`random two-unit chains against a re-implementation of model.md (${N} seeds)`, () => {
	it('every published column matches the hand model, day by day', () => {
		const failures: string[] = [];
		for (let seed = 1; seed <= N; seed++) {
			const g = new Rng(seed * 7919);
			const days = g.int(30, 420);
			const start = epoch('2018-01-01') + g.int(0, 1500);
			// Upstream first: B drains into A, A into the outlet gauge.
			const farms = [randomFarm(g, 'B', 'A', start, days), randomFarm(g, 'A', 'OUT', start, days)];
			const natural = Array.from({ length: days }, () => (g.bool(0.3) ? 0 : g.logFloat(1, 50_000)));
			const rain = Array.from({ length: days }, () => (g.bool(0.7) ? 0 : g.float(0, 60)));
			const lake = g.pick([0, 0.75, g.float(0.3, 1.2)]);
			const input: ModelInput = {
				settings: { apanMm: APAN as never, effectiveRainFraction: 0, lakeEvapFactor: lake, ewrPragmaticM3PerDay: new Array(12).fill(0) as never },
				model: {
					nodes: [
						{ id: 'OUT', name: 'OUT', kind: 'gauge', downstreamNodeId: null, sortOrder: 0, areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 1, pctRunoffToDam: 1, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 1, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 },
						...farms.map(toNode)
					],
					crops: [{ id: 'c', name: 'Crop', cropFactor: new Array(12).fill(1) }],
					cropAreas: farms.map((f) => ({ nodeId: f.id, cropId: 'c', areaM2: f.cropM2 })),
					transfers: []
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
			const want = reference(farms, start, days, natural, rain, lake);
			for (const f of farms) {
				const w = want.get(f.id)!;
				for (const [key, exp] of Object.entries(w)) {
					const got = o.series.find((s) => s.nodeId === f.id && s.key === key)?.values;
					if (!got) {
						// Optional columns: absent means 0 every day.
						if (exp.some((v) => Math.abs(v) > 1e-9)) failures.push(`seed ${seed} ${f.id}/${key}: missing but expected non-zero`);
						continue;
					}
					for (let t = 0; t < days; t++) {
						const scale = Math.max(1, Math.abs(exp[t]!), f.cap, ...natural.slice(0, t + 1).slice(-1));
						if (!(Math.abs(got[t]! - exp[t]!) <= 1e-7 * scale)) {
							failures.push(`seed ${seed} ${f.id}/${key} day ${t} (${iso(start + t)}): engine ${got[t]} hand ${exp[t]} — ${JSON.stringify(f)}`);
							break;
						}
					}
				}
			}
			if (failures.length > 10) break;
		}
		expect(failures.slice(0, 10)).toEqual([]);
	});
});
