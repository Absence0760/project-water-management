// What a project's viewers read of its registered volumes (decision D3,
// provisional position, pre-counsel research 2026-10-01; 162_allocation_viewer_units.sql,
// docs/allocations.md § Who sees what).
//
// Owners and editors read every allocation. A viewer reads each farm's
// volumes only when an owner has switched project.allocations_viewer_units
// on; otherwise RLS gives a viewer no allocation row, and the API serves
// totals per water source instead, summed here from app_allocation_volumes
// (which returns a source's rows only when 5 or more registered users hold
// it). The run's own copy of the rows (its model's `allocations`, the
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
	type ScenarioOp
} from '@water-management/engine';
import { requestAuth } from '../auth/stepUp.js';
import type { Db } from '../db/tx.js';
import type { Role } from '../projects/access.js';
import { boardVerdicts, verdictsReport, verdictsSummary } from './verdictsOnly.js';

/** A viewer on a project whose owners haven't let viewers read each registered volume. */
export async function allocationUnitsHidden(db: Db, projectId: string, role: Role): Promise<boolean> {
	// A report render queued without registered volumes (214, #523 G1): every project, whatever the role.
	if (requestAuth.getStore()?.redactAllocations) return true;
	if (role !== 'viewer') return false;
	const { rows } = await db.query<{ on: boolean }>('SELECT app_allocations_viewer_units($1) AS "on"', [projectId]);
	return !rows[0]?.on;
}

/** One row behind a viewer's totals (app_allocation_volumes): no name, number or property. */
export interface VolumeRow {
	waterSource: AllocationWaterSource;
	holders: number;
	nodeId: string | null;
	volumeM3PerYear: number;
	storageM3: number | null;
	waterUse: '21a' | '21b';
	validFrom: string | null;
	validTo: string | null;
}

export async function loadVolumes(db: Db, projectId: string): Promise<VolumeRow[]> {
	const { rows } = await db.query<VolumeRow>(
		`SELECT water_source AS "waterSource", holders, node_id AS "nodeId", volume_m3_year AS "volumeM3PerYear", storage_m3 AS "storageM3",
			water_use AS "waterUse", to_char(valid_from, 'YYYY-MM-DD') AS "validFrom", to_char(valid_to, 'YYYY-MM-DD') AS "validTo"
		 FROM app_allocation_volumes($1)`,
		[projectId]
	);
	return rows;
}

/** A water source's registered volumes in force on a day, summed: what a viewer reads instead of the list. */
export interface AllocationTotal {
	waterSource: AllocationWaterSource;
	/** Registered users holding this source (5 or more, or it isn't returned). */
	holders: number;
	/** Volumes in force that day, m³ a year (takes only; a 21b row is storage). */
	registeredM3PerYear: number;
	/** Registered storage in force that day, m³; null when none states one. */
	storageM3: number | null;
}

const inForce = (r: Pick<VolumeRow, 'validFrom' | 'validTo'>, day: string) => (!r.validFrom || r.validFrom <= day) && (!r.validTo || r.validTo >= day);
const SOURCES: readonly AllocationWaterSource[] = ['surface', 'groundwater'];

export function volumeTotals(rows: readonly VolumeRow[], day: string): AllocationTotal[] {
	return SOURCES.flatMap((src) => {
		const mine = rows.filter((r) => r.waterSource === src);
		if (!mine.length) return [];
		const now = mine.filter((r) => inForce(r, day));
		const storages = now.filter((r) => r.storageM3 !== null);
		return [
			{
				waterSource: src,
				holders: mine[0]!.holders,
				registeredM3PerYear: now.filter((r) => r.waterUse !== '21b').reduce((s, r) => s + r.volumeM3PerYear, 0),
				storageM3: storages.length ? storages.reduce((s, r) => s + r.storageM3!, 0) : null
			}
		];
	});
}

