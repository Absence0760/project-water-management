// Which file a reference dataset was loaded from (192_feature_names_reference_load,
// docs/deployment.md § Reference datasets, Which file is loaded). A production
// load (referenceLoad.ts) names the object it read and its SHA-256; the replace
// functions (croplandGrid.ts, evaporationGrid.ts, loadRivers.ts) write that in
// the same transaction as the data, and any other replace of the dataset (a
// local `pnpm import:*`, which names no bucket file) deletes it, so the record
// never outlives the data it describes. Schema owner only: the app never reads
// reference_load.
import type pg from 'pg';

/** The kinds a production load takes (referenceLoad.ts REFERENCE_KINDS' allowed ones). */
export type ReferenceLoadKind = 'land-cover' | 'evaporation' | 'rivers';

/** The object a load read: its key in the reference bucket and the SHA-256 it was checked against. */
export interface ReferenceOrigin {
	key: string;
	sha256: string;
}

/** A dataset's recorded file, with when it was loaded. */
export interface ReferenceLoadRecord extends ReferenceOrigin {
	loadedAt: string;
}

/** Inside a replace's transaction: forget the dataset's old file, and record `origin` when the new data came from one. */
export async function recordReferenceOrigin(client: pg.ClientBase, kind: ReferenceLoadKind, dataset: string, origin: ReferenceOrigin | null): Promise<void> {
	await client.query('DELETE FROM reference_load WHERE kind = $1 AND dataset = $2', [kind, dataset]);
	if (origin) {
		await client.query('INSERT INTO reference_load (kind, dataset, source_key, source_sha256) VALUES ($1, $2, $3, $4)', [kind, dataset, origin.key, origin.sha256]);
	}
}

/** The file `dataset` was last loaded from, or null (never loaded from a file, or replaced since by a local import). */
export async function referenceLoadOf(client: pg.ClientBase, kind: ReferenceLoadKind, dataset: string): Promise<ReferenceLoadRecord | null> {
	const { rows } = await client.query<{ source_key: string; source_sha256: string; loaded_at: Date }>(
		'SELECT source_key, source_sha256, loaded_at FROM reference_load WHERE kind = $1 AND dataset = $2',
		[kind, dataset]
	);
	const r = rows[0];
	return r ? { key: r.source_key, sha256: r.source_sha256, loadedAt: r.loaded_at.toISOString() } : null;
}
