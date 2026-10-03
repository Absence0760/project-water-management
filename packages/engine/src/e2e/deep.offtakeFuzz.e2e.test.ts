// Deep end-to-end pass: the documented off-take sharing (docs/model.md §2.6a,
// engine 1.69.0's bands) replayed on the engine's own random networks
// (testing/fuzz.ts randomInput: GR4J runoff, dams with survey curves and
// releases, boreholes, river pumps, senior and junior users, drought
// restrictions, development, full-allocation and capped runs, gauges as ends
// and loops the run skips). The re-derivation reads only the run's published
// series (the flow before the off-takes, the senior requirement, the EWR, the
// destinations' demand and dam) and the rules as stored, never the engine's
// code. A destination with a river abstraction (§2.7j) is sized to its dam
// side, which no series publishes, so the sources feeding one by demand are
// left out. Synthetic values only.
import { isRiverOfftake } from '../network/offtake';
import { describe, expect, it } from 'vitest';
import { monthOfEpochDay, toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput, Transfer } from '../project';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';

const opt = (out: ModelOutput, id: string, key: string) => out.series.find((x) => x.nodeId === id && x.key === key)?.values ?? null;

function capOf(tr: Transfer, m: number): number {
	const wi = (m + 2) % 12;
	const rate = tr.monthlyRateM3s ? (tr.monthlyRateM3s[wi] ?? 0) : tr.months.includes(m) ? tr.maxRateM3s : 0;
	const c = Math.max(0, rate) * 86400;
	return tr.dailyCapM3 === null || tr.dailyCapM3 === undefined ? c : Math.min(c, tr.dailyCapM3);
}
const lossOf = (tr: Transfer) => {
	const l = tr.lossPct ?? 0;
	return Number.isFinite(l) && l >= 0 && l < 1 ? l : 0;
};
const handsOf = (tr: Transfer) => {
	const h = tr.handsOffM3Day ?? 0;
	return Number.isFinite(h) && h >= 0 ? h : 0;
};

/** §2.6a bands at one source on one day (see deep.offtake.e2e.test.ts refShare). */
function share(rules: { id: string; priority: number; cap: number; keep: number; limit: number }[], U0: number): Map<string, number> {
	const got = new Map(rules.map((r) => [r.id, 0]));
	let taken = 0;
	for (const p of [...new Set(rules.map((r) => r.priority))].sort((a, b) => a - b)) {
		const act = rules
			.filter((r) => r.priority === p && r.cap > 0)
			.map((r) => ({ r, left: Math.max(0, Math.min(Math.max(0, U0 - taken - r.keep), r.limit)) }))
			.filter((a) => a.left > 0);
		let top = U0 - taken;
		for (const f of [...new Set(act.map((a) => a.r.keep))].sort((a, b) => b - a)) {
			const elig = act.filter((a) => a.r.keep <= f);
			const want = elig.reduce((s, a) => s + a.left, 0);
			const band = Math.max(0, top - f);
			const scale = want > band ? band / want : 1;
			for (const a of elig) {
				const g = a.left * scale;
				got.set(a.r.id, got.get(a.r.id)! + g);
				a.left -= g;
				taken += g;
			}
			top = Math.min(top, f);
		}
	}
	return got;
}