/** One water year of a source's use, summed over the units with a volume on it. */
export interface AllocationYearTotal {
	waterYear: number;
	/** A part of the year only (the run's edge): listed, not judged. */
	partial: boolean;
	registeredM3: number;
	modelledM3: number;
	status: AllocationStatus;
}

export interface AllocationSourceTotals {
	waterSource: AllocationWaterSource;
	holders: number;
	/** Units with a registered volume on this source in the run. */
	units: number;
	years: AllocationYearTotal[];
}

export interface AllocationComparisonTotals {
	tolerance: number;
	sources: AllocationSourceTotals[];
}

/**
 * The run's modelled use against the registered volumes, summed per water
 * source and water year over the units that hold one (compareAllocations,
 * then the sum). A source with fewer than 5 holders isn't in `rows`, so it
 * isn't here.
 */
export function comparisonTotals(input: { startDate: string; nodes: readonly AllocationUseNode[]; tolerance: number; rows: readonly VolumeRow[] }): AllocationComparisonTotals {
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
	const c: AllocationComparison = compareAllocations({ startDate: input.startDate, nodes: input.nodes, tolerance: input.tolerance, allocations });
	const sources = SOURCES.flatMap((src): AllocationSourceTotals[] => {
		if (!holders.has(src)) return [];
		const held = c.nodes.map((n) => n[src]).filter((s) => s.allocationIds.length > 0);
		const byYear = new Map<number, AllocationYearTotal>();
		for (const s of held)
			for (const y of s.years) {
				const t = byYear.get(y.waterYear) ?? { waterYear: y.waterYear, partial: y.partial, registeredM3: 0, modelledM3: 0, status: 'none' as AllocationStatus };
				t.registeredM3 += y.registeredM3;
				t.modelledM3 += y.modelledM3;
				t.partial ||= y.partial;
				byYear.set(y.waterYear, t);
			}
		const years = [...byYear.values()].sort((a, b) => a.waterYear - b.waterYear).map((y) => ({ ...y, status: allocationStatus(y.modelledM3, y.registeredM3, input.tolerance) }));
		return [{ waterSource: src, holders: holders.get(src)!, units: held.length, years }];
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
	licenceImpactAuthorised?: { mix?: { folded?: true } | null; mixFolded?: unknown } | null;
};

/**
 * An evidence report as a viewer who can't read each registered volume gets
 * it (issue #523 G1): Appendix A.1's baseline model without its allocation
 * rows, each run summary's allocations without the per-unit part, as
 * redactRunAllocations leaves a run, the ops that set a volume on a unit
 * that isn't `own` (an applicant's application's own units; none for a team
 * scenario) left out, and page 1's authorised volume mix replaced by its
 * folded one (`mixFolded`, evidence-17; none for a board built before). A
 * report on a cap or full-allocation run is then its verdicts and counts
 * only (verdictsReport), and on every report the licence-impact boards give
 * their verdicts without the waterfall's use totals (boardVerdicts; the
 * authorised board runs at full allocation on every application, #523 I). § 5 stays:
 * since `evidence-15` it lists only the applicant's own units, the rest as
 * totals at 5 or more units (and since `evidence-17` none of a team
 * scenario's). A frozen pack manifest redacted this way no longer hashes to
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
		// The folded mix in the full one's place (evidence-17), or none: a board built before has no folded one.
		...(lia ? { licenceImpactAuthorised: boardVerdicts((({ mixFolded, ...rest }) => ({ ...rest, mix: (mixFolded ?? null) as typeof lia.mix }))(lia)) } : {}),
		...('licenceImpact' in report ? { licenceImpact: boardVerdicts((report as { licenceImpact?: unknown }).licenceImpact) } : {}),
		appendix: { ...report.appendix, baselineInputs: bi ? redactRunAllocations({ inputs: bi }).inputs! : bi },
		summaries: { ...report.summaries, baseline: summary(report.summaries.baseline), application: summary(report.summaries.application) }
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
