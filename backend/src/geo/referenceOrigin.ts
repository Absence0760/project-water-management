// Where a reference dataset came from (192_feature_names_reference_load,
// 248_reference_load_provenance; docs/deployment.md § Reference datasets,
// Which file is loaded).
//
// Tables. A production load (referenceLoad.ts) names the object it read and
// its SHA-256; the replace functions (croplandGrid.ts, evaporationGrid.ts,
// loadRivers.ts, loadGazetteer.ts, rainMap.ts) write that in the same
// transaction as the data, and any other replace of the dataset (a local
// `pnpm import:*`, which names no bucket file) deletes it, so the record
// never outlives the data it describes.
//
// Tile archives (248). The tiles bucket serves four archives (TILE_ARCHIVES);
// backend/scripts/tiles-upload.ts hashes each one it uploads, keeps the
// original downloads under originals/<archive>/ in the reference bucket, and
// records a TileProvenance: straight into the dev database locally, and in
// production as a provenance file in the reference bucket that
// load-reference.yml's `tiles` kind records (referenceLoad.ts). One row per
// archive (kind 'tiles', dataset the archive's name), replaced by the next
// upload of it.
//
// reference_load is owner-only. The app reads it only through
// app_reference_provenance() (referenceProvenance below): the version, the
// upstream's date and the licence, never a key, hash or ETag. The Map's
// dataset lines (the DEM's and the water occurrence's) show the archive's
// version and date from it (withProvenance).
import type pg from 'pg';

/** The kinds a production load takes (referenceLoad.ts REFERENCE_KINDS' allowed ones), and the tile archives' record. */
export type ReferenceLoadKind = 'land-cover' | 'evaporation' | 'rivers' | 'gazetteer' | 'map-grid' | 'tiles' | 'waterbodies';

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

// ---------------------------------------------------------------------------
// Tile archives
// ---------------------------------------------------------------------------

export type TileArchive = 'basemap' | 'fonts' | 'terrain' | 'water';

export interface TileArchiveSpec {
	/** Where the tiles bucket serves it (the site's /tiles/…; the local MinIO bucket is named `tiles`, so the same path). */
	key: string;
	/** What it is, for the operator. */
	what: string;
	/** The licence it is used under, as docs/maps.md § Sources read it: recorded from here, never from a file. */
	licence: string;
	/** The upstream a fresh download comes from (its version appended where the upstream names files by version). */
	upstream: string;
	/** The docs/maps.md § Sources row that decides it (its Dataset cell starts with this; referenceLoad.test.ts). */
	sourcesRow: string;
}

/** The archives the tiles bucket serves (docs/deployment.md § Map tiles). */
export const TILE_ARCHIVES: Readonly<Record<TileArchive, TileArchiveSpec>> = {
	basemap: {
		key: 'tiles/south-africa.pmtiles',
		what: 'the basemap: a Protomaps daily build of OpenStreetMap, extracted to the region',
		licence: 'ODbL 1.0 for the OpenStreetMap data (openstreetmap.org/copyright, read 2026-10-01)',
		upstream: 'https://build.protomaps.com/',
		sourcesRow: 'Basemap tiles'
	},
	fonts: {
		key: 'tiles/fonts/',
		what: 'the labels’ glyph ranges: Noto Sans from protomaps/basemaps-assets at a pinned commit',
		licence: 'SIL Open Font License 1.1 (read 2026-10-01)',
		upstream: 'https://codeload.github.com/protomaps/basemaps-assets/tar.gz/',
		sourcesRow: 'Label glyphs'
	},
	terrain: {
		key: 'tiles/terrain.pmtiles',
		what: 'the relief and delineation’s DEM: Copernicus GLO-30 as Mapterhorn’s Terrarium tiles, extracted to the region',
		licence: 'Copernicus WorldDEM-30 licence: free of charge, adaptation and commercial use allowed (read 2026-10-01)',
		upstream: 'https://download.mapterhorn.com/planet.pmtiles',
		sourcesRow: 'Relief DEM'
	},
	water: {
		key: 'tiles/water.pmtiles',
		what: 'tracing a dam’s water occurrence: JRC Global Surface Water v1.5, warped to Terrarium tiles at zoom 12',
		licence: 'Copernicus, free of charge and without restriction of use (JRC GSW download page, read 2026-10-02)',
		upstream: 'https://s3.waw4-1.cloudferro.com/swift/v1/global-surface-water/download2024/Aggregated/VER1-5/occurrence',
		sourcesRow: 'JRC Global Surface Water'
	}
};

