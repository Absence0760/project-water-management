// Copying a project's registered volumes with it (POST /projects/:id/copy;
// docs/api.md § Projects, docs/allocations.md § Who sees what).
//
// A copy gets the original's allocation rows under new ids, each matched to the
// copy's node (the node id map freshIds made; NULL where the copy has none),
// the import files they came from, and the registered users' names, plus the
// owners' choice to let viewers read each volume (162).
//
// Who sees what doesn't widen: everything is read under the copier's RLS
// (withUser), so the copy gets the rows and names the copier could read in the
// original (231's rule: a viewer reads each volume only where the owners
// allowed it, and a name only as an editor or owner), and RLS on the copy then
// decides who reads them there. The holder keys (219) are the copy's own: its
// salt is made with the project, and no run is copied, so no frozen key either.
// What points at a run (run_allocation_holder, the comparisons a run holds)
// stays behind with the runs.
//
// An import file is copied only with a row of it the copier can read (an
// empty one would say "0 rows"); who imported it isn't carried over
// (imported_by NULL), as for the map's files (copyMap.ts). The times stay.
import type { Db } from '../db/tx.js';
import { recordAudit } from '../history/record.js';

type IdMap = ReadonlyMap<string, string>;

/** Copy the registered volumes of `srcId` into `newId` (whose model is already saved with the ids `ids` maps old → new). */
export async function copyAllocations(db: Db, srcId: string, newId: string, ids: IdMap): Promise<{ rows: number; viewerUnits: boolean }> {
	const { rows: sources } = await db.query<{ old: string; new: string }>(
		`WITH s AS MATERIALIZED (
			SELECT s.*, gen_random_uuid() AS new_id FROM allocation_source s
			WHERE s.project_id = $1 AND EXISTS (SELECT 1 FROM allocation a WHERE a.source_id = s.id AND a.project_id = $1)
		 ), ins AS (INSERT INTO allocation_source (id, project_id, kind, file_name, sha256, reference, imported_by, imported_at)
			SELECT new_id, $2, kind, file_name, sha256, reference, NULL, imported_at FROM s)
		 SELECT id AS old, new_id AS new FROM s`,
		[srcId, newId]
	);
	// The rows; a source the copier can't read leaves its row typed (source_id NULL), as RLS shows it.
	const { rows: copied } = await db.query<{ old: string; new: string }>(
		`WITH a AS MATERIALIZED (SELECT *, gen_random_uuid() AS new_id FROM allocation WHERE project_id = $1),
		 ins AS (INSERT INTO allocation (id, project_id, source_id, node_id, registration_no, property_ref, authorisation, purpose, water_source,
			volume_m3_year, storage_m3, valid_from, valid_to, reference, months, max_rate_m3s, conditions, water_use, irrigated_area_ha, created_at)
			SELECT a.new_id, $2, s.new_id, n.new_id, a.registration_no, a.property_ref, a.authorisation, a.purpose, a.water_source,
				a.volume_m3_year, a.storage_m3, a.valid_from, a.valid_to, a.reference, a.months, a.max_rate_m3s, a.conditions, a.water_use, a.irrigated_area_ha, a.created_at
			FROM a
			LEFT JOIN unnest($3::uuid[], $4::uuid[]) AS s(old_id, new_id) ON s.old_id = a.source_id
			LEFT JOIN unnest($5::uuid[], $6::uuid[]) AS n(old_id, new_id) ON n.old_id = a.node_id)
		 SELECT id AS old, new_id AS new FROM a`,
		[srcId, newId, sources.map((r) => r.old), sources.map((r) => r.new), [...ids.keys()], [...ids.values()]]
	);
	// The names the copier can read (allocation_holder_select): none for a viewer.
	await db.query(
		`INSERT INTO allocation_holder (allocation_id, project_id, user_display)
		 SELECT m.new_id, $2, h.user_display
		 FROM allocation_holder h JOIN unnest($3::uuid[], $4::uuid[]) AS m(old_id, new_id) ON m.old_id = h.allocation_id
		 WHERE h.project_id = $1`,
		[srcId, newId, copied.map((r) => r.old), copied.map((r) => r.new)]
	);
	// The owners' choice to let viewers read each volume (162): the copier owns the copy, so the owner-only setter takes it.
	const { rows: flag } = await db.query<{ on: boolean }>('SELECT app_allocations_viewer_units($1) AS "on"', [srcId]);
	const viewerUnits = !!flag[0]?.on;
	if (viewerUnits) {
		await db.query('SELECT app_set_allocations_viewer_units($1, true)', [newId]);
		await recordAudit(db, newId, 'allocation.viewer_units', { on: true });
	}
	return { rows: copied.length, viewerUnits };
}
