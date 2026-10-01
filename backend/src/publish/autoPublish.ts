// Publishing an auto run by itself (roadmap WP-2.11, decision D5): only when
// the project opted in (settings.autoRun.publish = 'if_no_new_warnings'),
// never by default, and never "always". Publication otherwise stays a
// person's act: the editor sees "New auto run: publish?" on the Overview.
//
// An auto run replaces the current publication when:
//   - there is a current publication (a first publication is always a
//     person's: someone has to stand behind the baseline once);
//   - none of the run's self-checks failed;
//   - it raises no warning the published run didn't (newWarnings: the same
//     sentence with different numbers or dates, e.g. "CHIRPS stands in on
//     2131 days" → "… 2132 days", is the same warning);
//   - publishRun accepts it (not a legacy-runoff run, a projectable summary).
// The WUA's restriction notice and next-update date carry over unchanged,
// since a new run is no reason to lift or change a restriction. The note says
// it was published automatically, and the audit event carries `auto: true`
// (publishRun records it, with the decision log's fields, decision.ts).
import type { NoticeText } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { DEFAULT_TIME_ZONE, localDate } from '../projects/timeZone.js';
import { publishRun } from './publish.js';

/** A warning's shape: its text with every number (and so every date) masked. */
const shape = (w: string) => w.replace(/\d+(?:[.,]\d+)*/g, '#');

/** The warnings of `next` whose shape isn't among `prev`'s. */
export function newWarnings(prev: readonly string[], next: readonly string[]): string[] {
	const seen = new Set(prev.map(shape));
	return next.filter((w) => !seen.has(shape(w)));
}

export type AutoPublishOutcome =
	| { published: true; publicationId: string }
	| { published: false; reason: 'no_publication' | 'already_published' | 'failed_checks' | 'new_warnings' | 'not_publishable'; detail?: string };

interface RunWarnings {
	id: string;
	warnings: string[] | null;
	failed: number;
}

/** Try to publish `runId` in place of the current publication (see the header). As the job's acting user (an editor). */
export async function autoPublish(db: Db, projectId: string, runId: string): Promise<AutoPublishOutcome> {
	const { rows: cur } = await db.query<{
		run_id: string;
		published_at: Date;
		restriction_level: 'none' | 'advisory' | 'restricted';
		restriction_pct: string | null;
		notice: NoticeText;
		next_expected_on: string | null;
	}>(
		`SELECT run_id, published_at, restriction_level, restriction_pct, notice, next_expected_on
		 FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL`,
		[projectId]
	);
	const current = cur[0];
	if (!current) return { published: false, reason: 'no_publication' };
	if (current.run_id === runId) return { published: false, reason: 'already_published' };
	const { rows } = await db.query<RunWarnings>(
		`SELECT id, summary->'warnings' AS warnings,
			(SELECT count(*)::int FROM jsonb_array_elements(COALESCE(summary->'verification'->'checks', '[]'::jsonb)) c WHERE c->>'passed' = 'false') AS failed
		 FROM model_run WHERE project_id = $1 AND id = ANY($2::uuid[])`,
		[projectId, [current.run_id, runId]]
	);
	const next = rows.find((r) => r.id === runId);
	const prev = rows.find((r) => r.id === current.run_id);
	if (!next || !prev) return { published: false, reason: 'not_publishable', detail: 'run not found' };
	if (next.failed > 0) return { published: false, reason: 'failed_checks' };
	const added = newWarnings(prev.warnings ?? [], next.warnings ?? []);
	if (added.length) return { published: false, reason: 'new_warnings', detail: added[0] };

	// The day it was published where the catchment is (project.time_zone, 058), as its readers date it.
	const { rows: tz } = await db.query<{ time_zone: string }>('SELECT time_zone FROM project WHERE id = $1', [projectId]);
	const since = localDate(current.published_at, tz[0]?.time_zone ?? DEFAULT_TIME_ZONE);
	let result;
	try {
		result = await publishRun(db, projectId, {
			runId,
			note: `Published automatically: this auto run raised no warning the run published on ${since} didn't.`,
			restriction: {
				level: current.restriction_level,
				pct: current.restriction_pct === null ? null : Number(current.restriction_pct),
				notice: current.notice
			},
			nextExpectedOn: current.next_expected_on
		}, { auto: true });
	} catch (err) {
		// publishRun refuses before it writes anything (a legacy-runoff run, a
		// summary it can't project); that leaves publishing to a person.
		if (err instanceof ApiError) return { published: false, reason: 'not_publishable', detail: err.message };
		throw err;
	}
	// publishRun recorded it in the decision log, `auto: true` (decision.ts).
	return { published: true, publicationId: result.publication.id };
}
