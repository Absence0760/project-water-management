// Writing the change history (030_history.sql; docs/data-model.md § Change
// history). Every function runs inside the caller's withUser transaction, as
// the signed-in user under RLS, so a history row commits with the change it
// records or not at all.
//
// Model and settings changes are recorded at the document level: a route
// takes a `before` snapshot (beginModelChange / beginSettingsChange), makes
// its change, then recordModelRevision diffs before against after with the
// engine's diffInputs. Row triggers can't do this: saveModel rewrites the
// whole document on every save.
import { createHash } from 'node:crypto';
import { diffInputs, seriesDigest, type InputChange, type ProjectModel, type RunInputsSnapshot } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { loadSettingsAndModel } from '../model/store.js';
import { mergeSettings } from '../projects/settings.js';
import { seriesChange, stableJson, touchedNodeIds } from './diff.js';

/** Newest series revisions kept per (project, kind, name); series_revision_trim keeps the same number. */
export const SERIES_REVISIONS_KEPT = 5;
/** Oldest series revision kept, in days; series_revision_trim uses the same age. */
export const SERIES_REVISION_MAX_DAYS = 180;
/** Longest reason for a change (the model_revision CHECK). */
export const REASON_MAX = 500;

/** The optional "why" of a change: trimmed, no NUL; empty means none. */
export const Reason = z
	.string()
	.trim()
	.max(REASON_MAX)
	.refine((s) => !s.includes('\u0000'), 'reason cannot contain NUL characters')
	.optional()
	.transform((s) => (s ? s : undefined));

/** The project's inputs as a revision stores them: model_run.inputs' shape minus series. */
export interface InputsSnapshot {
	settings: RunInputsSnapshot['settings'];
	model: ProjectModel;
}

export type RevisionSource = 'baseline' | 'model_put' | 'settings_patch' | 'restore' | 'import' | 'copy';

export interface RevisionRow {
	id: string;
	createdAt: string;
	source: RevisionSource;
	reason: string | null;
	changes: InputChange[];
}

/** One farmer's link to one farm, with names for the log. */
export interface FarmLinkRow {
	nodeId: string;
	nodeName: string;
	userId: string;
	displayName: string;
}

/**
 * One history writer per project at a time, held to the end of the caller's
 * transaction, so two saves at once can't both diff against the same
 * `before` and record overlapping changes.
 */
