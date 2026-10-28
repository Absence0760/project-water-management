// Read-only production checks (docs/deployment.md § Read-only production
// checks). RDS is private and has no bastion, so a question the operator must
// ask of production data goes through the migrate Lambda, the one function
// that can reach the database as the schema owner: an event
// `{ "check": "<name>" }` runs the named query of the registry below, and
// nothing else. The event names a check; it never carries SQL, parameters or
// any other field (parseCheckRequest refuses one that does), so the Lambda
// can't be made to run a query that isn't reviewed here.
//
// Each check runs inside a READ ONLY transaction (any write, sequence or
// function that writes fails, SQLSTATE 25006) with a statement timeout, and
// answers with ids, engine versions, modes and dates only: never a person's
// name, an email, a volume, a note or any other figure, so its answer is safe
// to paste into an issue. The one exception is series-pick-moves, whose
// answer is the series names themselves (project data, not personal data:
// the gauge or feed a series came from). A check lists at most CHECK_ROWS_MAX rows and says whether
// it held back more (`truncated`, `count` is the total).
//
// Adding a check: one entry below, its SQL selecting only `columns`, a DB
// test planting a row it must find and one it must not
// (readOnlyChecks.db.test.ts), and its command and meaning in deployment.md.
import type pg from 'pg';

export interface ReadOnlyCheck {
	/** What it finds, for the CloudWatch log. */
	readonly about: string;
	/** The query: SELECT only, no parameters, its columns exactly `columns`. */
	readonly sql: string;
	/** The columns returned, in order; ids, versions, modes, dates and flags only (series-pick-moves: series names too). */
	readonly columns: readonly string[];
	/** The ORDER BY of the outer query (the subquery's own order isn't kept). */
	readonly orderBy: string;
}

/** The most rows a check returns; `count` is the total either way. */
export const CHECK_ROWS_MAX = 500;
/** Each check's statement timeout. The Lambda's own is 900 s. */
export const CHECK_STATEMENT_TIMEOUT = '120s';

