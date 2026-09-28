// View model for the share-the-pain board (issue #53 R3,
// docs/design/planning-outputs.md §3.3): the curtailment report
// (RunSummary.curtailment, model.md §2.11) read as three stages per user
// group, each as a share of the group's demand:
//
//   1. Today: what it was supplied (I / H).
//   2. Equitable share: the fairness benchmark, the same fraction of demand
//      for every farm (M / H = K_tot). Other water users are outside it.
//   3. EWR met: what is left once the EWR charge is met as well (U / H for a
//      farm, bounded to 0–100 %; for another user, what it takes after its
//      supply cut, or all of it for a senior user, which is not curtailed).
//
// Presentation only: every figure comes from the engine's summary, nothing is
// recomputed, and no stage is ever below 0 (the client's sketch charged the
// EWR to a group with no demand and printed a negative final demand; the
// engine bounds the volume left and shows that charge as store less / pass
// inflow, plan.md Q13). Pure, so it is unit-tested without Svelte.
import type { CurtailmentFarm, CurtailmentSummary, CurtailmentUser } from '@water-management/engine';
import { fmtDemandLeft, fmtVol } from './curtailment';

/**
 * How the middle stage shares the water: the equal share, every farm the
 * same fraction of its demand (the engine's equitable share). The client
 * confirmed one equal % for every category (plan.md O4, issue #90), so no
 * per-category restriction is built; one would be a second member of this
 * union, labelled as a what-if, with its own `shareStage` branch.
 */
export type ShareRule = { kind: 'equal' };

export const EQUAL_SHARE: ShareRule = { kind: 'equal' };

/** One stage for one row: volume (m³/day) and the share of demand it is. */
export interface StageCell {
	/** m³/day, never below 0. */
	volumeM3Day: number;
	/** volume ÷ demand in 0–1; null when the row has no demand. */
	fraction: number | null;
	/** "73%", "no demand", "—", "<1%", ">99%" (fmtDemandLeft). */
	pct: string;
	/** Tooltip for pct ("—" below the demand floor); null when none. */
	pctTitle: string | null;
	/** The volume, at most one decimal. */
	volume: string;
}

export type Priority = 'senior' | 'junior';

export interface BoardRow {
	nodeId: string;
	name: string;
	kind: 'farm' | 'user';
	/** Other water users only. */
	priority: Priority | null;
	demandM3Day: number;
	demand: string;
	today: StageCell;
	/** null = outside the share (other water users). */
	share: StageCell | null;
	ewr: StageCell;
	/** What the EWR stage leaves unsaid in the %: a store-less charge, a cut beyond the share, a charge left standing. */
	ewrNotes: string[];
}

export interface StageTotals {
	demand: string;
	today: StageCell;
	share: StageCell | null;
	ewr: StageCell;
}

export interface Board {
	rule: ShareRule;
	/** K_tot: the fraction of demand every farm gets at the equal share; null with no farm demand. */
	shareFraction: number | null;
	farms: BoardRow[];
	users: BoardRow[];
	/** Totals per stage over the farms (plain sums, like the curtailment table's totals row). */
	farmTotals: StageTotals;
	/** Totals per stage over the other water users; null when there are none. */
	userTotals: StageTotals | null;
}

/** Below this a volume rounds to 0 at one decimal and isn't worth a note. */
const NOTE_FLOOR_M3_DAY = 0.05;

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

/** A stage cell from a volume against a demand; negative volumes (runs before engine 0.17.0) are shown as 0. */
export function stageCell(volumeM3Day: number, demandM3Day: number): StageCell {
	const v = Number.isFinite(volumeM3Day) ? Math.max(volumeM3Day, 0) : 0;
	const fraction = demandM3Day > 0 ? clamp01(v / demandM3Day) : null;
	const left = fmtDemandLeft(demandM3Day, fraction);
	return { volumeM3Day: v === 0 ? 0 : v, fraction, pct: left.text, pctTitle: left.title, volume: fmtVol(v) };
}

/** The middle stage's volume for a farm under `rule`. */
function shareStage(rule: ShareRule, f: CurtailmentFarm): number {
	switch (rule.kind) {
		case 'equal':
			return f.targetM3Day;
	}
}

function farmRow(f: CurtailmentFarm, rule: ShareRule, names: Record<string, string>): BoardRow {
	const notes: string[] = [];
	const store = -(f.ewrChargeStorageM3Day ?? 0);
	if (store >= NOTE_FLOOR_M3_DAY) notes.push(`store less / pass inflow ${fmtVol(store)} m³/day`);
	const beyond = f.ewrCutBeyondShareM3Day ?? 0;
	if (beyond >= NOTE_FLOOR_M3_DAY) notes.push(`EWR cut exceeds its equitable share by ${fmtVol(beyond)} m³/day`);
	return {
		nodeId: f.nodeId,
		name: names[f.nodeId] ?? f.name,
		kind: 'farm',
		priority: null,
		demandM3Day: f.demandM3Day,
		demand: fmtVol(f.demandM3Day),
		today: stageCell(f.suppliedM3Day, f.demandM3Day),
		share: stageCell(shareStage(rule, f), f.demandM3Day),
		ewr: stageCell(f.volumeLeftM3Day, f.demandM3Day),
		ewrNotes: notes
	};
}

/** What an other water user takes once the EWR is met: after its supply cut (junior), or all of it (senior). */
export function userLeftM3Day(u: CurtailmentUser): number {
	return u.curtailed ? Math.max(u.suppliedM3Day + u.supplyCutM3Day, 0) : u.suppliedM3Day;
}

function userRow(u: CurtailmentUser, names: Record<string, string>): BoardRow {
	const notes: string[] = [];
	const standing = -u.uncurtailedChargeM3Day;
	if (standing >= NOTE_FLOOR_M3_DAY) {
		notes.push(
			u.curtailed
				? `${fmtVol(standing)} m³/day of its EWR charge is more than it takes and stands`
				: `not curtailed: its EWR charge of ${fmtVol(standing)} m³/day stands`
		);
	}
	return {
		nodeId: u.nodeId,
		name: names[u.nodeId] ?? u.name,
		kind: 'user',
		priority: u.curtailed ? 'junior' : 'senior',
		demandM3Day: u.demandM3Day,
		demand: fmtVol(u.demandM3Day),
		today: stageCell(u.suppliedM3Day, u.demandM3Day),
		share: null,
		ewr: stageCell(userLeftM3Day(u), u.demandM3Day),
		ewrNotes: notes
	};
}

function totals(rows: BoardRow[], withShare: boolean): StageTotals {
	const sum = (pick: (r: BoardRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
	const demand = sum((r) => r.demandM3Day);
	return {
		demand: fmtVol(demand),
		today: stageCell(sum((r) => r.today.volumeM3Day), demand),
		share: withShare ? stageCell(sum((r) => r.share?.volumeM3Day ?? 0), demand) : null,
		ewr: stageCell(sum((r) => r.ewr.volumeM3Day), demand)
	};
}

/**
 * The board for one curtailment report. Farms in the engine's (network)
 * order, then the other water users. `names` maps a node id to its current
 * name, for nodes renamed since the run.
 */
export function shareThePain(c: CurtailmentSummary, names: Record<string, string> = {}, rule: ShareRule = EQUAL_SHARE): Board {
	const farms = c.farms.map((f) => farmRow(f, rule, names));
	const users = (c.otherUsers ?? []).map((u) => userRow(u, names));
	return {
		rule,
		shareFraction: c.equitableFraction,
		farms,
		users,
		farmTotals: totals(farms, true),
		userTotals: users.length ? totals(users, false) : null
	};
}