export const isTileArchive = (s: unknown): s is TileArchive => typeof s === 'string' && Object.hasOwn(TILE_ARCHIVES, s);

/** The provenance file's format tag (tiles-upload.ts writes it, the `tiles` load reads it). */
export const TILE_PROVENANCE_FORMAT = 'wm-tile-provenance/1';

/** One original download kept in the reference bucket. */
export interface OriginalFile {
	/** originals/<archive>/<file> in the reference bucket. */
	key: string;
	sha256: string;
	bytes: number;
}

/** What upstream served the download, as far as it said. Null: not known (never empty). */
export interface Upstream {
	url: string | null;
	version: string | null;
	etag: string | null;
	/** ISO 8601. */
	lastModified: string | null;
}

/** One archive's provenance: what tiles-upload.ts records for an upload. */
export interface TileProvenance {
	archive: TileArchive;
	/** SHA-256 of the archive as served (the fonts: of their listing, fontsDigest in tiles-upload.ts). */
	sha256: string;
	bytes: number;
	upstream: Upstream;
	originals: OriginalFile[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const ONE_LINE = (s: string, max: number) => s.length >= 1 && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s);
export const originalKeyShape = (archive: TileArchive) => new RegExp(`^originals/${archive}/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`);

/** A provenance file's contents, checked; a string names the first problem (fixed text, never the input). */
export function parseTileProvenance(raw: unknown): TileProvenance | string {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object';
	const r = raw as Record<string, unknown>;
	if (r.format !== TILE_PROVENANCE_FORMAT) return `format is not ${TILE_PROVENANCE_FORMAT}`;
	if (!isTileArchive(r.archive)) return `archive is not one of ${Object.keys(TILE_ARCHIVES).join(', ')}`;
	const archive = r.archive;
	if (typeof r.sha256 !== 'string' || !HEX64.test(r.sha256)) return 'sha256 is not 64 lowercase hex digits';
	if (!Number.isSafeInteger(r.bytes) || (r.bytes as number) < 1) return 'bytes is not a positive whole number';
	const u = r.upstream;
	if (!u || typeof u !== 'object' || Array.isArray(u)) return 'upstream is not an object';
	const up = u as Record<string, unknown>;
	const opt = (v: unknown, ok: (s: string) => boolean): string | null | undefined => (v === null || v === undefined ? null : typeof v === 'string' && ok(v) ? v : undefined);
	const url = opt(up.url, (s) => /^https:\/\/[^\s]{1,490}$/.test(s));
	if (url === undefined) return 'upstream.url is not an https:// URL';
	const version = opt(up.version, (s) => ONE_LINE(s, 100));
	if (version === undefined) return 'upstream.version is not one line of at most 100 characters';
	const etag = opt(up.etag, (s) => ONE_LINE(s, 200));
	if (etag === undefined) return 'upstream.etag is not one line of at most 200 characters';
	const lastModified = opt(up.lastModified, (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) && !Number.isNaN(Date.parse(s)));
	if (lastModified === undefined) return 'upstream.lastModified is not an ISO 8601 UTC time';
	if (!Array.isArray(r.originals) || r.originals.length > 50) return 'originals is not a list of at most 50 files';
	const originals: OriginalFile[] = [];
	for (const o of r.originals as unknown[]) {
		const f = o as Record<string, unknown> | null;
		if (!f || typeof f.key !== 'string' || !originalKeyShape(archive).test(f.key) || f.key.includes('..')) return `each original's key is originals/${archive}/<file>`;
		if (typeof f.sha256 !== 'string' || !HEX64.test(f.sha256)) return "each original's sha256 is 64 lowercase hex digits";
		if (!Number.isSafeInteger(f.bytes) || (f.bytes as number) < 0) return "each original's bytes is a whole number";
		originals.push({ key: f.key, sha256: f.sha256, bytes: f.bytes as number });
	}
	return { archive, sha256: r.sha256, bytes: r.bytes as number, upstream: { url, version, etag, lastModified }, originals };
}

/** The provenance file tiles-upload.ts writes (a TileProvenance with its format tag). */
export const tileProvenanceFile = (p: TileProvenance) => ({ format: TILE_PROVENANCE_FORMAT, ...p });

/**
 * Record an archive's provenance as the schema owner (one statement: it
 * replaces the archive's last record). Returns the record it replaced, or null.
 */
export async function recordTileProvenance(client: pg.ClientBase, p: TileProvenance): Promise<ReferenceLoadRecord | null> {
	const spec = TILE_ARCHIVES[p.archive];
	const replaced = await referenceLoadOf(client, 'tiles', p.archive);
	await client.query(
		`INSERT INTO reference_load (kind, dataset, source_key, source_sha256, upstream_url, upstream_version, upstream_etag, upstream_last_modified, licence, originals)
		 VALUES ('tiles', $1, $2, $3, $4, $5, $6, $7, $8, $9)
		 ON CONFLICT (kind, dataset) DO UPDATE SET
		   source_key = EXCLUDED.source_key, source_sha256 = EXCLUDED.source_sha256, upstream_url = EXCLUDED.upstream_url,
		   upstream_version = EXCLUDED.upstream_version, upstream_etag = EXCLUDED.upstream_etag,
		   upstream_last_modified = EXCLUDED.upstream_last_modified, licence = EXCLUDED.licence, originals = EXCLUDED.originals,
		   loaded_at = now()`,
		[
			p.archive,
			spec.key,
			p.sha256,
			p.upstream.url,
			p.upstream.version,
			p.upstream.etag,
			p.upstream.lastModified,
			spec.licence,
			p.originals.length ? JSON.stringify(p.originals) : null
		]
	);
	return replaced;
}

/** What the app may know of a recorded dataset (app_reference_provenance()). */
export interface ProvenanceLine {
	kind: ReferenceLoadKind;
	dataset: string;
	version: string | null;
	/** The upstream file's Last-Modified, `YYYY-MM-DD` (UTC), or null. */
	upstreamDate: string | null;
	licence: string | null;
	/** When we recorded it, `YYYY-MM-DD` (UTC). */
	recordedOn: string;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Every recorded dataset's version and dates, as water_app (any transaction; no project scope: reference data is global). */
export async function referenceProvenance(db: pg.ClientBase): Promise<ProvenanceLine[]> {
	const { rows } = await db.query<{ kind: ReferenceLoadKind; dataset: string; upstream_version: string | null; upstream_last_modified: Date | null; licence: string | null; loaded_at: Date }>(
		'SELECT kind, dataset, upstream_version, upstream_last_modified, licence, loaded_at FROM app_reference_provenance()'
	);
	return rows.map((r) => ({ kind: r.kind, dataset: r.dataset, version: r.upstream_version, upstreamDate: day(r.upstream_last_modified), licence: r.licence, recordedOn: day(r.loaded_at)! }));
}

/** One tile archive's recorded line, or null (never recorded: a hand upload, or the synthetic fixture). */
export async function tileProvenance(db: pg.ClientBase, archive: TileArchive): Promise<ProvenanceLine | null> {
	return (await referenceProvenance(db)).find((l) => l.kind === 'tiles' && l.dataset === archive) ?? null;
}

/**
 * A dataset line with its recorded version and date: "Copernicus GLO-30 (version
 * 0.0.13, upstream file of 2026-09-30, recorded 2026-10-27)". The label as it was
 * when nothing is recorded.
 */
export function withProvenance(label: string, line: ProvenanceLine | null): string {
	if (!line) return label;
	const parts = [line.version ? `version ${line.version}` : null, line.upstreamDate ? `upstream file of ${line.upstreamDate}` : null, `recorded ${line.recordedOn}`].filter(Boolean);
	return `${label} (${parts.join(', ')})`;
}
