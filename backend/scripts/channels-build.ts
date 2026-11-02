// Precompute the elevation model's channels into one PMTiles archive
// (src/delineation/channelArchive.ts; docs/maps.md § The elevation model's
// channels, Precomputed; docs/deployment.md § Map tiles):
//
//   tsx scripts/channels-build.ts --dem <file | http(s):// | s3://> --out <channels.pmtiles> [--bbox w,s,e,n]
//   tsx scripts/channels-build.ts --fixture
//
// --dem defaults to DEM_URL; --bbox to the DEM's bounds. Every 0.2° tile is
// routed with the same code and parameters as GET …/map/channels, about 0.35 s
// and 15 KB (gzip) a tile on the GLO-30 DEM, so a run of the Western Cape
// (~750 tiles) takes ~5 minutes and writes ~11 MB. `bin/tiles-dev.sh channels`
// (pnpm dev:tiles:channels) runs it on the cached relief DEM and uploads the
// result to MinIO.
//
// --fixture rewrites backend/fixtures/channels/synthetic-channels.pmtiles from
// the synthetic DEM (pnpm gen:channels-fixture); channelArchive.test.ts fails
// until it is rerun after a change to the channels or the synthetic terrain.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChannelArchive } from '../src/delineation/channelArchive.js';
import { openDem } from '../src/delineation/dem.js';
import { FIXTURE_FILE } from '../src/delineation/fixture.js';

export const CHANNELS_FIXTURE_FILE = new URL('../fixtures/channels/synthetic-channels.pmtiles', import.meta.url);

export interface BuildArgs {
	dem: string;
	out: string;
	bbox: [number, number, number, number] | null;
}

/** The arguments, paths resolved from the folder the command was typed in; a string is the problem. */
export function parseBuildArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): BuildArgs | string {
	const cwd = env.INIT_CWD ?? process.cwd();
	if (argv.includes('--fixture')) {
		if (argv.length > 1) return '--fixture takes no other argument';
		return { dem: fileURLToPath(FIXTURE_FILE), out: fileURLToPath(CHANNELS_FIXTURE_FILE), bbox: null };
	}
	let dem = env.DEM_URL?.trim() ?? '';
	let out = '';
	let bbox: BuildArgs['bbox'] = null;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		const v = argv[i + 1];
		if (v === undefined || v.startsWith('--')) return `${a} needs a value`;
		i++;
		if (a === '--dem') dem = v;
		else if (a === '--out') out = v;
		else if (a === '--bbox') {
			const n = v.split(',').map(Number);
			if (n.length !== 4 || n.some((x) => !Number.isFinite(x)) || n[0]! >= n[2]! || n[1]! >= n[3]!) return '--bbox is w,s,e,n in degrees (west < east, south < north)';
			bbox = n as [number, number, number, number];
		} else return `unknown argument ${a}`;
	}
	if (!dem) return 'name the DEM: --dem <file | URL> (or set DEM_URL)';
	if (!out) return 'name the archive to write: --out <channels.pmtiles>';
	const local = (p: string) => (/^(s3|https?):\/\//.test(p) ? p : resolve(cwd, p));
	return { dem: local(dem), out: resolve(cwd, out), bbox };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = parseBuildArgs(process.argv.slice(2));
	if (typeof args === 'string') {
		console.error(`${args}\nusage: tsx scripts/channels-build.ts --dem <file | URL> --out <channels.pmtiles> [--bbox w,s,e,n] | --fixture`);
		process.exit(2);
	}
	const t0 = Date.now();
	let lastLog = 0;
	const { archive, meta, built, skipped } = await buildChannelArchive(openDem(args.dem), {
		bbox: args.bbox ?? undefined,
		onTile: (done, total) => {
			if (Date.now() - lastLog < 5000 && done < total) return;
			lastLog = Date.now();
			const s = (Date.now() - t0) / 1000;
			console.log(`${done}/${total} tiles, ${s.toFixed(0)} s${done < total ? `, ~${((s / done) * (total - done)).toFixed(0)} s to go` : ''}`);
		}
	});
	writeFileSync(args.out, archive);
	console.log(`Wrote ${args.out}: ${built} tiles (${skipped} off the DEM, left to the route), ${(archive.length / 1024).toFixed(0)} KiB, DEM ${meta.dem.label} (${meta.dem.fingerprint}).`);
}
