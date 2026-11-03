// The elevation model's channels, precomputed (docs/maps.md § The elevation
// model's channels, Precomputed): every CHANNEL_TILE_DEG tile of a region run
// through channelTile once, the same code the on-request route
// (channelRoutes.ts) runs, and written into one PMTiles archive the tiles
// bucket serves at /tiles/channels.pmtiles. The Map's DEM rivers layer and
// Delineate's channels read a tile from it by byte range (the frontend's
// channelArchive.ts) and fall back to the route only for a tile it lacks, so
// panning costs no Lambda CPU and no account's hourly pool.
//
// The archive is a key-value store, not a map-tile set MapLibre draws: each
// entry is one channel tile's JSON (exactly the route's answer, without its
// `cached` flag), gzip-compressed, tile type 0 ("other"). A tile's 0.2° index
// (i, j) sits at zoom CHANNEL_ARCHIVE_ZOOM, x = i + CHANNEL_ARCHIVE_OFFSET,
// y = j + CHANNEL_ARCHIVE_OFFSET (every index on the globe fits: |i| ≤ 900).
// Keeping the route's JSON, rather than vector tiles, keeps the lines exactly
// the ones a click snaps to (no quantising) and the layer's drawing unchanged,
// and needs no new dependency: the writer is pmtiles.ts's, the browser's
// reader the `pmtiles` package the basemap already loads.
import type { ChannelTile } from './channels.js';
import { channelTile, CHANNEL_FLOOR_KM2, CHANNEL_TILE_DEG, CHANNEL_WINDOW } from './channels.js';
import { DelineationRefused } from './delineate.js';
import type { Dem } from './dem.js';
import { writePmtiles } from './pmtiles.js';

/** The zoom the tile indexes are stored at (2 048 a side, enough for the 1 800 × 900 tiles of the globe). */
export const CHANNEL_ARCHIVE_ZOOM = 11;
/** Added to a tile's index to make it a non-negative x or y. */
export const CHANNEL_ARCHIVE_OFFSET = 1024;
/**
 * The archive's `format` in its metadata: the frontend refuses any other, and asks the route instead. /2: the lines go down to
 * CHANNEL_FLOOR_KM2 (0.1 km²); a /1 archive, built at 1 km², lacks the small channels the Map shows zoomed in.
 */
export const CHANNEL_ARCHIVE_FORMAT = 'water-management-channels/2';

/** Where tile (i, j) is stored. */
export const channelArchiveZxy = ([i, j]: readonly [number, number]): [number, number, number] => [CHANNEL_ARCHIVE_ZOOM, i + CHANNEL_ARCHIVE_OFFSET, j + CHANNEL_ARCHIVE_OFFSET];

/** The metadata the frontend checks before it trusts a tile (frontend channelArchive.ts). */
export interface ChannelArchiveMeta {
	name: string;
	format: typeof CHANNEL_ARCHIVE_FORMAT;
	attribution: string;
	tileDeg: number;
	window: number;
	minKm2: number;
	/** The DEM the channels were routed on: a tile is used only while the server's DEM has this fingerprint. */
	dem: { label: string; fingerprint: string };
	/** The tile indexes built, west, south, east, north (inclusive). */
	tiles: [number, number, number, number];
}

/** The tile indexes meeting a bbox (west, south, east, north), inclusive. */
export function tileRange([w, s, e, n]: readonly [number, number, number, number]): [number, number, number, number] {
	const lo = (v: number) => Math.floor(v / CHANNEL_TILE_DEG + 1e-9);
	const hi = (v: number) => Math.ceil(v / CHANNEL_TILE_DEG - 1e-9) - 1;
	return [lo(w), lo(s), Math.max(lo(w), hi(e)), Math.max(lo(s), hi(n))];
}

export interface BuildOptions {
	/** The region (west, south, east, north); default the DEM's bounds. */
	bbox?: readonly [number, number, number, number];
	/** Told after each tile (the CLI's progress line). */
	onTile?: (done: number, total: number, tile: ChannelTile | null) => void;
}

/**
 * Route every tile of the region with channelTile (its defaults: the same
 * window and least area the route uses) and write them as one archive. A tile
 * the DEM refuses (outside it, no data) is left out, so the frontend asks the
 * route for it and gets the route's own refusal; a tile with no channel is
 * kept, empty, so nothing is asked for it again.
 */
export async function buildChannelArchive(dem: Dem, opts: BuildOptions = {}): Promise<{ archive: Buffer; meta: ChannelArchiveMeta; built: number; skipped: number }> {
	const info = await dem.info();
	const [i0, j0, i1, j1] = tileRange(opts.bbox ?? info.bounds);
	const total = (i1 - i0 + 1) * (j1 - j0 + 1);
	const tiles: { z: number; x: number; y: number; data: Uint8Array }[] = [];
	let skipped = 0;
	let done = 0;
	// Row by row, so neighbouring windows share the DEM's decoded-tile cache.
	for (let j = j1; j >= j0; j--) {
		for (let i = i0; i <= i1; i++) {
			let t: ChannelTile | null = null;
			try {
				t = await channelTile(dem, [i, j]);
			} catch (err) {
				if (!(err instanceof DelineationRefused)) throw err;
				skipped++;
			}
			if (t) {
				const [z, x, y] = channelArchiveZxy([i, j]);
				tiles.push({ z, x, y, data: Buffer.from(JSON.stringify(t)) });
			}
			opts.onTile?.(++done, total, t);
		}
	}
	if (!tiles.length) throw new Error('No tile of the region is on the elevation model: check the bbox against the DEM’s bounds.');
	const meta: ChannelArchiveMeta = {
		name: `Terrain channels of ${info.label}`,
		format: CHANNEL_ARCHIVE_FORMAT,
		attribution: info.attribution,
		tileDeg: CHANNEL_TILE_DEG,
		window: CHANNEL_WINDOW,
		minKm2: CHANNEL_FLOOR_KM2,
		dem: { label: info.label, fingerprint: info.fingerprint },
		tiles: [i0, j0, i1, j1]
	};
	const bounds: [number, number, number, number] = [i0 * CHANNEL_TILE_DEG, j0 * CHANNEL_TILE_DEG, (i1 + 1) * CHANNEL_TILE_DEG, (j1 + 1) * CHANNEL_TILE_DEG];
	const archive = writePmtiles(tiles, { tileType: 0, tileCompression: 'gzip', bounds: bounds.map((v) => Math.round(v * 1e9) / 1e9) as typeof bounds, metadata: { ...meta } });
	return { archive, meta, built: tiles.length, skipped };
}
