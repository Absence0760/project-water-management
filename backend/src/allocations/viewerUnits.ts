// What a project's viewers read of its registered volumes (decision D3,
// provisional position, pre-counsel research 2026-10-01; 162_allocation_viewer_units.sql,
// docs/allocations.md § Who sees what).
//
// Owners and editors read every allocation. A viewer reads each farm's
// volumes only when an owner has switched project.allocations_viewer_units
// on; otherwise RLS gives a viewer no allocation row, and the API serves
// totals per water source instead, summed here from app_allocation_volumes
// (which returns a source's rows only when 5 or more registered users hold
// it, each with an opaque holder key, 219): each sum is given only when the
// rows in it, in force that day or water year, are 5 or more holders'
// (#523 G). The run's own copy of the rows (its model's `allocations`, the
// per-unit part of its summary's `allocations`) is left out of what a viewer
// reads too (redactRunAllocations).
import {
	allocationStatus,
	compareAllocations,
	type AllocationComparison,
	type AllocationEntry,
	type AllocationStatus,
	type AllocationUseNode,
	type AllocationWaterSource,
	type ScenarioOp,
	allocationsOverFlag,
	mixShares,
	ownUnitYears,
	registeredUseRow,
	shownWithin,
	takesWithin,
	totalShown,
	type AuthorisedMix,
	type AuthorisedMixShares,
	type EvidenceAllocations,
	type EvidenceRow
} from '@water-management/engine';
import { requestAuth } from '../auth/stepUp.js';
import type { Db } from '../db/tx.js';
import type { Role } from '../projects/access.js';
import { authorisedVerdicts, boardVerdicts, combinedDamVerdicts, verdictsReport, verdictsSummary } from './verdictsOnly.js';

/**
 * Whether the caller is kept from each registered volume: a viewer on a
 * project whose owners haven't let viewers read each one. Who reads them is
 * decided in one place, the database's app_reads_allocation_units (231), the
 * function allocation_select reads too: a member acting for the responsible
 * authority always (#523 G6), an editor or owner, a viewer with the switch
 * on. Farmers and applicants (contributors) aren't answered here: their own
 * views decide what they read of their farms and applications.
 */
export async function allocationUnitsHidden(db: Db, projectId: string, role: Role): Promise<boolean> {
	// A report render queued without registered volumes (218, #523 G1): every project, whatever the role.
	if (requestAuth.getStore()?.redactAllocations) return true;
	if (role === 'farmer' || role === 'contributor') return false;
	return !(await readsAllocationUnits(db, projectId));
}

/** The current user reads each of the project's allocation rows (app_reads_allocation_units, 231; #523 G6). */
export async function readsAllocationUnits(db: Db, projectId: string): Promise<boolean> {
	const { rows } = await db.query<{ on: boolean }>('SELECT app_reads_allocation_units($1) AS "on"', [projectId]);
	return rows[0]?.on === true;
}

/** The current user reads the names of the project's registered users (app_reads_allocation_holders, 231; #523 G6). */
export async function readsAllocationHolders(db: Db, projectId: string): Promise<boolean> {
	const { rows } = await db.query<{ on: boolean }>('SELECT app_reads_allocation_holders($1) AS "on"', [projectId]);
	return rows[0]?.on === true;
}

/** One row behind a viewer's totals (app_allocation_volumes): no name, number or property. */
export interface VolumeRow {
	waterSource: AllocationWaterSource;
	/** Registered users holding this source over all its rows, whatever their dates (5 or more, or no row is returned). */
	holders: number;
	/** This row's holder: a salted key (219), only to count the holders, and their shares, of the rows a total sums. */
	holder: string;
	nodeId: string | null;
	volumeM3PerYear: number;
	storageM3: number | null;
	waterUse: '21a' | '21b';
	validFrom: string | null;
	validTo: string | null;
}

export async function loadVolumes(db: Db, projectId: string): Promise<VolumeRow[]> {
	const { rows } = await db.query<VolumeRow>(
		`SELECT water_source AS "waterSource", holders, holder, node_id AS "nodeId", volume_m3_year AS "volumeM3PerYear", storage_m3 AS "storageM3",
			water_use AS "waterUse", to_char(valid_from, 'YYYY-MM-DD') AS "validFrom", to_char(valid_to, 'YYYY-MM-DD') AS "validTo"
		 FROM app_allocation_volumes($1)`,
		[projectId]
	);
	return rows;
}