export const CHECKS = {
	// Issue #500: engines 1.80.0–1.84.0 levelled a unit's CHIRPS with a reference
	// gauge set by × unit MAP ÷ the reference unit's MAP, replaced by k_unit in
	// 1.85.0 (engine-audit.md U1). docs/followups.md § Blocking releases.
	'unit-rain-reference-runs': {
		about: 'runs on engines 1.80.0–1.84.0 with per-unit rain levelled by a reference gauge (issue #500)',
		sql: `SELECT r.id AS run_id, r.project_id, r.engine_version, r.created_at
			FROM model_run r
			WHERE r.engine_version IN ('1.80.0', '1.81.0', '1.82.0', '1.83.0', '1.84.0')
			  AND r.inputs->'settings'->'unitRain'->>'mode' = 'perUnit'
			  AND jsonb_typeof(r.inputs->'settings'->'unitRain'->'reference') = 'object'`,
		columns: ['run_id', 'project_id', 'engine_version', 'created_at'],
		orderBy: 'created_at, run_id'
	},
	// Issue #523 finding I: a run that caps use at, or scales demand to, the
	// registered volumes (allocationMode cap or fullAllocation) rests on them
	// everywhere, so its farm views carry each farm's figures worked out from
	// its volume. Since 213 the baseline compares only and the API refuses to
	// publish such a run or start an outlook on one, so only one from before
	// 213 can be found here (the check doesn't filter on a date: one from after
	// would be a bug, and should show). One row per run publication, outlook
	// and outlook publication on such a run; `current` is whether farmers see
	// it now (a publication not superseded, an outlook publication not ended,
	// an outlook with a current publication). An outlook publication whose
	// outlook was trimmed (outlook_id SET NULL) has lost its run and can't be
	// found.
	'pre-213-cap-runs': {
		about: 'cap or full-allocation runs published, or used as an outlook’s base (issue #523 finding I)',
		sql: `WITH capped AS (
				SELECT id, project_id, engine_version, created_at, summary->'allocations'->>'mode' AS mode
				FROM model_run
				WHERE summary->'allocations'->>'mode' IN ('cap', 'fullAllocation')
			)
			SELECT 'run_publication' AS kind, p.id, c.project_id, c.id AS run_id, c.mode, c.engine_version,
				c.created_at AS run_created_at, p.published_at AS at, p.superseded_at IS NULL AS current
			FROM run_publication p JOIN capped c ON c.id = p.run_id
			UNION ALL
			SELECT 'seasonal_outlook', o.id, c.project_id, c.id, c.mode, c.engine_version,
				c.created_at, o.created_at,
				EXISTS (SELECT 1 FROM outlook_publication op WHERE op.outlook_id = o.id AND op.ended_at IS NULL)
			FROM seasonal_outlook o JOIN capped c ON c.id = o.base_run_id
			UNION ALL
			SELECT 'outlook_publication', op.id, c.project_id, c.id, c.mode, c.engine_version,
				c.created_at, op.published_at, op.ended_at IS NULL
			FROM outlook_publication op
			JOIN seasonal_outlook o ON o.id = op.outlook_id
			JOIN capped c ON c.id = o.base_run_id`,
		columns: ['kind', 'id', 'project_id', 'run_id', 'mode', 'engine_version', 'run_created_at', 'at', 'current'],
		orderBy: 'current DESC, project_id, at, id'
	},
	// Issue #523: a run reads the first series of a kind (at a site) by name,
	// and production sorted names linguistically until the backend that sorts
	// them by byte (COLLATE "C"; data-model.md § Which series a run reads). One
	// row per project, kind and site whose first series differs between the
	// two orders: `was` and `will` are its series names in each order, so the
	// operator can tell the owner which series its runs will read. The answer
	// depends only on series names, so it can run straight after that deploy.
	'series-pick-moves': {
		about: 'projects whose series pick moves when names sort by byte (issue #523)',
		sql: `SELECT project_id, kind, site_node_id,
				array_agg(name ORDER BY name) AS was,
				array_agg(name ORDER BY name COLLATE "C") AS will
			FROM time_series
			GROUP BY project_id, kind, site_node_id
			HAVING count(*) > 1
			   AND (array_agg(name ORDER BY name))[1] <> (array_agg(name ORDER BY name COLLATE "C"))[1]`,
		columns: ['project_id', 'kind', 'site_node_id', 'was', 'will'],
		orderBy: 'project_id, kind, site_node_id NULLS FIRST'
	},
	// Issue #523 G5: 229 carried every "acts for the authority" flag an owner
	// had set over as a confirmed delegate, each with an
	// authority.grandfathered event. Each authority reviews its list
	// (deployment.md runbook step 18). The person is answered by id only: the
	// operator finds their name in the project's members list in the app.
	'authority-grandfathered': {
		about: 'delegates 229 grandfathered, per project (issue #523 G5)',
		sql: `SELECT e.project_id, e.subject->>'userId' AS user_id, e.created_at
			FROM audit_event e
			WHERE e.kind = 'authority.grandfathered'`,
		columns: ['project_id', 'user_id', 'created_at'],
		orderBy: 'project_id, created_at, user_id'
	},
	// Issue #604 R3-D: what each reference dataset and tile archive was last
	// loaded from (248_reference_load_provenance), for a refresh's conditional
	// request (the recorded ETag and Last-Modified) and to check an upload
	// (our SHA-256). Reference data's provenance, no project or person in it.
	// docs/deployment.md § Reference datasets, Refreshing a dataset.
	'reference-provenance': {
		about: 'each reference dataset’s and tile archive’s recorded file and upstream (issue #604 R3-D)',
		sql: `SELECT kind, dataset, source_sha256, upstream_version, upstream_etag, upstream_last_modified, jsonb_array_length(coalesce(originals, '[]')) AS originals, loaded_at
			FROM reference_load`,
		columns: ['kind', 'dataset', 'source_sha256', 'upstream_version', 'upstream_etag', 'upstream_last_modified', 'originals', 'loaded_at'],
		orderBy: 'kind, dataset'
	},
	// Issue #618 step 6d (docs/deployment.md § DWS gauge records, Which
	// stations need the reply first): before dws_source = "store", every river
	// gauge an enabled DWS feed reads must be covered by some source's span
	// (247 gauge_record_span, origin dws) from the first day its feeds still
	// ask for, or those feeds wait. needed_from is, per feed, the day after
	// its newest day or two years back, whichever is earlier (a backfill
	// resumes after its newest day; a caught-up feed re-reads inside the
	// weekly pass's two years), else its startDate, else ten years back
	// (fetch.ts fetchWindow: DWS_FIRST_YEARS, DWS_WINDOW_DAYS), never before
	// its startDate; the station's is the earliest of its feeds'. hole_days counts the days from
	// needed_from to covered_to that no span covers (first_hole the first),
	// null when nothing covers the station at all; days_behind is today in
	// South Africa less covered_to. Covered: hole_days 0 and days_behind about
	// a week or less. Station codes, dates and counts only: a public DWS gauge
	// code, but paste "covered" or not into an issue, never the codes (they
	// point at the client's catchment, and the repo is public).
	'dws-coverage': {
		about: 'each river gauge enabled DWS feeds read, and the days the gauge record store covers for it (issue #618 step 6d)',
		sql: `WITH t AS (SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date AS today),
			feeds AS (
				SELECT f.config ->> 'station' AS station,
					greatest(
						CASE WHEN f.last_data_date IS NULL THEN coalesce((f.config ->> 'startDate')::date, t.today - 3650)
							ELSE least(f.last_data_date + 1, t.today - 729) END,
						coalesce((f.config ->> 'startDate')::date, date '1900-01-01')
					) AS needed_from
				FROM data_feed f CROSS JOIN t
				WHERE f.source = 'dws' AND f.enabled AND (f.config ->> 'station') ~ '^[A-Z][0-9]H[0-9]{3}$'
			),
			need AS (SELECT station, min(needed_from) AS needed_from FROM feeds GROUP BY station),
			spans AS (
				SELECT n.station, n.needed_from, greatest(s.day_from, n.needed_from) AS a, s.day_to AS b,
					max(s.day_to) OVER (PARTITION BY n.station ORDER BY greatest(s.day_from, n.needed_from), s.day_to
						ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS before_to
				FROM need n JOIN gauge_record_span s ON s.origin = 'dws' AND s.station = n.station AND s.day_to >= n.needed_from
			)
			SELECT n.station,
				to_char(n.needed_from, 'YYYY-MM-DD') AS needed_from,
				to_char(min(sp.a), 'YYYY-MM-DD') AS covered_from,
				to_char(max(sp.b), 'YYYY-MM-DD') AS covered_to,
				CASE WHEN count(sp.a) = 0 THEN NULL
					ELSE sum(greatest(sp.a - coalesce(sp.before_to, n.needed_from - 1) - 1, 0))::int END AS hole_days,
				to_char(min(CASE WHEN sp.a - coalesce(sp.before_to, n.needed_from - 1) - 1 > 0 THEN coalesce(sp.before_to + 1, n.needed_from) END), 'YYYY-MM-DD') AS first_hole,
				(SELECT today FROM t) - max(sp.b) AS days_behind
			FROM need n LEFT JOIN spans sp ON sp.station = n.station
			GROUP BY n.station, n.needed_from`,
		columns: ['station', 'needed_from', 'covered_from', 'covered_to', 'hole_days', 'first_hole', 'days_behind'],
		orderBy: 'station'
	}
} as const satisfies Record<string, ReadOnlyCheck>;