export async function lockHistory(db: Db, projectId: string): Promise<void> {
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('history:' || $1::text, 0))`, [projectId]);
}

/** The project's { settings, model } now (settings merged over the defaults, as a run records them), in one round trip. */
export async function inputsSnapshot(db: Db, projectId: string): Promise<InputsSnapshot> {
	const { settings, model } = await loadSettingsAndModel(db, projectId);
	return { settings: mergeSettings(settings) as unknown as InputsSnapshot['settings'], model };
}

/** Before a settings change: take the lock and the state to diff against. */
export async function beginSettingsChange(db: Db, projectId: string): Promise<InputsSnapshot> {
	await lockHistory(db, projectId);
	return inputsSnapshot(db, projectId);
}

export interface ModelChange {
	before: InputsSnapshot;
	/** The farm links before the change: a node deleted, or no longer a farm, drops them (020_farm_scope.sql). */
	links: FarmLinkRow[];
}

/** Before a model change (a save or a restore): the lock, the state and the farm links. */
export async function beginModelChange(db: Db, projectId: string): Promise<ModelChange> {
	await lockHistory(db, projectId);
	return { before: await inputsSnapshot(db, projectId), links: await farmLinks(db, projectId) };
}

const asRun = (s: InputsSnapshot): RunInputsSnapshot => ({ settings: s.settings, model: s.model, series: {} });

/** The lines a change from `a` to `b` shows (engine diffInputs, which the run comparison uses too). */
export const describeChange = (a: InputsSnapshot | null, b: InputsSnapshot): InputChange[] => diffInputs(a ? asRun(a) : null, asRun(b));

const toRevision = (r: { id: string; created_at: Date; source: RevisionSource; reason: string | null; changes: InputChange[] }): RevisionRow => ({
	id: String(r.id),
	createdAt: r.created_at.toISOString(),
	source: r.source,
	reason: r.reason,
	changes: r.changes
});

async function insertRevision(
	db: Db,
	projectId: string,
	source: RevisionSource,
	snapshot: InputsSnapshot,
	changes: InputChange[],
	nodeIds: string[],
	extra: { reason?: string; restoredFrom?: string; restoredFromRun?: string } = {}
): Promise<RevisionRow> {
	const { rows } = await db.query(
		`INSERT INTO model_revision (project_id, created_by, source, reason, snapshot, changes, node_ids, restored_from, restored_from_run)
		 VALUES ($1, app_current_user_id(), $2, $3, $4, $5, $6::uuid[], $7, $8)
		 RETURNING id, created_at, source, reason, changes`,
		[projectId, source, extra.reason ?? null, JSON.stringify(snapshot), JSON.stringify(changes), nodeIds, extra.restoredFrom ?? null, extra.restoredFromRun ?? null]
	);
	return toRevision(rows[0]);
}

export interface RevisionOptions {
	source: RevisionSource;
	/** The state before the change; null for a project's first state (an import or a copy). */
	before: InputsSnapshot | null;
	reason?: string;
	/** A restore: the revision put back. */
	restoredFrom?: string;
	/** A restore of a run's inputs: the run. */
	restoredFromRun?: string;
}

/**
 * Record the project's inputs after a change, with the diffInputs lines from
 * `before`. Nothing is written when nothing changed (a no-op save), except
 * for a project's first state. The first change to a project that has no
 * revision yet (one that predates history) also records `before` as its
 * baseline, so the state before that change can be restored too.
 *
 * "Changed" is decided on the documents, not on the lines: a reorder changes
 * the document but no diffInputs line, and must still be restorable.
 */
export async function recordModelRevision(db: Db, projectId: string, o: RevisionOptions): Promise<RevisionRow | null> {
	const after = await inputsSnapshot(db, projectId);
	if (o.before && stableJson(o.before) === stableJson(after)) return null;
	if (o.before) {
		const { rows } = await db.query('SELECT 1 FROM model_revision WHERE project_id = $1 LIMIT 1', [projectId]);
		if (!rows.length) await insertRevision(db, projectId, 'baseline', o.before, [], []);
	}
	const changes = o.before ? describeChange(o.before, after) : [];
	const nodeIds = o.before ? touchedNodeIds(o.before.model, after.model) : [];
	return insertRevision(db, projectId, o.source, after, changes, nodeIds, {
		reason: o.reason,
		restoredFrom: o.restoredFrom,
		restoredFromRun: o.restoredFromRun
	});
}

/**
 * Kinds of audit event (docs/data-model.md § Change history).
 */
export type AuditKind =
	| 'project.changed'
	| 'member.added'
	| 'member.removed'
	| 'member.role'
	| 'member.party'
	| 'farmer.linked'
	| 'farmer.unlinked'
	| 'invite.sent'
	| 'invite.revoked'
	// The invitee declined it (109_invite_accept, issue #136): recorded by app_decline_invite, with no actor.
	| 'invite.declined'
	// The season decision log (issue #119, publish/decision.ts): the notice, window, run and per-farm figures.
	| 'publication.published'
	| 'publication.notice_changed'
	// A seasonal outlook's level published to farmers, or withdrawn (106, issue #53 R5).
	| 'outlook.published'
	| 'outlook.unpublished'
	| 'share_link.created'
	| 'share_link.revoked'
	| 'api_key.created'
	| 'api_key.revoked'
	| 'series.created'
	| 'series.replaced'
	| 'series.merged'
	| 'series.deleted'
	| 'series.labelled'
	| 'series.site_changed'
	| 'series.held'
	// A key's push into a series too short for the outlier limit: its auto run isn't published by itself until a person runs the model.
	| 'series.unchecked'
	| 'run.created'
	| 'run.changed'
	| 'run.deleted'
	| 'feed.configured'
	| 'feed.failed'
	| 'report_schedule.configured'
	| 'scenario.created'
	| 'scenario.changed'
	| 'scenario.deleted'
	| 'note.deleted'
	| 'signoff.created'
	// An evidence pack's lifecycle (112_evidence_pack, WP-3.14): ids, version, short code and hash; a withdrawal its reason.
	| 'pack.drafted'
	| 'pack.deleted'
	| 'pack.issued'
	| 'pack.superseded'
	| 'pack.withdrawn'
	// The hydrologist signed off the calibration rules, or withdrew it (issue #153): the typed name as a signature, the account as the actor.
	| 'calibration_rules.signed_off'
	| 'calibration_rules.sign_off_withdrawn'
	| 'allocation.created'
	| 'allocation.changed'
	| 'allocation.deleted'
	| 'allocation.imported'
	| 'allocation.import_deleted'
	// Whether viewers read each registered volume (162, D3): { on }.
	| 'allocation.viewer_units'
	// The licence record (161_licence_record): the outcome an owner recorded (with its dates and reason), or a review confirmed.
	| 'licence.outcome'
	| 'licence.confirmed'
	// The catchment map (152, issue #288): a file imported, a feature placed, changed or deleted. Ids, kind and name; never the geometry.
	| 'map.imported'
	| 'map.feature_created'
	| 'map.feature_changed'
	| 'map.feature_deleted'
	// The application workflow (WP-3.3, 045_contributor_scope). An application's
	// events carry `application: true` and no name until it is decided.
	| 'scenario.submitted'
	| 'scenario.withdrawn'
	| 'scenario.reopened'
	| 'scenario.decided'
	| 'scenario.shared'
	| 'scenario.unshared'
	// An editor switched alert kinds on or off or changed a threshold (WP-2.13, 051_alerts).
	| 'alert_rules.changed'
	// A team admin changed the team's portfolio traffic-light thresholds (WP-2.14
	// D11, 055_team_settings): recorded on each of the team's projects.
	| 'team_thresholds.changed'
	// Who reaches the project through its team (072_audit_trail): a team
	// member added (directly or by accepting an invite), their team role
	// changed, removed or leaving, and the team deleted. A team role is a
	// project role on every team project (app_project_role), so each is
	// recorded on each of the team's projects, like team_thresholds.changed.
	| 'team_member.added'
	| 'team_member.role'
	| 'team_member.removed'
	| 'team.deleted'
	| 'restore';

/**
 * Record one audit event as the transaction's actor, with a snapshot of their
 * name: the signed-in user (withUser) and their display name, or the API key
 * (withApiKey, 039_api_keys.sql) and `API key “<name>”`. `subject` holds ids,
 * names, counts and dates (and a publication's notice and per-farm season
 * totals, the decision log, publish/decision.ts), never a secret, a token or
 * series values.
 */
export async function recordAudit(db: Db, projectId: string, kind: AuditKind, subject: Record<string, unknown> = {}): Promise<void> {
	await db.query(
		`INSERT INTO audit_event (project_id, actor_user_id, actor_api_key_id, actor_label, kind, subject)
		 VALUES ($1, app_current_user_id(), app_current_api_key_id(),
			coalesce((SELECT left(display_name, 200) FROM app_user WHERE id = app_current_user_id()), app_api_key_label(), ''), $2, $3)`,
		[projectId, kind, JSON.stringify(subject)]
	);
}

/**
 * Record one audit event on every project of a team, for a team-level change
 * that changes what each of them shows (the portfolio thresholds). One
 * statement, as the signed-in user: RLS lets it reach only projects they can
 * see and write events on (a team admin owns all of the team's). Returns how
 * many were written; a team with no projects records nothing, since nothing
 * it holds changed.
 */
export async function recordTeamAudit(db: Db, teamId: string, kind: AuditKind, subject: Record<string, unknown> = {}): Promise<number> {
	const { rowCount } = await db.query(
		`INSERT INTO audit_event (project_id, actor_user_id, actor_api_key_id, actor_label, kind, subject)
		 SELECT p.id, app_current_user_id(), NULL,
			coalesce((SELECT left(display_name, 200) FROM app_user WHERE id = app_current_user_id()), ''), $2, $3
		 FROM project p WHERE p.team_id = $1`,
		[teamId, kind, JSON.stringify(subject)]
	);
	return rowCount ?? 0;
}

/** "jane@example.com" → "j•••@example.com": enough for the owner to recognise, not a mailing list for every viewer. */
export function maskEmail(email: string): string {
	const at = email.lastIndexOf('@');
	if (at <= 0) return '•••';
	return `${email[0]}•••${email.slice(at)}`;
}

/** A series as it stands, before a change. */
export interface SeriesRow {
	id: string;
	kind: string;
	name: string;
	unit: string;
	startDate: string;
	values: (number | null)[];
	/** The product and version (032_series_provenance.sql); both null = not recorded. Absent = null. */
	product?: string | null;
	productVersion?: string | null;
	/** How sub-daily readings were added up into days (033_series_day_boundary.sql); null = daily values. Absent = null. */
	dayBoundary?: string | null;
	/** Where the values came from and the unit they were given in (107_series_source.sql); null = not recorded. Absent = null. */
	source?: string | null;
	sourceUnit?: string | null;
	sourceUnitFactor?: number | null;
}

/** The series (kind, name) of a project, locked for the change about to be made; null when there is none. */
export async function lockSeries(db: Db, projectId: string, kind: string, name: string): Promise<SeriesRow | null> {
	const { rows } = await db.query<SeriesRow>(
		`SELECT id, kind, name, unit, start_date AS "startDate", "values", product, product_version AS "productVersion", day_boundary AS "dayBoundary",
			source, source_unit AS "sourceUnit", source_unit_factor AS "sourceUnitFactor"
		 FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3 FOR UPDATE`,
		[projectId, kind, name]
	);
	return rows[0] ?? null;
}

/** SHA-256 hex of a series' values: runs/execute.ts seriesHash, repeated here so history/ and runs/ don't import each other. */
export const valuesSha256 = (values: readonly (number | null)[]): string => createHash('sha256').update(seriesDigest(values)).digest('hex');

/** Keep a series' values before they change, so they can be restored (within the retention). Returns the revision id. */
export async function recordSeriesRevision(
	db: Db,
	projectId: string,
	s: SeriesRow,
	reason: 'replace' | 'delete' | 'manual_merge' | 'feed_replace'
): Promise<string> {
	// The product and version, and the day boundary, go with the values, so a restore puts them back too (032, 033),
	// and so does a flow record's site (085), read from the row as it stands before the change.
	const { rows } = await db.query<{ id: string }>(
		`INSERT INTO series_revision (project_id, series_id, kind, name, unit, start_date, "values", values_sha256, created_by, reason, product, product_version, day_boundary,
			site_node_id, source, source_unit, source_unit_factor)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::float8[], $8, app_current_user_id(), $9, $10, $11, $12,
			(SELECT site_node_id FROM time_series WHERE project_id = $1 AND id = $2), $13, $14, $15) RETURNING id`,
		[
			projectId,
			s.id,
			s.kind,
			s.name,
			s.unit,
			s.startDate,
			s.values,
			valuesSha256(s.values),
			reason,
			s.product ?? null,
			s.productVersion ?? null,
			s.dayBoundary ?? null,
			// The source and unit too (107): they describe these values.
			s.source ?? null,
			s.sourceUnit ?? null,
			s.sourceUnitFactor ?? null
		]
	);
	return String(rows[0]!.id);
}

/** The audit subject of a series change: which series, the new days' range, their hash and how many days changed. */
export function seriesSubject(
	meta: { id: string; kind: string; name: string; unit: string },
	before: { startDate: string; values: readonly (number | null)[] } | null,
	after: { startDate: string; values: readonly (number | null)[] } | null,
	extra: Record<string, unknown> = {}
): Record<string, unknown> {
	return {
		seriesId: meta.id,
		kind: meta.kind,
		name: meta.name,
		unit: meta.unit,
		...seriesChange(before, after),
		length: after?.values.length ?? 0,
		valuesSha256: after ? valuesSha256(after.values) : null,
		...extra
	};
}

/** Every farmer's farm links on the project, with names (viewers and above read farm_link). */
export async function farmLinks(db: Db, projectId: string): Promise<FarmLinkRow[]> {
	const { rows } = await db.query<FarmLinkRow>(
		`SELECT fl.node_id AS "nodeId", n.name AS "nodeName", fl.user_id AS "userId", u.display_name AS "displayName"
		 FROM farm_link fl JOIN node n ON n.id = fl.node_id JOIN app_user u ON u.id = fl.user_id
		 WHERE fl.project_id = $1 ORDER BY fl.user_id, fl.node_id`,
		[projectId]
	);
	return rows;
}

export type LinkCause = 'farmers_set' | 'member_removed' | 'model_saved' | 'restore';

/** farmer.linked / farmer.unlinked for every link in one list and not the other. */
export async function recordLinkChanges(db: Db, projectId: string, before: FarmLinkRow[], after: FarmLinkRow[], cause: LinkCause): Promise<void> {
	const key = (l: FarmLinkRow) => `${l.userId}|${l.nodeId}`;
	const had = new Set(before.map(key));
	const has = new Set(after.map(key));
	for (const l of before.filter((x) => !has.has(key(x)))) {
		await recordAudit(db, projectId, 'farmer.unlinked', { userId: l.userId, displayName: l.displayName, nodeId: l.nodeId, nodeName: l.nodeName, cause });
	}
	for (const l of after.filter((x) => !had.has(key(x)))) {
		await recordAudit(db, projectId, 'farmer.linked', { userId: l.userId, displayName: l.displayName, nodeId: l.nodeId, nodeName: l.nodeName, cause });
	}
}

/** After a model change: record the links it dropped (a deleted farm cascades them; a farm turned into a gauge unlinks them). */
export async function recordDroppedLinks(db: Db, projectId: string, change: ModelChange, cause: LinkCause): Promise<void> {
	if (!change.links.length) return;
	await recordLinkChanges(db, projectId, change.links, await farmLinks(db, projectId), cause);
}

/** Someone to re-link after a restore brought a farm back: they were unlinked from it, are still a farmer here, and aren't linked to it now. */
export interface Relink {
	userId: string;
	displayName: string;
	nodeId: string;
	nodeName: string;
}

/** Who to re-link to these farms, from the farmer.unlinked events (a restore never re-creates links). */
export async function relinkCandidates(db: Db, projectId: string, farmIds: string[]): Promise<Relink[]> {
	if (!farmIds.length) return [];
	const { rows } = await db.query<Relink>(
		`SELECT DISTINCT ON (e.subject->>'userId', e.subject->>'nodeId')
			e.subject->>'userId' AS "userId", coalesce(u.display_name, e.subject->>'displayName') AS "displayName",
			e.subject->>'nodeId' AS "nodeId", n.name AS "nodeName"
		 FROM audit_event e
		 JOIN node n ON n.project_id = e.project_id AND n.id::text = e.subject->>'nodeId' AND n.kind = 'farm'
		 JOIN project_member m ON m.project_id = e.project_id AND m.user_id::text = e.subject->>'userId' AND m.role IN ('farmer', 'contributor')
		 JOIN app_user u ON u.id = m.user_id
		 WHERE e.project_id = $1 AND e.kind = 'farmer.unlinked' AND e.subject->>'nodeId' = ANY($2::text[])
		   AND NOT EXISTS (SELECT 1 FROM farm_link fl WHERE fl.node_id = n.id AND fl.user_id = m.user_id)
		 ORDER BY e.subject->>'userId', e.subject->>'nodeId', e.created_at DESC`,
		[projectId, farmIds]
	);
	return rows;
}
