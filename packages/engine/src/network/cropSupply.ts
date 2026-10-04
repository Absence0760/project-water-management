// The crops' water sources by share (engine ≥ 1.73.0, issue #408, docs/model.md
// §2.7k): a unit's crop demand is asked in fixed shares of three sources, the
// unit's own dam side, the river at the unit (the crops' river abstraction,
// ./riverSource.ts) and the dam of another unit, which supplies the same day
// from its storage after its own unit's dam side. Each source is asked for its
// share only; what one can't give is a deficit, never passed to another. Pure;
// the plan (../run.ts), the simulation (./simulate.ts) and the self-checks
// (../verify/checks.ts) read a unit's table through these, so a stored table
// means the same thing to each.
import { cmpStr } from '../order';
import type { NetworkNode } from '../project';
import { reaches } from './offtake';

/** A unit's crop demand split between its sources: three shares ≥ 0 that sum to 1. */
export interface PlanCropShare {
	dam: number;
	river: number;
	remote: number;
}

/** The other unit's dam a unit's crops draw a share on, as the simulation runs it. */
export interface PlanRemote {
	/** The supplying unit's node index (a farm, simulated before this one). */
	from: number;
	/** The share of the crop demand asked of it, 0 < share ≤ 1. */
	share: number;
	/** The pipe or canal's capacity, m³/day; Infinity = no limit. */
	capM3Day: number;
	/** Its place among the remote supplies, in the receiving units' id order: a dam sums its receivers' asks in this order (docs/model.md §6). */
	rank: number;
}

/** The run series of the remote supply: on the receiving unit what arrived (part of supplied), on the supplying unit what its dam gave. */
export const REMOTE_SERIES = {
	in: { key: 'remote_dam_in', label: 'Supplied to the crops from another unit’s dam (part of supplied)', unit: 'm³/day' },
	out: { key: 'remote_dam_out', label: 'Given from this dam to other units’ crops', unit: 'm³/day' }
} as const;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const given = (v: unknown): boolean => v !== null && v !== undefined;

/** Whether a node has a crop supply table: any of its three shares is set (null and absent are unset). */
export const hasCropShares = (n: Pick<NetworkNode, 'cropShareDam' | 'cropShareRiver' | 'cropShareRemote'>): boolean => given(n.cropShareDam) || given(n.cropShareRiver) || given(n.cropShareRemote);

/** How far from 1 the shares may add up and still count as 1 (the form stores percentages as fractions). */
export const SHARE_SUM_TOLERANCE = 1e-6;

/**
 * A unit's crop supply table as the run uses it: `shares` for a table that
 * splits the crops between sources, or `source` when the table is all on one
 * of the unit's own sources (100 % dam runs as `cropWaterSource` 'dam' and
 * 100 % river as 'river', to the bit); {} without a table, so the crops take
 * `cropWaterSource`. A share that isn't a number in [0, 1] counts as 0 with a
 * warning; shares that don't add up to 1 are scaled to, with a warning; a
 * table with nothing in it runs as no table, with a warning (the API refuses
 * all three on save).
 */
export function cropSharesOf(n: NetworkNode, warnings: string[]): { shares?: PlanCropShare; source?: 'dam' | 'river' } {
	if (!hasCropShares(n)) return {};
	if (n.kind !== 'farm') {
		warnings.push(`${n.kind === 'user' ? 'user' : 'gauge'} "${n.name}": only a unit's crops have a water supply table; ignored`);
		return {};
	}
	const one = (v: number | null | undefined, what: string): number => {
		if (!given(v)) return 0;
		if (finite(v) && v >= 0 && v <= 1) return v;
		warnings.push(`unit "${n.name}": crop supply share from ${what} ${String(v)} is not between 0 and 1; using 0`);
		return 0;
	};
	let dam = one(n.cropShareDam, 'the dam');
	let river = one(n.cropShareRiver, 'the river');
	let remote = one(n.cropShareRemote, 'another unit’s dam');
	const sum = dam + river + remote;
	if (!(sum > 0)) {
		warnings.push(`unit "${n.name}": the crop supply table gives no source a share; the crops take their water source instead`);
		return {};
	}
	if (Math.abs(sum - 1) > SHARE_SUM_TOLERANCE) {
		warnings.push(`unit "${n.name}": the crop supply shares add up to ${+(sum * 100).toFixed(4)} %, not 100 %; each is scaled to make 100 %`);
		dam /= sum;
		river /= sum;
		remote /= sum;
	}
	if (remote === 0 && river === 0) return { source: 'dam' };
	if (remote === 0 && dam === 0) return { source: 'river' };
	return { shares: { dam, river, remote } };
}