export type CheckName = keyof typeof CHECKS;

export type CheckErrorCode = 'refused' | 'check_failed';

/** A failed check. `message` goes to CloudWatch; `publicReason` is fixed text, safe to print. */
export class CheckError extends Error {
	constructor(
		message: string,
		readonly code: CheckErrorCode,
		readonly publicReason: string | null = null
	) {
		super(message);
		this.name = 'CheckError';
	}
}

const refused = (reason: string) => new CheckError(reason, 'refused', reason);

/**
 * The check an event asks for. The event is exactly `{ check: "<name>" }`
 * with a name in `registry`: any other field (`sql`, `params`, `load`, …),
 * a name that isn't a string, or an unknown name is refused before anything
 * connects.
 */
export function parseCheckRequest<R extends Record<string, ReadOnlyCheck>>(event: unknown, registry: R = CHECKS as unknown as R): keyof R & string {
	if (!event || typeof event !== 'object' || Array.isArray(event)) throw refused('the event is not an object');
	const keys = Object.keys(event);
	if (keys.length !== 1 || keys[0] !== 'check') throw refused('a check event has one field, check, naming the check; it takes no SQL or parameters');
	const name = (event as { check: unknown }).check;
	if (typeof name !== 'string' || !Object.hasOwn(registry, name)) {
		throw refused(`check must be one of ${Object.keys(registry).join(', ')}`);
	}
	return name;
}

export interface CheckResult {
	check: string;
	/** Every row the query found (also when `rows` holds fewer). */
	count: number;
	truncated: boolean;
	rows: Record<string, CheckCell>[];
}

/** One value of a check's answer. A list (series-pick-moves' names) stays a list of text. */
export type CheckCell = string | boolean | string[] | null;

/** A column's value as the answer carries it: a date as ISO 8601, a flag as itself, a list as a list of text, anything else as text. */
function cell(v: unknown): CheckCell {
	if (v === null || v === undefined) return null;
	if (Array.isArray(v)) return v.map((x) => String(x));
	if (v instanceof Date) return v.toISOString();
	if (typeof v === 'boolean' || typeof v === 'string') return v;
	return String(v);
}

/**
 * Run one check of `registry` on `client` inside a READ ONLY transaction,
 * always rolled back. `client` is connected and idle (no transaction open).
 */
export async function runCheck<R extends Record<string, ReadOnlyCheck>>(client: pg.ClientBase, name: keyof R & string, registry: R = CHECKS as unknown as R): Promise<CheckResult> {
	const check = registry[name]!;
	await client.query('BEGIN TRANSACTION READ ONLY');
	try {
		await client.query(`SET LOCAL statement_timeout = '${CHECK_STATEMENT_TIMEOUT}'`);
		// Belt and braces: the transaction refuses writes, or nothing runs.
		const { rows: ro } = await client.query<{ transaction_read_only: string }>('SHOW transaction_read_only');
		if (ro[0]?.transaction_read_only !== 'on') throw new CheckError('the transaction is not read only', 'check_failed');
		const cols = check.columns.map((c) => `q.${c}`).join(', ');
		const { rows } = await client.query<Record<string, unknown>>(
			`SELECT ${cols}, count(*) OVER () AS total_ FROM (${check.sql}) q ORDER BY ${check.orderBy} LIMIT ${CHECK_ROWS_MAX}`
		);
		const count = rows.length ? Number(rows[0]!.total_) : 0;
		return {
			check: name,
			count,
			truncated: count > rows.length,
			rows: rows.map((r) => Object.fromEntries(check.columns.map((c) => [c, cell(r[c])])))
		};
	} finally {
		await client.query('ROLLBACK');
	}
}
