// Field history (WP-2.4 UI, docs/api.md § Field history): how often each
// model input was changed, and the last change, for the small "Changed 3× ·
// last by Ann, 12 Aug: 40% → 60%" line on the node sheet, the farm drawer and
// Settings & calibration. One query over the project's revisions, under RLS.
//
// Revisions store sentences (the engine's diffInputs), not paths, so the
// engine's label tables say which input a line is about: a settings line by
// its subject, a node line by the label after "Name: ", a planted area by the
// crop in quotes. Nodes and crops are keyed by id, looked up by name in the
// revision's own snapshot, so a rename doesn't split a field's count.
import { nodeChangeFields, settingsChangePaths } from '@water-management/engine';
import type { Db } from '../db/tx.js';

export interface FieldHistory {
	/** How many saved changes (revisions, restores included) changed it. */
	count: number;
	lastAt: string;
	/** Who made the last change; null when that account is gone. */
	lastBy: string | null;
	/** The last change's values, "40% → 60%" (a planted area added or removed: "0 ha → 1.2 ha"). */
	change: string;
	/** Words for the History tab's parameter filter that find this field's lines. */
	filter: string;
}

const SETTINGS = settingsChangePaths();
const NODE_FIELDS = nodeChangeFields();

/**
 * Every field the project's history has changed, keyed
 * `settings:<path>` (`settings:gr4j.x1`), `node:<nodeId>:<field>`
 * (`node:…:damCapacityM3`) or `crop:<nodeId>:<cropId>` (a unit's planted area).
 */
export async function fieldHistory(db: Db, projectId: string): Promise<Record<string, FieldHistory>> {
	const { rows } = await db.query<FieldHistory & { key: string }>(
		`WITH ch AS (
			SELECT r.id, r.created_at, r.created_by, c.ord, c.v->>'area' AS area, c.v->>'kind' AS kind, c.v->>'subject' AS subject, c.v->>'text' AS text,
				-- The snapshot only where a line needs a node or crop id (it is the revision's largest column).
				CASE WHEN r.changes @> '[{"area":"network"}]' OR r.changes @> '[{"area":"crops"}]' THEN r.snapshot->'model' END AS model,
				r.changes AS all_changes
			FROM model_revision r CROSS JOIN LATERAL jsonb_array_elements(r.changes) WITH ORDINALITY AS c(v, ord)
			WHERE r.project_id = $1 AND r.source <> 'baseline' AND c.v->>'area' IN ('settings', 'network', 'crops')
		), keyed AS (
			SELECT ch.id, ch.created_at, ch.created_by, ch.ord, k.key, k.change, k.filter
			FROM ch CROSS JOIN LATERAL (
				SELECT 'settings:' || s.path AS key, substr(ch.text, length(ch.subject) + 3) AS change, ch.subject AS filter
				FROM unnest($2::text[], $3::text[]) AS s(subject, path)
				WHERE ch.area = 'settings' AND ch.kind = 'changed' AND s.subject = ch.subject AND starts_with(ch.text, ch.subject || ': ')
				UNION ALL
				(SELECT 'node:' || n.id || ':' || f.key, substr(ch.text, length(ch.subject || ': ' || f.label) + 2), ch.subject || ': ' || f.label
				 FROM (SELECT v->>'id' AS id FROM jsonb_array_elements(ch.model->'nodes') v WHERE v->>'name' = ch.subject LIMIT 1) n,
					unnest($4::text[], $5::text[]) AS f(label, key)
				 WHERE ch.area = 'network' AND ch.kind = 'changed' AND starts_with(ch.text, ch.subject || ': ' || f.label || ' ')
				 ORDER BY length(f.label) DESC LIMIT 1)
				UNION ALL
				(SELECT 'crop:' || n.id || ':' || cr.id,
					CASE ch.kind
						WHEN 'changed' THEN substring(ch.text from '" area (.*)$')
						WHEN 'added' THEN '0 ha → ' || substring(ch.text from '\\(([^()]*)\\)$')
						ELSE substring(ch.text from '\\(was ([^()]*)\\)$') || ' → 0 ha'
					END,
					'"' || cn.name || '" ' || ch.subject
				 FROM (SELECT CASE
						WHEN ch.kind = 'changed' AND starts_with(ch.text, ch.subject || ': "') THEN substring(substr(ch.text, length(ch.subject) + 4) from '^(.*)" area ')
						WHEN ch.kind IN ('added', 'removed') THEN substring(ch.text from '^Crop "(.*)" (?:added to|removed from) ')
					END AS name) cn,
					LATERAL (SELECT v->>'id' AS id FROM jsonb_array_elements(ch.model->'nodes') v WHERE v->>'name' = ch.subject LIMIT 1) n,
					LATERAL (SELECT v->>'id' AS id FROM jsonb_array_elements(ch.model->'crops') v WHERE v->>'name' = cn.name LIMIT 1) cr
				 -- A unit added with its crops is one new unit, not a change of its areas.
				 WHERE ch.area = 'crops' AND NOT ch.all_changes @> jsonb_build_array(jsonb_build_object('area', 'network', 'kind', 'added', 'subject', ch.subject)))
			) k
		)
		SELECT DISTINCT ON (k.key) k.key, (count(*) OVER (PARTITION BY k.key))::int AS count,
			to_char(k.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastAt", u.display_name AS "lastBy", k.change, k.filter
		FROM keyed k LEFT JOIN app_user u ON u.id = k.created_by
		ORDER BY k.key, k.created_at DESC, k.id DESC, k.ord DESC`,
		[projectId, SETTINGS.map((s) => s[0]), SETTINGS.map((s) => s[1]), NODE_FIELDS.map((f) => f[0]), NODE_FIELDS.map((f) => f[1])]
	);
	return Object.fromEntries(rows.map(({ key, ...f }) => [key, f]));
}