function replay(input: ModelInput, out: ModelOutput): { checked: number; bad: string | null } {
	const nodes = new Map(input.model.nodes.map((n) => [n.id, n]));
	const priorityOf = (tr: Transfer) => (Number.isFinite(tr.priority) ? tr.priority : 0);
	// The rules the run planned and that can take water: those with a volume series.
	const rules = input.model.transfers.filter((tr) => tr.enabled && tr.source === 'river' && opt(out, tr.fromNodeId, `transfer_rule@${tr.id}`));
	const planned = input.model.transfers.filter((tr) => tr.enabled && tr.source === 'river');
	const onRiver = (id: string) => {
		const n = nodes.get(id)!;
		return n.cropWaterSource === 'river' || (input.model.demandObjects ?? []).some((o) => o.nodeId === id && o.enabled && o.waterSource === 'river');
	};
	const d0 = toEpochDay(out.startDate);
	let checked = 0;
	for (const src of new Set(rules.map((r) => r.fromNodeId))) {
		const mine = rules.filter((r) => r.fromNodeId === src);
		if (mine.some((r) => r.sizing === 'demand' && onRiver(r.toNodeId))) continue;
		const outflow = opt(out, src, 'outflow')!;
		const ret = opt(out, src, 'offtake_loss_return');
		const xout = opt(out, src, 'offtake_out')!;
		const Zs = opt(out, src, 'senior_requirement');
		const Z = opt(out, src, 'ewr_cumulative')!;
		for (let t = 1; t < out.days; t++) {
			const m = monthOfEpochDay(d0 + t);
			const U0 = outflow[t]! - (ret ? ret[t]! : 0) + xout[t]!;
			const zs = Zs ? Zs[t]! : 0;
			// A top-up destination that both sends and receives by dam rules today: the run's `transfer` column is
			// the net, so the receipts its room counts (engine ≥ 1.69.0, deep.regressions) can't be read back.
			const sendsToo = (id: string) => input.model.transfers.some((x) => x.enabled && x.fromNodeId === id && !isRiverOfftake(x));
			const dubious = mine.some((tr) => tr.sizing === 'demand' && tr.topUpDam && sendsToo(tr.toNodeId) && (opt(out, tr.toNodeId, 'transfer')?.[t] ?? 0) !== 0);
			if (dubious) continue;
			const spec = mine.map((tr) => {
				const cap = capOf(tr, m);
				let limit = cap;
				if (tr.sizing === 'demand') {
					// need × cap ÷ Σ cap of the demand-sized rules into the destination today (every source's).
					const into = planned.filter((x) => x.toNodeId === tr.toNodeId && x.sizing === 'demand' && nodes.get(x.fromNodeId)?.kind === 'farm');
					const capInto = into.reduce((s, x) => s + (opt(out, x.fromNodeId, `transfer_rule@${x.id}`) ? capOf(x, m) : 0), 0);
					const dst = nodes.get(tr.toNodeId)!;
					let need = (opt(out, dst.id, 'restricted_demand') ?? opt(out, dst.id, 'demand')!)[t]!;
					const capNow = opt(out, dst.id, 'dam_capacity')?.[t] ?? dst.damCapacityM3;
					if (tr.topUpDam && capNow > 0) {
						const q = opt(out, dst.id, 'dam_storage')![t - 1]!;
						const g = (k: string) => opt(out, dst.id, k)?.[t] ?? 0;
						// The step's own (clamped) losses, and today's dam-rule receipts (engine ≥ 1.69.0).
						need += Math.max(0, capNow - (q + g('rain_on_dam') + Math.max(0, g('transfer')) - g('dam_evaporation') - g('dam_seepage')));
					}
					limit = cap > 0 ? Math.min(cap, (need * cap) / capInto / (1 - lossOf(tr))) : 0;
				}
				return { id: tr.id, priority: priorityOf(tr), cap, keep: Math.max(zs, handsOf(tr), tr.handsOffEwr ? Z[t]! : 0), limit };
			});
			const ref = share(spec, U0);
			for (const tr of mine) {
				const v = opt(out, src, `transfer_rule@${tr.id}`)![t]!;
				const want = ref.get(tr.id)!;
				checked++;
				if (Math.abs(v - want) > 1e-7 * Math.max(1, U0)) return { checked, bad: `${src} day ${t} rule ${tr.id}: engine ${v}, documented ${want} (U0 ${U0}, keeps ${JSON.stringify(spec.map((x) => [x.id, x.priority, x.keep, x.limit]))})` };
			}
		}
	}
	return { checked, bad: null };
}

describe('deep: the off-take bands on the engine’s own random networks (§2.6a)', () => {
	it('every rule, every day after the first, is the documented share', () => {
		const bad: string[] = [];
		let runs = 0;
		let checked = 0;
		let positive = 0;
		for (let seed = 1; runs < 600 && seed < 20000; seed++) {
			const input = randomInput(seed, { maxNodes: 12, maxDays: 400 });
			if (!input.model.transfers.some((tr) => tr.enabled && tr.source === 'river')) continue;
			runs++;
			const out = runModel(input);
			const r = replay(input, out);
			checked += r.checked;
			for (const s of out.series) if (s.key.startsWith('transfer_rule@') && s.values.some((v) => v > 0)) positive++;
			if (r.bad) bad.push(`seed ${seed}: ${r.bad}`);
			if (bad.length > 4) break;
		}
		expect(bad).toEqual([]);
		expect(runs).toBe(600);
		expect(checked).toBeGreaterThan(10_000);
		expect(positive).toBeGreaterThan(50);
	});
});
