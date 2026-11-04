// View model for the share-the-pain board (issue #53 R3,
// docs/design/planning-outputs.md §3.3): the curtailment report
// (RunSummary.curtailment, model.md §2.11) read as three stages per user
// group, each as a share of the group's demand:
//
//   1. Today: what it was supplied (I / H).
//   2. Equitable share: the volume at the equal share (M = H × K_tot), its
//      change from today (N = M − I: − reduce, + below the share) and the %
//      of demand (P, the same K_tot for every farm). Farms only: other water
//      users are outside it.
//   3. EWR met: the EWR charge (R), the total change from today (S) and what
//      is left once the EWR charge is met as well (U / H for a farm, bounded
//      to 0–100 %, never below its basic-needs floor, engine ≥ 1.44.0; for
//      another user, what it takes after its supply cut, or all of it for a
//      priority user, which is not curtailed unless it has a fixed
//      restriction %, engine 1.86.0, issue #523 B3).
//
// Issue #177 had folded the equal share into the intro, since its % is the
// same for every farm and its total is today's; the operator's mock-ups
// (2026-11-03) brought it back as a stage for what does differ per row: the
// volume each unit would move to reach it. The intro still says the % once.
// Each % carries the app's supply band (≥ 95 %, 70–95 %, < 70 %,
// network/supplyThresholds.ts), the one banding every supply view uses.
//
// Presentation only: every figure comes from the engine's summary, nothing is
// recomputed, and no stage is ever below 0 (the client's sketch charged the
// EWR to a group with no demand and printed a negative final demand; the
// engine bounds the volume left and shows that charge as store less / pass
// inflow, plan.md Q13). Pure, so it is unit-tested without Svelte.
import { DEMAND_NORMS, DEMAND_PCT_FLOOR_M3_DAY, USER_RESTRICTION_NOTE, type CurtailmentFarm, type CurtailmentSummary, type CurtailmentUser } from '@water-management/engine';

/** A share as a whole percent: 0.3 → "30 %". */
const fmtPctShare = (x: number) => `${Math.round(x * 100)} %`;
import { fmtCharged, fmtDemandLeft, fmtSigned, fmtVol } from './curtailment';
import { LOW_SUPPLY, SUPPLY_TARGET } from '#lib/components/network/supplyThresholds.js';

/** The app's supply bands (network/supplyColour.ts), for a share of demand; `none` without demand. */
export type ShareBand = 'met' | 'short' | 'low' | 'none';

export function shareBand(fraction: number | null): ShareBand {
	if (fraction === null || !Number.isFinite(fraction)) return 'none';
	return fraction >= SUPPLY_TARGET ? 'met' : fraction >= LOW_SUPPLY ? 'short' : 'low';
}

/** The bands in words, for the board's legend: the same thresholds as Supply by hydrological unit. */
export const SHARE_BAND_LABEL: Readonly<Record<Exclude<ShareBand, 'none'>, string>> = Object.freeze({
	met: `${Math.round(SUPPLY_TARGET * 100)} % of demand or more`,
	short: `${Math.round(LOW_SUPPLY * 100)}–${Math.round(SUPPLY_TARGET * 100)} %`,
	low: `Under ${Math.round(LOW_SUPPLY * 100)} %`
});

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
	/** The supply band of `fraction`. */
	band: ShareBand;
}

/** A change from today in m³/day: − reduce, + below the share (never called a gain, audit Q11). */
export interface Change {
	m3Day: number;
	/** "−197.5", "+314.9", "0" (fmtSigned). */
	text: string;
	/** Which arrow the board draws beside it; `none` when it rounds to 0. */
	direction: 'down' | 'up' | 'none';
}

export function change(m3Day: number): Change {
	const v = Number.isFinite(m3Day) ? m3Day : 0;
	const text = fmtSigned(v);
	return { m3Day: v, text, direction: text === '0' ? 'none' : v < 0 ? 'down' : 'up' };
}

/** Stage 2 for one farm: its equitable share volume, the change from today, the % of demand. */
export interface ShareStage {
	target: StageCell;
	change: Change;
}

/** Stage 3's columns before the volume left: the EWR charge (a positive volume charged) and the total change from today. */
export interface EwrStage {
	charge: string;
	chargeM3Day: number;
	totalChange: Change;
}

export type Priority = 'senior' | 'junior';

