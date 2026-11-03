// The precomputed channels (channelArchive.ts) against the committed synthetic
// DEM: every tile the archive holds is exactly what the on-request route
// computes for that tile (channelTile, channelRoutes.ts' work, with the same
// defaults), tiles off the DEM are left to the route, and the committed
// fixture (backend/fixtures/channels/synthetic-channels.pmtiles, which the
// frontend's reader is tested against) is what the builder writes today, so a
// change to the channels' code or parameters fails here until
// `pnpm gen:channels-fixture` is rerun.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHANNELS_FIXTURE_FILE } from '../../scripts/channels-build.js';
import { buildChannelArchive, CHANNEL_ARCHIVE_FORMAT, channelArchiveZxy, tileRange } from './channelArchive.js';
import { channelTile, CHANNEL_FLOOR_KM2, CHANNEL_WINDOW } from './channels.js';
import { DelineationRefused } from './delineate.js';
import { openDem } from './dem.js';
import { FIXTURE_FILE } from './fixture.js';
import { PmtilesReader, type ByteSource } from './pmtiles.js';

const memory =
	(b: Uint8Array): ByteSource =>
	async (o, l) =>
		b.subarray(o, o + l);
const dem = () => openDem(fileURLToPath(FIXTURE_FILE));
const json = (b: Uint8Array | null) => (b ? JSON.parse(new TextDecoder().decode(b)) : null);

/** Each tile the archive holds, decoded, by `i,j`, and its metadata. */
async function contents(archive: Uint8Array) {
	const r = new PmtilesReader(memory(archive));
	const meta = await r.getMetadata();
	const [i0, j0, i1, j1] = meta.tiles as number[];
	const tiles = new Map<string, unknown>();
	for (let j = j0!; j <= j1!; j++)
		for (let i = i0!; i <= i1!; i++) {
			const t = json(await r.getTile(...channelArchiveZxy([i, j])));
			if (t) tiles.set(`${i},${j}`, t);
		}
	return { meta, tiles, header: await r.getHeader() };
}

describe('tileRange', () => {
	it('takes every 0.2° tile a bbox meets, and none it only touches', () => {
		expect(tileRange([20.3, -33.9, 20.7, -33.5])).toEqual([101, -170, 103, -168]);
		expect(tileRange([20.2, -34, 20.4, -33.8])).toEqual([101, -170, 101, -170]);
	});
});

describe('the precomputed channels', () => {
	it('hold, tile for tile, exactly what the on-request route computes, and leave tiles off the DEM to it', { timeout: 60_000 }, async () => {
		const { archive, meta, built, skipped } = await buildChannelArchive(dem());
		expect(meta).toMatchObject({ format: CHANNEL_ARCHIVE_FORMAT, window: CHANNEL_WINDOW, minKm2: CHANNEL_FLOOR_KM2, dem: { fingerprint: (await dem().info()).fingerprint } });
		const { tiles, header } = await contents(archive);
		expect(header).toMatchObject({ tileType: 0, tileCompression: 2 });
		expect(tiles.size).toBe(built);
		expect(built).toBeGreaterThan(4);
		expect(skipped).toBeGreaterThan(0);
		const [i0, j0, i1, j1] = meta.tiles;
		const route = dem();
		let withLines = 0;
		for (let j = j0; j <= j1; j++)
			for (let i = i0; i <= i1; i++) {
				const stored = tiles.get(`${i},${j}`);
				let computed: unknown = null;
				try {
					computed = await channelTile(route, [i, j]);
				} catch (e) {
					expect(e).toBeInstanceOf(DelineationRefused);
				}
				// Through JSON, as the route answers: the same lines, areas, bounds and dataset.
				expect(stored ?? null, `tile ${i},${j}`).toEqual(computed && JSON.parse(JSON.stringify(computed)));
				if ((stored as { lines: unknown[] } | undefined)?.lines.length) withLines++;
			}
		// Positive control: the valley's tiles carry channels, so the equality is over real lines.
		expect(withLines).toBeGreaterThan(0);
	});

	it('is what the committed fixture holds (rerun `pnpm gen:channels-fixture` after changing the channels or the terrain)', { timeout: 60_000 }, async () => {
		const fresh = await contents((await buildChannelArchive(dem())).archive);
		const committed = await contents(readFileSync(CHANNELS_FIXTURE_FILE));
		expect(committed.meta).toEqual(fresh.meta);
		expect([...committed.tiles.keys()]).toEqual([...fresh.tiles.keys()]);
		for (const [k, t] of fresh.tiles) expect(committed.tiles.get(k), `tile ${k}`).toEqual(t);
	});

	it('builds only the region asked for, and refuses one off the DEM', async () => {
		const { meta, built } = await buildChannelArchive(dem(), { bbox: [20.4, -33.8, 20.6, -33.6] });
		expect(meta.tiles).toEqual([102, -169, 102, -169]);
		expect(built).toBeLessThanOrEqual(1);
		await expect(buildChannelArchive(dem(), { bbox: [25, -30, 25.1, -29.9] })).rejects.toThrow(/No tile of the region/);
	});
});
