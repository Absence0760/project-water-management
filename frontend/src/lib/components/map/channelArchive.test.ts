// The static source of the DEM rivers (channelArchive.ts), read through the
// real `pmtiles` reader from the committed synthetic archive the backend
// builds from its synthetic DEM (backend/fixtures/channels/, `pnpm
// gen:channels-fixture`; backend channelArchive.test.ts checks it holds what
// the route computes): a tile it holds comes from it, never the route; the
// route answers for a tile it lacks, for an archive built from another DEM,
// for one that is not a channels archive, and for one that can't be read.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PMTiles, type Source } from 'pmtiles';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelTileAnswer } from '#lib/api/types.js';
import { CHANNEL_ARCHIVE_FORMAT, staticChannels, type ChannelArchiveReader } from './channelArchive';

const FIXTURE = readFileSync(fileURLToPath(new URL('../../../../../backend/fixtures/channels/synthetic-channels.pmtiles', import.meta.url)));

/** The committed archive through the package's own reader (its gzip, its directory search). */
const fixtureReader = (): ChannelArchiveReader => {
	const source: Source = {
		getKey: () => 'synthetic-channels',
		getBytes: async (offset, length) => ({ data: FIXTURE.buffer.slice(FIXTURE.byteOffset + offset, FIXTURE.byteOffset + offset + length) as ArrayBuffer })
	};
	return new PMTiles(source);
};

const meta = (async () => (await fixtureReader().getMetadata()) as { dem: { fingerprint: string }; tiles: [number, number, number, number] })();
const routeAnswer = (tile: readonly [number, number]): ChannelTileAnswer => ({ tile: [tile[0], tile[1]], bounds: [0, 0, 0, 0], minKm2: 1, lines: [], cellSizeM: 30, dataset: { label: 'route', fingerprint: 'x' }, cached: false });

describe('the DEM rivers’ static source', () => {
	it('reads a tile the archive holds from it (the route is never asked), the same JSON the route answers', async () => {
		const { dem, tiles } = await meta;
		const fallback = vi.fn(async (_p: string, t: readonly [number, number]) => routeAnswer(t));
		const load = staticChannels({ open: async () => fixtureReader(), fingerprint: () => dem.fingerprint, fallback });
		let withLines = 0;
		for (let j = tiles[1]; j <= tiles[3]; j++)
			for (let i = tiles[0]; i <= tiles[2]; i++) {
				const a = await load('p', [i, j]);
				expect(a.tile).toEqual([i, j]);
				if (a.dataset.label !== 'route') {
					expect(a).toMatchObject({ cached: true, minKm2: 0.1, dataset: { fingerprint: dem.fingerprint } });
					if (a.lines.length) withLines++;
				}
			}
		// Positive control: real lines came from the file, and the route answered only the tiles off the synthetic DEM.
		expect(withLines).toBeGreaterThan(0);
		expect(load.counts.archive).toBe(16);
		expect(load.counts.route).toBe(fallback.mock.calls.length);
		expect(load.counts.archive + load.counts.route).toBe((tiles[2] - tiles[0] + 1) * (tiles[3] - tiles[1] + 1));
	});

	it('asks the route for a tile the archive lacks', async () => {
		const { dem } = await meta;
		const fallback = vi.fn(async (_p: string, t: readonly [number, number]) => routeAnswer(t));
		const load = staticChannels({ open: async () => fixtureReader(), fingerprint: () => dem.fingerprint, fallback });
		expect((await load('p', [500, -10])).dataset.label).toBe('route');
		expect(fallback).toHaveBeenCalledWith('p', [500, -10]);
	});

	it('asks the route for every tile when the archive was built from another DEM, or the server’s is not known yet', async () => {
		const { tiles } = await meta;
		for (const fingerprint of ['0000000000000000', null]) {
			const fallback = vi.fn(async (_p: string, t: readonly [number, number]) => routeAnswer(t));
			const load = staticChannels({ open: async () => fixtureReader(), fingerprint: () => fingerprint, fallback });
			await load('p', [tiles[0] + 1, tiles[1] + 1]);
			expect(load.counts).toEqual({ archive: 0, route: 1 });
		}
	});

	it('asks the route for every tile of an archive in the old format (built at 1 km², without the small channels)', async () => {
		const { dem } = await meta;
		const real = fixtureReader();
		expect(((await real.getMetadata()) as { format: string }).format).toBe(CHANNEL_ARCHIVE_FORMAT);
		const old: ChannelArchiveReader = { getMetadata: async () => ({ ...((await real.getMetadata()) as object), format: 'water-management-channels/1', minKm2: 1 }), getZxy: vi.fn((z, x, y) => real.getZxy(z, x, y)) };
		const fallback = vi.fn(async (_p: string, t: readonly [number, number]) => routeAnswer(t));
		const load = staticChannels({ open: async () => old, fingerprint: () => dem.fingerprint, fallback });
		await load('p', [102, -169]);
		expect(old.getZxy).not.toHaveBeenCalled();
		expect(load.counts).toEqual({ archive: 0, route: 1 });
	});

	it('asks the route when the file is not a channels archive, or can’t be read, and opens it once', async () => {
		const { dem } = await meta;
		const notChannels = { getMetadata: async () => ({ name: 'a basemap' }), getZxy: vi.fn() };
		const a = staticChannels({ open: async () => notChannels, fingerprint: () => dem.fingerprint, fallback: async (_p, t) => routeAnswer(t) });
		await a('p', [1, 1]);
		expect(notChannels.getZxy).not.toHaveBeenCalled();
		const open = vi.fn(async (): Promise<ChannelArchiveReader> => {
			throw new Error('404');
		});
		const b = staticChannels({ open, fingerprint: () => dem.fingerprint, fallback: async (_p, t) => routeAnswer(t) });
		await b('p', [1, 1]);
		await b('p', [1, 2]);
		expect(b.counts).toEqual({ archive: 0, route: 2 });
		expect(open).toHaveBeenCalledTimes(1);
	});

	it('asks the route for a tile whose read fails, and keeps reading the archive for the next', async () => {
		const { dem, tiles } = await meta;
		const real = fixtureReader();
		let fail = true;
		const flaky: ChannelArchiveReader = {
			getMetadata: () => real.getMetadata(),
			getZxy: async (z, x, y) => {
				if (fail) {
					fail = false;
					throw new Error('network');
				}
				return real.getZxy(z, x, y);
			}
		};
		const load = staticChannels({ open: async () => flaky, fingerprint: () => dem.fingerprint, fallback: async (_p, t) => routeAnswer(t) });
		const mid: [number, number] = [tiles[0] + 1, tiles[1] + 1];
		expect((await load('p', mid)).dataset.label).toBe('route');
		expect((await load('p', mid)).cached).toBe(true);
	});
});