export interface BoardRow {
	nodeId: string;
	name: string;
	kind: 'farm' | 'user';
	/** Other water users only. */
	priority: Priority | null;
	/**
	 * Other water users only: the badge's words, "priority, not curtailed",
	 * "priority, fixed 30 %" (a fixed restriction %, engine 1.86.0) or
	 * "non-priority, curtailed".
	 */
	priorityLabel: string | null;
	demandM3Day: number;
	demand: string;
	today: StageCell;
	/** Farms only; null for another water user (outside the equitable share). */
	share: ShareStage | null;
	/** The EWR charge and the total change; `ewr` is the volume left. */
	ewrStage: EwrStage;
	ewr: StageCell;
	/** What the EWR stage leaves unsaid in the %: a store-less charge, a cut beyond the share, a charge left standing. */
	ewrNotes: string[];
}

export interface StageTotals {
	demand: string;
	demandM3Day: number;
	today: StageCell;
	/** Null when no row has a stage 2 (the other water users). */
	share: ShareStage | null;
	ewrStage: EwrStage;
	ewr: StageCell;
}

/**
 * The three cards under the stages' headings, one per stage, over every
 * group (farms and other water users):
 * - deficit: demand − supplied today;
 * - moved: what the equal share would move between farms (Σ of the cuts of
 *   those above it; the same water goes to those below, so the farms'
 *   total is unchanged: `net` says so up to rounding);
 * - ewrCut: what the EWR takes beyond that, the farms' equitable share −
 *   volume left plus each other user's take − what it is left, and the
 *   charge met by storing less / passing inflow, which takes no supply.
 */
export interface BoardCards {
	deficit: { m3Day: number; volume: string; pct: string | null };
	moved: { m3Day: number; volume: string; net: string } | null;
	ewrCut: { m3Day: number; volume: string; pct: string | null; storeLess: string | null };
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
	cards: BoardCards;
}

/**
 * What a unit's basic-needs floor keeps of the cut (engine ≥ 1.44.0, issue
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
	return { volumeM3Day: v === 0 ? 0 : v, fraction, pct: left.text, pctTitle: left.title, volume: fmtVol(v), band: shareBand(fraction) };
}

function farmRow(f: CurtailmentFarm, names: Record<string, string>): BoardRow {
	const notes: string[] = [];
	const store = -(f.ewrChargeStorageM3Day ?? 0);
	if (store >= NOTE_FLOOR_M3_DAY) notes.push(`store less / pass inflow ${fmtVol(store)} m³/day`);
	const beyond = f.ewrCutBeyondShareM3Day ?? 0;
	if (beyond >= NOTE_FLOOR_M3_DAY) notes.push(`EWR cut exceeds its equitable share by ${fmtVol(beyond)} m³/day`);
	// The basic-needs floor (engine ≥ 1.44.0, issue #123): the EWR stage never goes below it.
	const held = f.basicNeedsHeldM3Day ?? 0;
	if (held >= NOTE_FLOOR_M3_DAY) notes.push(basicNeedsNote(fmtVol(held), fmtVol(f.basicNeedsM3Day ?? 0)));
	return {
		nodeId: f.nodeId,
		name: names[f.nodeId] ?? f.name,
		kind: 'farm',
		priority: null,
		priorityLabel: null,
		demandM3Day: f.demandM3Day,
		demand: fmtVol(f.demandM3Day),
		today: stageCell(f.suppliedM3Day, f.demandM3Day),
		share: { target: stageCell(f.targetM3Day, f.demandM3Day), change: change(f.reduceGainM3Day) },
		ewrStage: { charge: fmtCharged(f.ewrShortfallM3Day), chargeM3Day: -Math.min(f.ewrShortfallM3Day, 0), totalChange: change(f.totalChangeM3Day) },
		ewr: stageCell(f.volumeLeftM3Day, f.demandM3Day),
		ewrNotes: notes
	};
}

/** What an other water user takes once the EWR is met: after its supply cut (non-priority, or priority with a fixed restriction %), or all of it (priority). */
export function userLeftM3Day(u: CurtailmentUser): number {
	return u.curtailed ? Math.max(u.suppliedM3Day + u.supplyCutM3Day, 0) : u.suppliedM3Day;
}