/**
 * A water source's registered volumes in force today, summed: the only
 * registered m³ a viewer kept from each volume reads (#523 G/K/L/M, operator
 * decision 2026-10-11). Any other figure (a run's water years, the evidence
 * report's totals of other units) is over another set of rows, and two sums
 * over different rows read at the same time give their difference.
 */
export interface AllocationTotal {
	waterSource: AllocationWaterSource;
	/** Registered users holding this source over all its rows (5 or more, or it isn't returned). */
	holders: number;
	/**
	 * Volumes in force today, m³ a year (takes only; a 21b row is storage); null when the takes in force
	 * today are fewer than 5 registered users', or one or two of them dominate the sum (totalShown).
	 */
	registeredM3PerYear: number | null;
	/** Registered storage in force today, m³; null when none states one, or when it is withheld (`storageWithheld`). */
	storageM3: number | null;
	/** The storage in force today is fewer than 5 registered users', or dominated by one or two (#523 G/O). */
	storageWithheld?: true;
}

const inForce = (r: Pick<VolumeRow, 'validFrom' | 'validTo'>, day: string) => (!r.validFrom || r.validFrom <= day) && (!r.validTo || r.validTo >= day);
const SOURCES: readonly AllocationWaterSource[] = ['surface', 'groundwater'];
/** Each holder's part of a sum over `rows`. */
const partsOf = <R extends { holder: string }>(rows: readonly R[], amount: (r: R) => number) => {
	const out = new Map<string, number>();
	for (const r of rows) out.set(r.holder, (out.get(r.holder) ?? 0) + amount(r));
	return out.values();
};

/**
 * Each water source's takes and storage in force on `day`, summed, each sum
 * given only when it passes the 5-holder and dominance rules over the rows in
 * it (totalShown; none at all is 0, or no storage), not over the source's
 * rows of every date (#523 G, O).
 */
export function volumeTotals(rows: readonly VolumeRow[], day: string): AllocationTotal[] {
	return SOURCES.flatMap((src) => {
		const mine = rows.filter((r) => r.waterSource === src);
		if (!mine.length) return [];
		const takes = mine.filter((r) => r.waterUse !== '21b' && r.volumeM3PerYear > 0 && inForce(r, day));
		const storages = mine.filter((r) => r.storageM3 !== null && r.storageM3 > 0 && inForce(r, day));
		const storageShown = totalShown(partsOf(storages, (r) => r.storageM3!));
		return [
			{
				waterSource: src,
				holders: mine[0]!.holders,
				registeredM3PerYear: totalShown(partsOf(takes, (r) => r.volumeM3PerYear)) ? takes.reduce((s, r) => s + r.volumeM3PerYear, 0) : null,
				storageM3: storages.length && storageShown ? storages.reduce((s, r) => s + r.storageM3!, 0) : null,
				...(storageShown ? {} : { storageWithheld: true as const })
			}
		];
	});
}

/**
 * One water year of a source's use, summed over the units with a volume on
 * it: the modelled use only. Neither the registered volume (#523 K/L/M:
 * consecutive years, or a year and today's total, differ by one holder's
 * volume) nor the year's status: a status per year at a fixed band, pooled
 * over the years of several runs, pins the registered volume to well under
 * 1 % and one holder's to a few percent (#523 round 6; operator's decision
 * 2026-10-11, provisional pending the D3 review, #92).
 */
export interface AllocationYearTotal {
	waterYear: number;
	/** A part of the year only (the run's edge). */
	partial: boolean;
	modelledM3: number;
}

/**
 * The run's whole water years within the band and outside it (over or
 * under), one count for the whole run: given only when the takes in force on
 * the run's units are the same rows on every day of the run, are exactly the
 * rows of today's total, and pass the 5-holder and dominance rules over it.
 * Otherwise null.
 */
export interface AllocationRunJudgement {
	wholeYears: number;
	within: number;
	outside: number;
}

export interface AllocationSourceTotals {
	waterSource: AllocationWaterSource;
	holders: number;
	/** Units with a registered volume on this source in the run. */
	units: number;
	years: AllocationYearTotal[];
	judgement: AllocationRunJudgement | null;
}

export interface AllocationComparisonTotals {
	tolerance: number;
	sources: AllocationSourceTotals[];
}

