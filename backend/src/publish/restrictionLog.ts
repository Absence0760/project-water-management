// The restriction log (docs/followups.md "A log of restriction decisions", the
// WUA persona): every restriction the WUA published or changed, when, by whom,
// on which run, for its members and the responsible authority.
//
// Read from the season decision log (decision.ts): the `publication.published`
// and `publication.notice_changed` audit events, not run_publication. That
// table keeps only the newest PUBLICATION_HISTORY_MAX (12) publications
// (run_publication_cap, 022), while audit_event is append-only and kept for
// the life of the project (030), so no decision drops off this list. A change
// to the modeller's note alone isn't a restriction decision and is left out
// (History lists it). Staff only, as the audit log is: viewers and above
// (RLS, 030); a farmer reads the notice on their farm page and the levels in
// GET …/publication's history, never this.
import type { NoticeText, RestrictionLevel } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { csvRow } from '../export/csv.js';

/** Most decisions per page of GET …/restriction-log. */
export const RESTRICTION_LOG_PAGE_MAX = 100;
const RESTRICTION_LOG_PAGE_DEFAULT = 50;

/** `before`: the previous page's `next`, "<created_at to the microsecond>|<event id>". */
export const RestrictionLogQuery = z.object({
	before: z
		.string()
		.max(60)
		.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[1-9]\d{0,17}$/, 'not a restriction log cursor')
		.transform((s) => {
			const [ts, id] = s.split('|') as [string, string];
			return { ts, id };
		})
		.optional(),
	limit: z.coerce.number().int().min(1).max(RESTRICTION_LOG_PAGE_MAX).default(RESTRICTION_LOG_PAGE_DEFAULT)
});

/** One restriction decision: a publication, or a change to the notice of the publication then current. */
export interface RestrictionDecision {
	/** The audit event's id. */
	id: string;
	kind: 'published' | 'notice_changed';
	/** When it was made (ISO, UTC). */
	at: string;
	/** Who made it, as their name read then ('Deleted user' once that account is gone); null when no one is named (an auto run's own publish). */
	by: string | null;
	/** An auto run published by itself (autoPublish.ts). */
	auto: boolean;
	publicationId: string | null;
	runId: string | null;
	restriction: {
		level: RestrictionLevel | null;
		pct: number | null;
		/** The notice in each language it was written in; null when the event is older than the decision log (issue #119) and kept no text. */
		notice: NoticeText | null;
	};
	/** The next publication date announced; undefined when the event kept none (older than the decision log). */
	nextExpectedOn?: string | null;
	/** The modeller's note as it then stood (staff only, as the whole log is); undefined when the event kept none. */
	note?: string;
	/** A notice change: which parts were sent ('restriction', 'nextExpectedOn', 'note'). */
	fields?: string[];
	/** A publication: how many hydrological units got their figures. */
	farms: number | null;
	/** The season the published figures cover; null when the event kept none. */
	season: { from: string; to: string; dataUntil: string | null } | null;
	/** Whether the publication is still the current one (its notice is what farmers read now). */
	current: boolean;
	/** Whether the run is still kept, so the page can link to it (runs are trimmed by the run cap). */
	runKept: boolean;
}