/**
 * The remote supply each unit's crops draw on (index = node), from the units
 * with a remote share, in id order. Skipped with a warning (the share is then
 * asked of nothing and shows as a deficit): a supplying unit that doesn't
 * exist, isn't a unit, is the unit itself or has no dam; and one the
 * receiving unit drains into (along the river, the river off-takes `links`
 * or the remote supplies accepted before it), since the supplying unit is
 * simulated first each day. A pipe capacity that isn't a size ≥ 0 runs as no
 * limit with a warning; none set runs as no limit with a warning too.
 */
export function planRemoteSupply(
	nodes: readonly NetworkNode[],
	shares: readonly (PlanCropShare | undefined)[],
	links: readonly { from: number; to: number }[],
	warnings: string[]
): (PlanRemote | undefined)[] {
	const out: (PlanRemote | undefined)[] = nodes.map(() => undefined);
	const want = nodes.flatMap((n, i) => (shares[i] && shares[i]!.remote > 0 ? [i] : [])).sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id));
	if (!want.length) return out;
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const downstream = Int32Array.from(nodes, (n) => (n.downstreamNodeId === null ? -1 : (index.get(n.downstreamNodeId) ?? -1)));
	const extra: number[][] = nodes.map(() => []);
	for (const l of links) extra[l.from]!.push(l.to);
	let rank = 0;
	for (const to of want) {
		const n = nodes[to]!;
		const who = `unit "${n.name}": the crops' share from another unit's dam`;
		const id = n.cropRemoteNodeId;
		const from = id === null || id === undefined ? undefined : index.get(id);
		if (from === undefined) {
			warnings.push(`${who} names no unit that exists; that share is supplied nothing`);
			continue;
		}
		const src = nodes[from]!;
		if (src.kind !== 'farm' || from === to) {
			warnings.push(`${who}: "${src.name}" is not another unit; that share is supplied nothing`);
			continue;
		}
		if (!(src.damCapacityM3 > 0)) {
			warnings.push(`${who}: "${src.name}" has no dam; that share is supplied nothing`);
			continue;
		}
		if (reaches(to, from, downstream, extra)) {
			warnings.push(`${who}: "${n.name}" drains into "${src.name}", so its dam would supply water before it arrives; that share is supplied nothing`);
			continue;
		}
		extra[from]!.push(to);
		const raw = n.cropRemoteCapM3Day;
		let cap = Infinity;
		if (!given(raw)) warnings.push(`${who}: no pipe capacity is set, so what "${src.name}" gives is limited only by its storage`);
		else if (finite(raw) && raw >= 0) cap = raw;
		else warnings.push(`${who}: pipe capacity ${String(raw)} m³/day is not a size ≥ 0; no limit`);
		out[to] = { from, share: shares[to]!.remote, capM3Day: cap, rank: rank++ };
	}
	return out;
}

/**
 * What the API refuses in a model's crop supply tables (engine ≥ 1.73.0,
 * ../modelRules.ts), each with a stable key: a table on a node that isn't a
 * unit, a share that isn't a number from 0 to 1, shares that don't add up to
 * 100 %, a remote share without another unit with a dam to draw on (or one
 * the unit drains into, along the river or the river off-takes, or the
 * remote shares named before it), and a pipe capacity that isn't a size ≥ 0.
 * The run would run each with a warning (cropSharesOf, planRemoteSupply).
 */
