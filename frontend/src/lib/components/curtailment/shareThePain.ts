// View model for the share-the-pain board (issue #53 R3,
// docs/design/planning-outputs.md §3.3): the curtailment report
// (RunSummary.curtailment, model.md §2.11) read as two stages per user
// group, each as a share of the group's demand:
//
//   1. Today: what it was supplied (I / H).
//   2. EWR met: what is left once the EWR charge is met as well (U / H for a
//      farm, bounded to 0–100 %, never below its basic-needs floor, engine ≥ 1.38.0; for another user, what it takes after its
//      supply cut, or all of it for a senior user, which is not curtailed).
//
// The equitable share (M / H = K_tot) is not a stage: it is the same fraction
// for every farm and its total is always today's, so the board says it once,
// in its intro (`sharePct`, issue #177). Other water users are outside it.
//
// Presentation only: every figure comes from the engine's summary, nothing is
// recomputed, and no stage is ever below 0 (the client's sketch charged the
// EWR to a group with no demand and printed a negative final demand; the
// engine bounds the volume left and shows that charge as store less / pass
// inflow, plan.md Q13). Pure, so it is unit-tested without Svelte.
import { DEMAND_NORMS, DEMAND_PCT_FLOOR_M3_DAY, type CurtailmentFarm, type CurtailmentSummary, type CurtailmentUser } from '@water-management/engine';
import { fmtDemandLeft, fmtVol } from './curtailment';

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
	ewr: StageCell;
	/** What the EWR stage leaves unsaid in the %: a store-less charge, a cut beyond the share, a charge left standing. */
	ewrNotes: string[];
}

export interface StageTotals {
	demand: string;
	today: StageCell;
	ewr: StageCell;
}

export interface Board {
	/**
	 * K_tot, the share of its demand every farm gets at the equal share, as a % ("75%"); null with no
	 * farm demand, or with farm demand under DEMAND_PCT_FLOOR_M3_DAY in total (`shareTooSmall`).
	 */
	sharePct: string | null;
	/** Farm demand in total is under DEMAND_PCT_FLOOR_M3_DAY, so a % of it would mean nothing. */
	shareTooSmall: boolean;
	farms: BoardRow[];
	users: BoardRow[];
	/** Totals per stage over the farms (plain sums, like the curtailment table's totals row). */
	farmTotals: StageTotals;
	/** Totals per stage over the other water users; null when there are none. */
	userTotals: StageTotals | null;
}

/**
 * What a unit's basic-needs floor keeps of the cut (engine ≥ 1.38.0, issue
 * #123), in one wording for the board's note and the curtailment table's badge.
 */
export const basicNeedsNote = (held: string, floor: string): string =>
	`basic needs keep ${held} m³/day of the cut (floor ${floor} m³/day, ${DEMAND_NORMS.basicLitresPerPersonDay} litres a person a day)`;

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

function farmRow(f: CurtailmentFarm, names: Record<string, string>): BoardRow {
	const notes: string[] = [];
	const store = -(f.ewrChargeStorageM3Day ?? 0);
	if (store >= NOTE_FLOOR_M3_DAY) notes.push(`store less / pass inflow ${fmtVol(store)} m³/day`);
	const beyond = f.ewrCutBeyondShareM3Day ?? 0;
	if (beyond >= NOTE_FLOOR_M3_DAY) notes.push(`EWR cut exceeds its equitable share by ${fmtVol(beyond)} m³/day`);
	// The basic-needs floor (engine ≥ 1.38.0, issue #123): the EWR stage never goes below it.
	const held = f.basicNeedsHeldM3Day ?? 0;
	if (held >= NOTE_FLOOR_M3_DAY) notes.push(basicNeedsNote(fmtVol(held), fmtVol(f.basicNeedsM3Day ?? 0)));
	return {
		nodeId: f.nodeId,
		name: names[f.nodeId] ?? f.name,
		kind: 'farm',
		priority: null,
		demandM3Day: f.demandM3Day,
		demand: fmtVol(f.demandM3Day),
		today: stageCell(f.suppliedM3Day, f.demandM3Day),
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
		ewr: stageCell(userLeftM3Day(u), u.demandM3Day),
		ewrNotes: notes
	};
}

function totals(rows: BoardRow[]): StageTotals {
	const sum = (pick: (r: BoardRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
	const demand = sum((r) => r.demandM3Day);
	return {
		demand: fmtVol(demand),
		today: stageCell(sum((r) => r.today.volumeM3Day), demand),
		ewr: stageCell(sum((r) => r.ewr.volumeM3Day), demand)
	};
}

/**
 * The board for one curtailment report. Farms in the engine's (network)
 * order, then the other water users. `names` maps a node id to its current
 * name, for nodes renamed since the run.
 */
export function shareThePain(c: CurtailmentSummary, names: Record<string, string> = {}): Board {
	const farms = c.farms.map((f) => farmRow(f, names));
	const users = (c.otherUsers ?? []).map((u) => userRow(u, names));
	const farmTotals = totals(farms);
	const demand = farms.reduce((s, r) => s + r.demandM3Day, 0);
	const shareTooSmall = c.equitableFraction !== null && demand > 0 && demand < DEMAND_PCT_FLOOR_M3_DAY;
	return {
		sharePct: c.equitableFraction === null || !(demand > 0) || shareTooSmall ? null : fmtDemandLeft(demand, c.equitableFraction).text,
		shareTooSmall,
		farms,
		users,
		farmTotals,
		userTotals: users.length ? totals(users) : null
	};
}