function userRow(u: CurtailmentUser, names: Record<string, string>): BoardRow {
	const notes: string[] = [];
	const standing = -u.uncurtailedChargeM3Day;
	// A Priority user with a fixed restriction % (engine 1.86.0): cut by at most that share, no basic-needs floor.
	const fixed = u.priority === 'senior' && u.restrictionPct !== undefined && u.restrictionPct > 0;
	if (fixed) notes.push(`${fmtPctShare(u.restrictionPct!)} fixed restriction, ${USER_RESTRICTION_NOTE.replace('fixed %, ', '')}`);
	if (standing >= NOTE_FLOOR_M3_DAY) {
		notes.push(
			fixed
				? `${fmtVol(standing)} m³/day of its EWR charge is beyond its fixed % and stands`
				: u.curtailed
					? `${fmtVol(standing)} m³/day of its EWR charge is more than it takes and stands`
					: `not curtailed: its EWR charge of ${fmtVol(standing)} m³/day stands`
		);
	}
	return {
		nodeId: u.nodeId,
		name: names[u.nodeId] ?? u.name,
		kind: 'user',
		priority: u.priority,
		priorityLabel: u.priority === 'junior' ? 'non-priority, curtailed' : fixed ? `priority, fixed ${fmtPctShare(u.restrictionPct!)}` : 'priority, not curtailed',
		demandM3Day: u.demandM3Day,
		demand: fmtVol(u.demandM3Day),
		today: stageCell(u.suppliedM3Day, u.demandM3Day),
		share: null,
		ewrStage: { charge: fmtCharged(u.ewrChargeM3Day), chargeM3Day: -Math.min(u.ewrChargeM3Day, 0), totalChange: change(userLeftM3Day(u) - u.suppliedM3Day) },
		ewr: stageCell(userLeftM3Day(u), u.demandM3Day),
		ewrNotes: notes
	};
}

function totals(rows: BoardRow[]): StageTotals {
	const sum = (pick: (r: BoardRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
	const demand = sum((r) => r.demandM3Day);
	const charge = sum((r) => r.ewrStage.chargeM3Day);
	const shared = rows.filter((r) => r.share);
	return {
		demand: fmtVol(demand),
		demandM3Day: demand,
		today: stageCell(sum((r) => r.today.volumeM3Day), demand),
		share: shared.length
			? { target: stageCell(sum((r) => r.share?.target.volumeM3Day ?? 0), demand), change: change(sum((r) => r.share?.change.m3Day ?? 0)) }
			: null,
		ewrStage: { charge: fmtCharged(-charge), chargeM3Day: charge, totalChange: change(sum((r) => r.ewrStage.totalChange.m3Day)) },
		ewr: stageCell(sum((r) => r.ewr.volumeM3Day), demand)
	};
}

const pctOf = (part: number, whole: number) => (whole >= DEMAND_PCT_FLOOR_M3_DAY ? fmtDemandLeft(whole, part / whole).text : null);

function cardsOf(c: CurtailmentSummary, farms: BoardRow[], users: BoardRow[], farmTotals: StageTotals): BoardCards {
	const all = [...farms, ...users];
	const demand = all.reduce((s, r) => s + r.demandM3Day, 0);
	const deficit = Math.max(all.reduce((s, r) => s + r.demandM3Day - r.today.volumeM3Day, 0), 0);
	const moved = farms.reduce((s, r) => s + Math.max(-(r.share?.change.m3Day ?? 0), 0), 0);
	// Beyond the equal share: a farm's equitable share − its volume left; another user's take − what it is left.
	const ewrCut = Math.max(
		farms.reduce((s, r) => s + (r.share?.target.volumeM3Day ?? 0) - r.ewr.volumeM3Day, 0) + users.reduce((s, r) => s + r.today.volumeM3Day - r.ewr.volumeM3Day, 0),
		0
	);
	const store = -(c.totals.ewrChargeStorageM3Day ?? 0);
	return {
		deficit: { m3Day: deficit, volume: fmtVol(deficit), pct: pctOf(deficit, demand) },
		moved: c.equitableFraction === null || !farms.length ? null : { m3Day: moved, volume: fmtVol(moved), net: farmTotals.share?.change.text ?? '0' },
		ewrCut: { m3Day: ewrCut, volume: fmtVol(ewrCut), pct: pctOf(ewrCut, demand), storeLess: store >= NOTE_FLOOR_M3_DAY ? fmtVol(store) : null }
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
	const userTotals = users.length ? totals(users) : null;
	const demand = farms.reduce((s, r) => s + r.demandM3Day, 0);
	const shareTooSmall = c.equitableFraction !== null && demand > 0 && demand < DEMAND_PCT_FLOOR_M3_DAY;
	return {
		sharePct: c.equitableFraction === null || !(demand > 0) || shareTooSmall ? null : fmtDemandLeft(demand, c.equitableFraction).text,
		shareTooSmall,
		farms,
		users,
		farmTotals,
		userTotals,
		cards: cardsOf(c, farms, users, farmTotals)
	};
}