/** Whether `rows`' takes in force over [from, to] are the same rows on every day of it (none starts or ends inside). */
const steadyWithin = (rows: readonly VolumeRow[], from: string, to: string) =>
	rows.every((r) => !takesWithin(r, from, to) || ((!r.validFrom || r.validFrom <= from) && (!r.validTo || r.validTo >= to)));

/**
 * The run's modelled use summed per water source and water year over the
 * units that hold a registered volume (compareAllocations, then the sum),
 * with at most one judgement for the whole run (AllocationRunJudgement): no
 * registered m³ and no status per year. A source with fewer than 5 holders
 * isn't in `rows`, so it isn't here.
 */
export function comparisonTotals(input: {
	startDate: string;
	nodes: readonly AllocationUseNode[];
	tolerance: number;
	rows: readonly VolumeRow[];
	/** Today (ISO): the judgement is given only over the rows of today's total, which the viewer reads anyway. */
	today: string;
}): AllocationComparisonTotals {
	const holders = new Map(input.rows.map((r) => [r.waterSource, r.holders]));
	const allocations: AllocationEntry[] = input.rows.map((r, i) => ({
		id: `v${i}`,
		nodeId: r.nodeId,
		waterSource: r.waterSource,
		volumeM3PerYear: r.volumeM3PerYear,
		storageM3: r.storageM3,
		...(r.waterUse === '21b' ? { waterUse: '21b' as const } : {}),
		validFrom: r.validFrom,
		validTo: r.validTo
	}));
	const rowOf = new Map(allocations.map((a, i) => [a.id, input.rows[i]!]));
	const c: AllocationComparison = compareAllocations({ startDate: input.startDate, nodes: input.nodes, tolerance: input.tolerance, allocations });
	const sources = SOURCES.flatMap((src): AllocationSourceTotals[] => {
		if (!holders.has(src)) return [];
		const held = c.nodes.map((n) => n[src]).filter((s) => s.allocationIds.length > 0);
		// The rows summed into the source's years: those on the run's units (compareAllocations' allocationIds).
		const summed = held.flatMap((s) => s.allocationIds.map((id) => rowOf.get(id)!));
		const byYear = new Map<number, { waterYear: number; partial: boolean; registeredM3: number; modelledM3: number }>();
		for (const s of held)
			for (const y of s.years) {
				const t = byYear.get(y.waterYear) ?? { waterYear: y.waterYear, partial: y.partial, registeredM3: 0, modelledM3: 0 };
				t.registeredM3 += y.registeredM3;
				t.modelledM3 += y.modelledM3;
				t.partial ||= y.partial;
				byYear.set(y.waterYear, t);
			}
		const all = [...byYear.values()].sort((a, b) => a.waterYear - b.waterYear);
		const years = all.map((y): AllocationYearTotal => ({ waterYear: y.waterYear, partial: y.partial, modelledM3: y.modelledM3 }));
		const whole = all.filter((y) => !y.partial);
		// The rows judged against must be exactly today's total's (every take of the source in force today, matched or
		// not), in force all through the run: then the run's registered total is the one the viewer reads today, and a
		// judgement pooled over runs narrows nothing they don't already read. Any other set would difference against it (L, M).
		const inRun = new Set(summed.filter((r) => takesWithin(r, c.startDate, c.endDate)));
		const today = input.rows.filter((r) => r.waterSource === src && takesWithin(r, input.today, input.today));
		const sameAsToday = today.length === inRun.size && today.every((r) => inRun.has(r));
		const judged = whole.length > 0 && sameAsToday && steadyWithin(summed, c.startDate, c.endDate) && shownWithin(summed, c.startDate, c.endDate);
		const within = whole.filter((y) => allocationStatus(y.modelledM3, y.registeredM3, input.tolerance) === 'within').length;
		const judgement = judged ? { wholeYears: whole.length, within, outside: whole.length - within } : null;
		return [{ waterSource: src, holders: holders.get(src)!, units: held.length, years, judgement }];
	});
	return { tolerance: input.tolerance, sources };
}

type RunLike = {
	model?: { allocations?: unknown } | null;
	summary?: { allocations?: { nodes?: unknown[] } | null } | null;
	inputs?: { model?: { allocations?: unknown } | null; scenario?: { ops?: ScenarioOp[]; classified?: unknown[] } | null } | null;
};