export function cropSupplyIssues(
	nodes: readonly NetworkNode[],
	offtakes: readonly { fromNodeId: string; toNodeId: string }[],
	add: (key: string, message: string) => void
): void {
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const downstream = Int32Array.from(nodes, (n) => (n.downstreamNodeId === null ? -1 : (index.get(n.downstreamNodeId) ?? -1)));
	const extra: number[][] = nodes.map(() => []);
	for (const o of offtakes) {
		const a = index.get(o.fromNodeId);
		const b = index.get(o.toNodeId);
		if (a !== undefined && b !== undefined && a !== b) extra[a]!.push(b);
	}
	for (const i of nodes.map((_, k) => k).sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id))) {
		const n = nodes[i]!;
		if (!hasCropShares(n)) continue;
		if (n.kind !== 'farm') {
			add(`cropShareKind:${n.id}`, `"${n.name}": only a unit's crops have a water supply table`);
			continue;
		}
		const parts = [n.cropShareDam, n.cropShareRiver, n.cropShareRemote];
		if (parts.some((v) => given(v) && !(finite(v) && v >= 0 && v <= 1))) {
			add(`cropShareRange:${n.id}`, `"${n.name}": each crop supply share must be from 0 to 100 %`);
			continue;
		}
		const sum = parts.reduce<number>((s, v) => s + (v ?? 0), 0);
		if (Math.abs(sum - 1) > SHARE_SUM_TOLERANCE) add(`cropShareSum:${n.id}`, `"${n.name}": the crop supply shares add up to ${+(sum * 100).toFixed(4)} %, not 100 %`);
		const raw = n.cropRemoteCapM3Day;
		if (given(raw) && !(finite(raw) && raw >= 0)) add(`cropRemoteCap:${n.id}`, `"${n.name}": the pipe capacity from the other unit's dam must be a number ≥ 0 (m³/day), or none`);
		if (!((n.cropShareRemote ?? 0) > 0)) continue;
		const from = n.cropRemoteNodeId ? index.get(n.cropRemoteNodeId) : undefined;
		const src = from === undefined ? undefined : nodes[from]!;
		if (!src || src.kind !== 'farm' || from === i) add(`cropRemoteNode:${n.id}`, `"${n.name}": the crops' share from another unit's dam needs that unit`);
		else if (!(src.damCapacityM3 > 0)) add(`cropRemoteDam:${n.id}`, `"${n.name}": "${src.name}" has no dam to supply the crops' share from`);
		else if (reaches(i, from!, downstream, extra)) add(`cropRemoteLoop:${n.id}`, `"${n.name}" drains into "${src.name}", so its dam can't supply "${n.name}"'s crops the same day; pick a dam upstream or on another branch`);
		else extra[from!]!.push(i);
	}
}

/**
 * The share of a unit's crop demand its own dam side is asked for, as the
 * run takes it: the table's dam share, else 0 for crops on the river and 1
 * otherwise. For views that read a saved model (the farm projection).
 */
export function cropDamShareOf(n: NetworkNode): number {
	const t = cropSharesOf(n, []);
	if (t.shares) return t.shares.dam;
	const source = t.source ?? n.cropWaterSource;
	return source === 'river' ? 0 : 1;
}

/** The share of a unit's crop demand its crops' river abstraction is asked for, as the run takes it (cropDamShareOf's counterpart). */
export function cropRiverShareOf(n: NetworkNode): number {
	if (n.kind !== 'farm') return 0;
	const t = cropSharesOf(n, []);
	if (t.shares) return t.shares.river;
	return (t.source ?? n.cropWaterSource) === 'river' ? 1 : 0;
}

/**
 * The remote shares a saved model runs with, as runModel plans them (cropSharesOf, planRemoteSupply with the
 * enabled river off-takes as links): for each, the supplying and receiving node's index. For views that read
 * a saved run's remote_dam_in series (only these units have one).
 */
export function plannedRemoteLegs(nodes: readonly NetworkNode[], transfers: readonly { enabled: boolean; source?: unknown; fromNodeId: string; toNodeId: string }[]): { from: number; to: number }[] {
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const links = transfers.flatMap((tr) => {
		const from = index.get(tr.fromNodeId);
		const to = index.get(tr.toNodeId);
		return tr.enabled && tr.source === 'river' && from !== undefined && to !== undefined && from !== to && nodes[from]!.kind === 'farm' && nodes[to]!.kind === 'farm' ? [{ from, to }] : [];
	});
	const remotes = planRemoteSupply(nodes, nodes.map((n) => cropSharesOf(n, []).shares), links, []);
	return remotes.flatMap((x, to) => (x ? [{ from: x.from, to }] : []));
}