interface Row {
	id: string;
	ts: string;
	kind: 'publication.published' | 'publication.notice_changed';
	actor: string;
	subject: Record<string, unknown>;
	current: boolean;
	run_kept: boolean;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const LEVELS: readonly RestrictionLevel[] = ['none', 'advisory', 'restricted'];

export function toDecision(r: Row): RestrictionDecision {
	const s = r.subject;
	const res = rec(s.restriction);
	const level = LEVELS.find((l) => l === res.level) ?? null;
	const w = rec(s.window);
	const season = rec(w.season);
	const notice = 'notice' in res ? (Object.fromEntries(Object.entries(rec(res.notice)).filter(([, t]) => typeof t === 'string' && t)) as NoticeText) : null;
	return {
		id: String(r.id),
		kind: r.kind === 'publication.published' ? 'published' : 'notice_changed',
		at: r.ts,
		by: r.actor || null,
		auto: s.auto === true,
		publicationId: str(s.publicationId),
		runId: str(s.runId),
		restriction: { level, pct: num(res.pct), notice },
		...('nextExpectedOn' in s ? { nextExpectedOn: str(s.nextExpectedOn) } : {}),
		...('note' in s ? { note: typeof s.note === 'string' ? s.note : '' } : {}),
		...(Array.isArray(s.fields) ? { fields: s.fields.filter((f): f is string => typeof f === 'string') } : {}),
		farms: num(s.farms),
		season: str(season.from) && str(season.to) ? { from: str(season.from)!, to: str(season.to)!, dataUntil: str(w.dataUntil) } : null,
		current: r.current,
		runKept: r.run_kept
	};
}

const TS = `to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// A uuid read from a subject, or NULL: a subject is jsonb, and a cast of anything else would abort the page.
const subjectUuid = (key: string) => `CASE WHEN e.subject->>'${key}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (e.subject->>'${key}')::uuid END`;

/** The decisions' rows, newest first, `limit` of them (null: every one), before the cursor. */
async function decisionRows(db: Db, projectId: string, before: { ts: string; id: string } | null, limit: number | null): Promise<Row[]> {
	const { rows } = await db.query<Row>(
		`SELECT e.id, ${TS} AS ts, e.kind, e.actor_label AS actor, app_audit_subject(e.project_id, e.kind, e.subject) AS subject,
			EXISTS (SELECT 1 FROM run_publication p WHERE p.project_id = e.project_id AND p.id = ${subjectUuid('publicationId')} AND p.superseded_at IS NULL) AS current,
			EXISTS (SELECT 1 FROM model_run r WHERE r.project_id = e.project_id AND r.id = ${subjectUuid('runId')}) AS run_kept
		 FROM audit_event e
		 WHERE e.project_id = $1 AND e.kind IN ('publication.published', 'publication.notice_changed')
			AND NOT (e.kind = 'publication.notice_changed' AND jsonb_typeof(e.subject->'fields') = 'array'
				AND NOT (e.subject->'fields' ?| ARRAY['restriction', 'nextExpectedOn']))
			AND ($2::timestamptz IS NULL OR (e.created_at, e.id) < ($2::timestamptz, $3::bigint))
		 ORDER BY e.created_at DESC, e.id DESC
		 LIMIT $4`,
		[projectId, before?.ts ?? null, before?.id ?? null, limit]
	);
	return rows;
}

/**
 * One page of the project's restriction decisions, newest first, as the
 * caller may read them (the caller's transaction: RLS shows the audit log to
 * viewers and above only). A notice change that sent only the note is left
 * out. `next` is the cursor of the following page, null on the last.
 */
export async function restrictionLog(db: Db, projectId: string, q: z.infer<typeof RestrictionLogQuery>): Promise<{ items: RestrictionDecision[]; next: string | null }> {
	const rows = await decisionRows(db, projectId, q.before ?? null, q.limit + 1);
	const more = rows.length > q.limit;
	const page = rows.slice(0, q.limit);
	const last = page.at(-1);
	return { items: page.map(toDecision), next: more && last ? `${last.ts}|${last.id}` : null };
}

/** Most decisions one CSV export reads (a WUA publishing weekly makes ~50 a year); past it the export is refused, never cut short. */
export const RESTRICTION_LOG_EXPORT_MAX = 20_000;

/** Every restriction decision, newest first (the CSV export: the whole log, not a page), or null past RESTRICTION_LOG_EXPORT_MAX. */
export async function restrictionLogAll(db: Db, projectId: string): Promise<RestrictionDecision[] | null> {
	const rows = await decisionRows(db, projectId, null, RESTRICTION_LOG_EXPORT_MAX + 1);
	return rows.length > RESTRICTION_LOG_EXPORT_MAX ? null : rows.map(toDecision);
}

/** The notice's language codes across the log: English first, then the rest in code order (one CSV column each). */
export function noticeCodes(items: readonly RestrictionDecision[]): string[] {
	const codes = new Set<string>();
	for (const d of items) for (const k of Object.keys(d.restriction.notice ?? {})) codes.add(k);
	return [...codes].sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)));
}

/**
 * The restriction log as CSV lines (docs/api.md § Publication): one row per decision, newest first, as the page
 * shows them, for handing to the responsible authority. `in_force` marks the newest decision of the current
 * publication (the page's In force). The staff note is in it, as on the page (viewers and above only); never a
 * unit's figures, only how many units a publication went to. Text cells are csvRow's (formula-looking text
 * prefixed with an apostrophe).
 */
export function restrictionLogCsvLines(items: readonly RestrictionDecision[]): string[] {
	const codes = noticeCodes(items);
	const inForce = items.find((d) => d.current)?.id ?? null;
	const yes = (b: boolean) => (b ? 'yes' : 'no');
	return [
		csvRow([
			'decided_at_utc',
			'decision',
			'changed',
			'by',
			'automatic',
			'level',
			'restriction_pct',
			'in_force',
			...codes.map((c) => `notice_${c}`),
			'notice_recorded',
			'next_expected_on',
			'season_from',
			'season_to',
			'data_until',
			'hydrological_units',
			'staff_note',
			'run_id',
			'run_kept',
			'publication_id'
		]),
		...items.map((d) =>
			csvRow([
				d.at,
				d.kind,
				(d.fields ?? []).join(' | '),
				d.by ?? '',
				yes(d.auto),
				d.restriction.level ?? '',
				d.restriction.pct,
				d.id === inForce ? 'yes' : 'no',
				...codes.map((c) => d.restriction.notice?.[c as keyof NoticeText] ?? ''),
				yes(d.restriction.notice !== null),
				d.nextExpectedOn ?? '',
				d.season?.from ?? '',
				d.season?.to ?? '',
				d.season?.dataUntil ?? '',
				d.farms,
				d.note ?? '',
				d.runId ?? '',
				yes(d.runKept),
				d.publicationId ?? ''
			])
		)
	];
}
