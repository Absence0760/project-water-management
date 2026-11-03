// The DEM rivers precomputed (docs/maps.md § The elevation model's channels,
// Precomputed): with PUBLIC_CHANNELS_URL set, the channel layer reads each
// 0.2° tile from one static PMTiles archive (backend delineation/
// channelArchive.ts, built by `pnpm dev:tiles:channels` or the operator's
// production run) instead of asking GET …/map/channels to compute it, so a
// tile costs a byte-range read and no account's hourly pool. Each entry is
// the route's own answer as JSON, so the lines are the ones a click snaps to.
//
// The route stays the fallback, tile by tile: for a tile the archive lacks
// (outside the region it was built for), for every tile when the archive
// can't be read or isn't a channels archive, and for every tile when it was
// built from another DEM than the one the server delineates on (its
// fingerprint against the delineation check's), so a stale file never draws
// channels a click wouldn't snap to.
import type { ChannelTileAnswer } from '#lib/api/types.js';
import { CHANNEL_TILE_DEG } from './channelLayer.svelte';

/** As the backend's (delineation/channelArchive.ts): tile (i, j) is stored at zoom 11, x = i + 1024, y = j + 1024. */
export const CHANNEL_ARCHIVE_ZOOM = 11;
export const CHANNEL_ARCHIVE_OFFSET = 1024;
/** /2 since the lines go down to 0.1 km² (the backend's CHANNEL_FLOOR_KM2): a /1 archive, built at 1 km², is refused, so the route draws the small channels. */
export const CHANNEL_ARCHIVE_FORMAT = 'water-management-channels/2';

/** What the layer needs of a PMTiles archive (the `pmtiles` package's PMTiles; a fake in the tests). */
export interface ChannelArchiveReader {
	getMetadata(): Promise<unknown>;
	getZxy(z: number, x: number, y: number): Promise<{ data: ArrayBuffer } | undefined>;
}

export type ChannelTileLoad = (projectId: string, tile: readonly [number, number]) => Promise<ChannelTileAnswer>;

export interface StaticChannelsOptions {
	/** Opens the archive (default: the `pmtiles` package's reader on `url`, a lazy chunk the basemap shares). */
	open: () => Promise<ChannelArchiveReader>;
	/** The server's DEM fingerprint (the delineation check's dataset), or null while it isn't known. */
	fingerprint: () => string | null | undefined;
	/** GET …/map/channels?tile=i,j: the route, with its hourly pool. */
	fallback: ChannelTileLoad;
}

/** The archive's PMTiles reader on `url` (same origin in production: /tiles/channels.pmtiles). */
export const openChannelArchive = (url: string) => async (): Promise<ChannelArchiveReader> => {
	const { PMTiles } = await import('pmtiles');
	return new PMTiles(url);
};

interface Usable {
	reader: ChannelArchiveReader;
	fingerprint: string;
}

/**
 * A tile load that reads the archive first and the route otherwise. `counts`
 * says how many tiles came from each (the tests', and the map's
 * data-channel-source attribute).
 */
export function staticChannels(opts: StaticChannelsOptions): ChannelTileLoad & { counts: { archive: number; route: number } } {
	let opened: Promise<Usable | null> | null = null;
	const counts = { archive: 0, route: 0 };
	const usable = () =>
		(opened ??= (async () => {
			try {
				const reader = await opts.open();
				const m = (await reader.getMetadata()) as { format?: unknown; tileDeg?: unknown; dem?: { fingerprint?: unknown } } | null;
				if (m?.format !== CHANNEL_ARCHIVE_FORMAT || m.tileDeg !== CHANNEL_TILE_DEG || typeof m.dem?.fingerprint !== 'string') return null;
				return { reader, fingerprint: m.dem.fingerprint };
			} catch {
				// Unreadable (not uploaded yet, a network failure): the route draws every tile this session.
				return null;
			}
		})());
	const route: ChannelTileLoad = (projectId, tile) => {
		counts.route++;
		return opts.fallback(projectId, tile);
	};
	const load: ChannelTileLoad = async (projectId, tile) => {
		const server = opts.fingerprint();
		const a = server ? await usable() : null;
		if (!a || a.fingerprint !== server) return route(projectId, tile);
		let hit: { data: ArrayBuffer } | undefined;
		try {
			hit = await a.reader.getZxy(CHANNEL_ARCHIVE_ZOOM, tile[0] + CHANNEL_ARCHIVE_OFFSET, tile[1] + CHANNEL_ARCHIVE_OFFSET);
		} catch {
			return route(projectId, tile);
		}
		if (!hit) return route(projectId, tile);
		const t = JSON.parse(new TextDecoder().decode(hit.data)) as Omit<ChannelTileAnswer, 'cached'>;
		if (t.tile?.[0] !== tile[0] || t.tile?.[1] !== tile[1] || !Array.isArray(t.lines)) return route(projectId, tile);
		counts.archive++;
		return { ...t, cached: true };
	};
	return Object.assign(load, { counts });
}