/**
 * The positions of the ops a viewer who can't read each registered volume
 * doesn't get (issue #523 G1): every `allocation.set` (it carries a volume)
 * on a unit that isn't `own`. `own` is an application's own units, and none
 * for a team scenario or a run's recorded scenario (whose origin it doesn't
 * record): an editor's "what if farm X's licence is cut" quotes farm X's
 * volume. An `allocation.remove` carries only an id, so it stays.
 */
export function withheldAllocationOps(ops: readonly ScenarioOp[], own: readonly string[] = []): Set<number> {
	const mine = new Set(own);
	const out = new Set<number>();
	ops.forEach((op, i) => {
		if (op.op === 'allocation.set' && !(op.allocation.nodeId && mine.has(op.allocation.nodeId))) out.add(i);
	});
	return out;
}

/** `list` without the positions in `drop` (a scenario's ops, or its per-op classes). */
export const withoutPositions = <T>(list: readonly T[], drop: ReadonlySet<number>): T[] => list.filter((_, i) => !drop.has(i));

/**
 * A run as a viewer who can't read each registered volume gets it: no
 * allocation rows in its model (or inputs' model), its summary's
 * allocations without the per-unit part (the mode, band and counts stay),
 * a cap or full-allocation run's summary its verdicts and counts only
 * (verdictsSummary, #523 I), and its recorded scenario without the ops that carry a volume
 * (withheldAllocationOps, with their classes).
 */
export function redactRunAllocations<T extends RunLike>(run: T): T {
	const out = { ...run };
	if (out.model && 'allocations' in out.model) out.model = { ...out.model, allocations: [] };
	if (out.inputs?.model && 'allocations' in out.inputs.model) out.inputs = { ...out.inputs, model: { ...out.inputs.model, allocations: [] } };
	const sc = out.inputs?.scenario;
	if (sc?.ops) {
		const drop = withheldAllocationOps(sc.ops);
		if (drop.size)
			out.inputs = {
				...out.inputs!,
				scenario: { ...sc, ops: withoutPositions(sc.ops, drop), ...(sc.classified ? { classified: withoutPositions(sc.classified, drop) } : {}) }
			};
	}
	// A cap or full-allocation run: its verdicts and counts only (#523 I, ./verdictsOnly.ts).
	if (out.summary) out.summary = verdictsSummary(out.summary);
	if (out.summary?.allocations) out.summary = { ...out.summary, allocations: { ...out.summary.allocations, nodes: [] } };
	return out;
}

type ReportLike = {
	appendix: { baselineInputs: { model?: { allocations?: unknown } | null } | null };
	summaries: { baseline: { allocations?: { nodes?: unknown[] } | null } | null; application: { allocations?: { nodes?: unknown[] } | null } | null };
	ops?: { op: ScenarioOp }[];
	licenceImpactAuthorised?: { mix?: AuthorisedMix | AuthorisedMixShares | null; mixFolded?: AuthorisedMix | AuthorisedMixShares | null } | null;
	/** § 5 (EvidenceAllocations); typed loosely so a frozen manifest of any format passes. */
	allocations?: unknown;
	mode?: string;
	flags?: { id: string; text: string }[];
	rows?: { id: string }[];
};

/** A run mode that holds use to the registered volume: its modelled use is the volume wherever supply meets demand (#523 R5-2). */
const holdsToVolume = (mode: string | null | undefined) => mode === 'cap' || mode === 'fullAllocation';

/**
 * § 5 without the registered m³ of its totals of other units, per year, mean
 * or cap (#523 K/L/M): a viewer kept from each volume reads registered m³
 * only as today's per-source totals. Two sums over different rows read at
 * the same time (the baseline's and the application's year, two consecutive
 * years, a year and today's total) give the rows between them, often one
 * holder's. Nor their status per year or count of years over the band: at a
 * fixed band, pooled over the years of several runs, they pin the volume
 * (#523 round 6, operator's decision, provisional, #92). The modelled use
 * stays, except on a side whose run is in cap or full-allocation mode
 * (`modeA` / `modeB`), where it is the registered volume wherever supply met
 * demand (#523 R5-2). The applicant's own units stay.
 */
