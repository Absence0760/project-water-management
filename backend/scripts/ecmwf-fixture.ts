// The committed copy's ECMWF ENS issue (issue #604 R4-C): one invented issue
// (fromMirrorEcmwf.ts ECMWF_FIXTURE) over a 4 × 4 block of 0.1° cells, in the
// layout ingest/ecmwf_forecast.py writes, plus its manifest and `ecmwf/index.json`.
// Called by gen-mirror-fixture.ts (pnpm gen:mirror-fixture), so
// src/mirror/fixture.test.ts covers it too. No real place or measurement:
// the mean is a repeating pattern, the quantiles fixed shares of it.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { AbsolutePath } from '@zarrita/storage';
import { ECMWF_FIXTURE } from '../src/feeds/fromMirrorEcmwf.js';
import { ECMWF_DAYS, ECMWF_ORIGIN, ECMWF_REGION, ECMWF_SIZE, ECMWF_STATS, ECMWF_STEP, ecmwfProduct, writeEcmwfIndex, writeEcmwfIssue } from '../src/ingest/ecmwf.js';
import { manifestHash } from '../src/mirror/manifest.js';
import type { MirrorStore } from '../src/mirror/store.js';

/** The fixture's mean at (day, row, col) of its block, mm. */
export const ecmwfFixtureMean = (d: number, i: number, j: number) => ((d * 5 + i * 3 + j * 2) % 9) * 1.2;
/** Each statistic as a share of the mean: p10, p50 and p90 spread around it. */
const SHARE: Record<(typeof ECMWF_STATS)[number], number> = { mean: 1, p10: 0.2, p50: 0.8, p90: 1.9 };

export async function writeEcmwfFixture(store: MirrorStore, fetchedAt = '2026-02-09T10:00:00Z'): Promise<void> {
	const { issue, block } = ECMWF_FIXTURE;
	const n = block.h * block.w;
	const values = new Float32Array(ECMWF_STATS.length * ECMWF_DAYS * n);
	ECMWF_STATS.forEach((s, si) => {
		for (let d = 0; d < ECMWF_DAYS; d++) for (let i = 0; i < block.h; i++) for (let j = 0; j < block.w; j++) values[(si * ECMWF_DAYS + d) * n + i * block.w + j] = ecmwfFixtureMean(d, i, j) * SHARE[s];
	});
	await writeEcmwfIssue(store, issue, block, values, 4);
	// valuesSha256: each day's mean over the whole region (NaN outside the block), as the job hashes it.
	const files = Array.from({ length: ECMWF_DAYS }, (_, d) => {
		const day = new Float32Array(ECMWF_SIZE.rows * ECMWF_SIZE.cols).fill(Number.NaN);
		for (let i = 0; i < block.h; i++) for (let j = 0; j < block.w; j++) day[(block.y0 + i) * ECMWF_SIZE.cols + block.x0 + j] = values[d * n + i * block.w + j]!;
		const ymd = issue.replaceAll('-', '');
		return {
			url: `https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com/${ymd}/00z/ifs/0p1/enfo/${ymd}000000-${24 * (d + 1)}h-enfo-ef-sfc.grib2`,
			etag: null,
			lastModified: null,
			size: null,
			valuesSha256: manifestHash([day]),
			revision: 1,
			fetchedAt
		};
	});
	const manifest = {
		product: ecmwfProduct(issue),
		revision: 1,
		region: { ...ECMWF_REGION },
		grid: { origin: { ...ECMWF_ORIGIN }, step: ECMWF_STEP },
		years: { first: Number(issue.slice(0, 4)), last: Number(fromEpochDay(toEpochDay(issue) + ECMWF_DAYS - 1).slice(0, 4)) },
		finalThrough: null,
		prelimThrough: null,
		files,
		changes: []
	};
	await store.set(`/${ecmwfProduct(issue)}/manifest.json` as AbsolutePath, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
	await writeEcmwfIndex(store, { issues: [issue], archived: [] });
}
