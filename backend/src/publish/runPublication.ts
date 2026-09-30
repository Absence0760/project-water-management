// One run's place in its project's publications (WP-2.3, WP-2.4; issue #70),
// for the printable report (docs/ui.md § Report): the cover's published-by
// line and restriction notice, and the "Changes since the previous
// publication" section. One read, so the server-side renderer's session can
// make it as a run read (reports/scope.ts RUN_READS) and print the same pages.
import type { InputChange, NoticeText, RestrictionLevel } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { compareInputs, type CompareAttribution } from '../compare/routes.js';

export interface RunPublication {
	/**
	 * The run's newest publication, or null when it was never published (or
	 * its publication has aged out of the kept 12). The restriction as it
	 * stands on that publication: the current notice, or the last one a
	 * superseded publication had.
	 */
	publication: {
		id: string;
		publishedAt: string;
		publishedBy: string | null;
		supersededAt: string | null;
		restriction: { level: RestrictionLevel; pct: number | null; notice: NoticeText };
	} | null;
	/**
	 * The publication before it: for a published run, the newest earlier
	 * publication of another run; for a run never published, the current
	 * publication. Null when there is none. `changes` is the net change of
	 * the inputs from that run to this one (engine diffInputs), `attribution`
	 * who made them, as GET /compare/runs gives them.
	 */
	previous: {
		id: string;
		runId: string;
		runLabel: string;
		publishedAt: string;
		publishedBy: string | null;
		changes: InputChange[];
		attribution: CompareAttribution | null;
	} | null;
}

interface Row {
	id: string;
	run_id: string;
	run_label: string;
	published_at: Date;
	published_by: string | null;
	superseded_at: Date | null;
	restriction_level: RestrictionLevel;
	restriction_pct: string | null;
	notice: NoticeText;
}

/** A pure choice over the project's publications, newest first: this run's and the one before it. */
export function placeInPublications<T extends { run_id: string; superseded_at: Date | null }>(rows: readonly T[], runId: string): { own: T | null; previous: T | null } {
	const at = rows.findIndex((r) => r.run_id === runId);
	if (at >= 0) return { own: rows[at]!, previous: rows.slice(at + 1).find((r) => r.run_id !== runId) ?? null };
	return { own: null, previous: rows.find((r) => r.superseded_at === null) ?? null };
}

/** The run must be the project's (the caller checks the role first). */
export async function runPublication(db: Db, projectId: string, runId: string): Promise<RunPublication> {
	const { rows } = await db.query<Row>(
		`SELECT p.id, p.run_id, r.label AS run_label, p.published_at, u.display_name AS published_by, p.superseded_at,
			p.restriction_level, p.restriction_pct, p.notice
		 FROM run_publication p
		 JOIN model_run r ON r.id = p.run_id
		 LEFT JOIN app_user u ON u.id = p.published_by
		 WHERE p.project_id = $1
		 ORDER BY p.published_at DESC, p.id DESC`,
		[projectId]
	);
	const { own, previous } = placeInPublications(rows, runId);
	return {
		publication: own
			? {
					id: own.id,
					publishedAt: own.published_at.toISOString(),
					publishedBy: own.published_by,
					supersededAt: own.superseded_at ? own.superseded_at.toISOString() : null,
					restriction: { level: own.restriction_level, pct: own.restriction_pct === null ? null : Number(own.restriction_pct), notice: own.notice }
				}
			: null,
		previous: previous
			? {
					id: previous.id,
					runId: previous.run_id,
					runLabel: previous.run_label,
					publishedAt: previous.published_at.toISOString(),
					publishedBy: previous.published_by,
					...(await compareInputs(db, { projectId, runId: previous.run_id }, { projectId, runId }))
				}
			: null
	};
}