export function withoutOthersRegistered(al: EvidenceAllocations): EvidenceAllocations {
	if (!Array.isArray(al.units) || !al.units.some((u) => u.aggregate !== undefined)) return al;
	const hideA = holdsToVolume(al.modeA);
	const hideB = holdsToVolume(al.modeB);
	return {
		...al,
		othersRegisteredWithheld: true,
		...(hideA || hideB ? { othersUseWithheld: true as const } : {}),
		units: al.units.map((u) =>
			u.aggregate === undefined
				? u
				: {
						...u,
						sources: u.sources.map((src) => ({
							...src,
							meanRegisteredA: null,
							meanRegisteredB: null,
							capA: null,
							capB: null,
							// No status per year nor count of them (#523 round 6): pooled over runs at a fixed band, they pin the volume.
							countsA: null,
							countsB: null,
							...(hideA ? { meanModelledA: null } : {}),
							...(hideB ? { meanModelledB: null } : {}),
							years: src.years.map((y) => ({
								...y,
								registeredA: null,
								registeredB: null,
								statusA: null,
								statusB: null,
								...(hideA ? { modelledA: null } : {}),
								...(hideB ? { modelledB: null } : {})
							}))
						}))
					}
		)
	};
}

/**
 * Page 1's "above the registered volume" flag without the totals of other
 * units: it counts their whole years over the band, the same count § 5 leaves
 * out for such a viewer (#523 round 6). Rebuilt from the units listed one by
 * one; gone when none is over.
 */
function withoutOthersOver<F extends { id: string; text: string }>(flags: F[], al: EvidenceAllocations | undefined, app: boolean): F[] {
	if (!al || !Array.isArray(al.units) || !al.units.some((u) => u.aggregate !== undefined)) return flags;
	const text = allocationsOverFlag({ ...al, units: al.units.filter((u) => u.aggregate === undefined) }, app);
	return flags.flatMap((f) => (f.id !== 'allocationsOver' ? [f] : text ? [{ ...f, text }] : []));
}

/**
 * Page 1's "Registered vs modelled use" row and § 5's `unitYears` counted
 * over the units § 5 lists one by one only (the applicant's own), not every
 * unit (#523 G1c): each run's count of every unit's years over the band,
 * pooled over several team scenarios at a fixed band, bounds one unit's
 * volume, as the totals' statuses would (round 6). Rebuilt whether the other
 * units are in a total or left out (`othersLeftOut`); with no unit of the
 * applicant's own judged, the row says it is withheld.
 */
function withOwnUnitYears<R extends ReportLike>(report: R, al: EvidenceAllocations): { allocations: EvidenceAllocations; rows?: R['rows'] } {
	const app = report.mode === 'application';
	const ownOnly = () => ({ ...al, unitYears: ownUnitYears(al, app) });
	const rows = report.rows?.map((r) => (r.id === 'registeredUse' ? (registeredUseRow(ownOnly(), app, { ownOnly: true }) satisfies EvidenceRow) : r));
	// A document without `unitYears` (before evidence-15) keeps none: its row is rebuilt above all the same.
	return { allocations: al.unitYears ? ownOnly() : al, ...(rows ? { rows: rows as R['rows'] } : {}) };
}

/**
 * Whether a frozen report's page-1 "Registered vs modelled use" row counts
 * units other than those § 5 lists one by one (#523 G1c): its PDF prints that
 * count, which a viewer kept from each volume isn't given (packWithheldPart).
 * A report without `unitYears` (before evidence-15) counts the units § 5
 * lists, which are every unit.
 */
export function countsOthersYears(report: Pick<ReportLike, 'allocations' | 'mode'>): boolean {
	const al = report.allocations as EvidenceAllocations | undefined;
	if (!al || !Array.isArray(al.units) || !al.unitYears || al.notAssessed) return false;
	const own = ownUnitYears(al, report.mode === 'application');
	const uy = al.unitYears;
	return uy.judgedA !== own.judgedA || uy.overA !== own.overA || (uy.judgedB ?? 0) !== (own.judgedB ?? 0) || (uy.overB ?? 0) !== (own.overB ?? 0);
}

/**
 * An evidence report as a viewer who can't read each registered volume gets
 * it (issue #523 G1): Appendix A.1's baseline model without its allocation
 * rows, each run summary's allocations without the per-unit part, as
 * redactRunAllocations leaves a run, the ops that set a volume on a unit
 * that isn't `own` (an applicant's application's own units; none for a team
 * scenario) left out, and page 1's authorised volume mix replaced by its
 * folded one as whole-percent shares with no m³ (`mixFolded`: shares since
 * evidence-18, an evidence-17 board's m³ turned into its shares by
 * mixShares; none for a board built before, #523 H/J). § 5 lists only the
 * applicant's own units (`evidence-15`; none of a team scenario's since
 * `evidence-17`), the rest as totals, whose registered m³ is left out
 * (withoutOthersRegistered, #523 K/L/M): their modelled use stays; page 1's
 * "Registered vs modelled use" row and `unitYears` count the listed units
 * only (withOwnUnitYears, #523 G1c).
 * A report on a cap or full-allocation run is then its verdicts and counts
 * only (verdictsReport), and on every report the licence-impact boards give
 * their verdicts without the waterfall's use totals (boardVerdicts; the
 * authorised board runs at full allocation on every application, #523 I).
 * A frozen pack manifest redacted this way no longer hashes to
 * its manifestSha256, so the caller says so (packs.ts `volumesWithheld`).
 * Appendix A.2's input diff is the caller's: the live report builds it
 * without other units' volumes (evidence/report.ts), and an issuable pack's
 * can only change the applicant's own (any other is a baseline assumption,
 * which blocks a draft).
 */
export function redactReportAllocations<R extends ReportLike>(report: R, own: readonly string[] = []): R {
	const bi = report.appendix.baselineInputs;
	const summary = <S extends ReportLike['summaries']['baseline']>(s: S): S => (s ? redactRunAllocations({ summary: s }).summary! : s);
	const drop = report.ops ? withheldAllocationOps(report.ops.map((o) => o.op), own) : new Set<number>();
	const lia = report.licenceImpactAuthorised;
	const out = {
		...report,
		...(report.ops ? { ops: withoutPositions(report.ops, drop) } : {}),
		// The folded mix's shares in the full one's place (no m³: #523 H/J), or none: a board built before evidence-17 has no folded one; its verdicts without the waterfall (#523 I), and without the pair's reproduction record (#523 G2).
		...(lia ? { licenceImpactAuthorised: authorisedVerdicts((({ mixFolded, ...rest }) => ({ ...rest, mix: mixFolded ? mixShares(mixFolded) : null }))(lia)) } : {}),
		...('licenceImpact' in report ? { licenceImpact: boardVerdicts((report as { licenceImpact?: unknown }).licenceImpact) } : {}),
		appendix: { ...report.appendix, baselineInputs: bi ? redactRunAllocations({ inputs: bi }).inputs! : bi },
		// A combined dam's yield on a run that rests on the registered volumes: its direction only (evidence-26).
		...('cumulative' in report ? { cumulative: combinedDamVerdicts((report as { cumulative?: unknown }).cumulative, false) } : {}),
		summaries: { ...report.summaries, baseline: summary(report.summaries.baseline), application: summary(report.summaries.application) },
		...(Array.isArray((report.allocations as EvidenceAllocations | undefined)?.units)
			? withOwnUnitYears(report, withoutOthersRegistered(report.allocations as EvidenceAllocations))
			: report.allocations
				? { allocations: report.allocations }
				: {}),
		...(report.flags ? { flags: withoutOthersOver(report.flags, report.allocations as EvidenceAllocations | undefined, report.mode === 'application') } : {})
	};
	// A report on a cap or full-allocation run: its verdicts and counts only (#523 I).
	return verdictsReport(out as unknown as Parameters<typeof verdictsReport>[0]) as unknown as R;
}

/** The allocation events' fields about the registered user's allocation, not about whoever made the change. */
export const ALLOCATION_EVENT_IDENTIFIERS = ['registrationNo', 'volumeM3PerYear'] as const;

/**
 * An audit event as the data-subject export carries it: an allocation event
 * (allocation.created / changed / deleted) without the allocation's
 * registration number, a unique identifier (POPIA s1), or its volume. They
 * are the registered user's, not the exporting person's; what the person did
 * stays. The History leaves them out for a viewer in the database
 * (app_audit_subject, 190).
 */
export function withoutAllocationIdentifiers<T>(event: T): T {
	if (!event || typeof event !== 'object') return event;
	const e = event as { kind?: unknown; subject?: unknown };
	if (typeof e.kind !== 'string' || !e.kind.startsWith('allocation.') || !e.subject || typeof e.subject !== 'object') return event;
	const subject = { ...(e.subject as Record<string, unknown>) };
	for (const k of ALLOCATION_EVENT_IDENTIFIERS) delete subject[k];
	return { ...event, subject };
}
