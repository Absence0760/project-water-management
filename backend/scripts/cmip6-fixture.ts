// The committed copy's NEX-GDDP-CMIP6 monthly aggregates (issue #621 slice
// 2): three invented models, SYN-A, SYN-B and SYN-C, each with `historical`,
// `ssp245` and `ssp585`, in the layout ingest/cmip6_delta.py writes
// (`cmip6/<model>/<scenario>` groups holding `pr_mm`, `tasmax_c` and
// `tasmin_c`, dims (year, month, lat, lon) on the 0.25° grid, a manifest per
// product with each file's version and `license` attribute, and
// `cmip6/index.json`), so the future yield (slices 3-4) reads in dev, CI and
// e2e what it would read in production. Called by gen-mirror-fixture.ts
// (pnpm gen:mirror-fixture), so src/mirror/fixture.test.ts covers it too, and
// ingest/test_cmip6_delta.py checks its layout against the Python writer's.
// No real model, place or value: a winter-wet monthly rain pattern drier
// under each SSP, and a seasonal temperature cycle warmer under each.
//
// What it holds (CMIP6_FIXTURE): historical 2013–2014, the SSPs 2036 and
// 2066 (one year in each future window), over a 3 × 3 block of 0.25° cells
// at 33.875–33.375° S, 21.125–21.625° E (the DB and e2e tests' catchment,
// drawn round 33.7° S, 21.3° E, falls inside it); every other cell is NaN.
// The files' names, versions and licence attributes follow
// ingest/fixtures/cmip6/make_cmip6_fixture.py's synthetic tree (SYN-A's
// ssp245 tasmax 2036 is a v1.1, SYN-C's historical files say CC BY-SA 4.0,
// its ssp585 pr 2066 carries no licence attribute).
import type { AbsolutePath } from '@zarrita/storage';
import * as zarr from 'zarrita';
import { CODECS } from '../src/mirror/arrays.js';
import { gridOf, MIRROR_REGION, regionSize } from '../src/mirror/grid.js';
import { type Manifest, manifestHash, writeManifest } from '../src/mirror/manifest.js';
import type { MirrorStore } from '../src/mirror/store.js';

const STEP = 0.25;
const SCENARIOS = ['historical', 'ssp245', 'ssp585'] as const;
type Scenario = (typeof SCENARIOS)[number];
const VARIABLES = ['pr', 'tasmax', 'tasmin'] as const;
type Variable = (typeof VARIABLES)[number];
const ARRAYS: Record<Variable, string> = { pr: 'pr_mm', tasmax: 'tasmax_c', tasmin: 'tasmin_c' };
/** Each scenario's record: the year axis (ingest/cmip6_delta.py RECORD). */
const RECORD: Record<Scenario, [number, number]> = { historical: [1950, 2014], ssp245: [2015, 2100], ssp585: [2015, 2100] };
const CHUNKS = [1, 12, 22, 31];

// ingest/cmip6_delta.py's words, as the groups carry them (test_cmip6_delta.py checks they agree).
const SOURCE = 'NASA Earth Exchange Global Daily Downscaled Projections, CMIP6 (NEX-GDDP-CMIP6), s3://nex-gddp-cmip6';
const LICENCE =
	'CC0 1.0 (Registry of Open Data on AWS, NEX-GDDP-CMIP6, read 2026-10-27: every output under CC0 since September 2022; first released under CC BY-SA 4.0). Each file\'s own license attribute is in the manifest.';
const CREDIT =
	'NEX-GDDP-CMIP6 was prepared by the Climate Analytics Group and NASA Ames Research Center using the NASA Earth Exchange, from the CMIP6 models of the modelling groups listed by model.';
const CITATION = 'Thrasher, B., Wang, W., Michaelis, A. et al. NASA Global Daily Downscaled Projections, CMIP6. Scientific Data 9, 262 (2022). https://doi.org/10.1038/s41597-022-01393-4';
const METHOD =
	"Monthly aggregates of NEX-GDDP-CMIP6's daily values on its 0.25 deg cells inside D1: pr the month's total (mm), tasmax and tasmin the month's mean (deg C); a cell with any day missing is NaN for the month.";
const FIXTURE_LICENSE = 'CC0 1.0 Universal (synthetic fixture: invented values)';
const FIXTURE_OLD_LICENSE = 'CC BY-SA 4.0 (synthetic fixture: invented values)';

export const CMIP6_FIXTURE = {
	models: {
		'SYN-A': { variant: 'r1i1p1f1', grid: 'gn', calendar: 'proleptic_gregorian' },
		'SYN-B': { variant: 'r1i1p1f2', grid: 'gr', calendar: 'noleap' },
		'SYN-C': { variant: 'r1i1p1f1', grid: 'gn', calendar: '360_day' }
	} as Record<string, { variant: string; grid: string; calendar: string }>,
	years: { historical: [2013, 2014], ssp245: [2036, 2066], ssp585: [2036, 2066] } as Record<Scenario, number[]>,
	/** The cells written: rows y0… (35.375° S is row 0) and columns x0… (10.125° E is column 0). */
	block: { y0: 6, x0: 44, h: 3, w: 3 },
	fetchedAt: '2026-02-09T00:00:00Z'
} as const;

const SCEN = { historical: 0, ssp245: 1, ssp585: 2 } as const;

/** The invented monthly value of `variable` (mm, or °C) for month `mo` (1–12) of `year` at block cell (i north, j east). */
export function cmip6FixtureValue(model: string, scenario: Scenario, variable: Variable, year: number, mo: number, i: number, j: number): number {
	const mi = model.charCodeAt(model.length - 1) - 65;
	const s = SCEN[scenario];
	if (variable === 'pr') {
		const winter = mo >= 5 && mo <= 8 ? 2.5 : 1;
		return Math.fround((20 + ((mo * 7 + i * 3 + j * 5 + year + mi * 11) % 13) * 2) * winter * [1, 0.9, 0.8][s]! * (1 - 0.03 * mi));
	}
	const tmax = 22 + 7 * Math.cos((2 * Math.PI * (mo - 1)) / 12) + [0, 1.5, 3][s]! + mi * 0.3 + (i + j) * 0.1;
	return Math.fround(variable === 'tasmax' ? tmax : tmax - 11 - (i % 3));
}

const fileName = (model: string, scenario: Scenario, variable: Variable, year: number, version: string | null) => {
	const m = CMIP6_FIXTURE.models[model]!;
	return `${variable}_day_${model}_${scenario}_${m.variant}_${m.grid}_${year}${version ? `_${version}` : ''}.nc`;
};
const fileUrl = (model: string, scenario: Scenario, variable: Variable, year: number, version: string | null) =>
	`s3://nex-gddp-cmip6/NEX-GDDP-CMIP6/${model}/${scenario}/${CMIP6_FIXTURE.models[model]!.variant}/${variable}/${fileName(model, scenario, variable, year, version)}`;
const versionOf = (model: string, scenario: Scenario, variable: Variable, year: number) => (model === 'SYN-A' && scenario === 'ssp245' && variable === 'tasmax' && year === 2036 ? 'v1.1' : null);
const licenseOf = (model: string, scenario: Scenario, variable: Variable, year: number): string | null =>
	model === 'SYN-C' && scenario === 'ssp585' && variable === 'pr' && year === 2066 ? null : model === 'SYN-C' && scenario === 'historical' ? FIXTURE_OLD_LICENSE : FIXTURE_LICENSE;

const { rows, cols } = regionSize(MIRROR_REGION, STEP);
const enc = new TextEncoder();

async function group(store: MirrorStore, p: string, attributes: Record<string, unknown> = {}) {
	await zarr.create(zarr.root(store).resolve(p), { attributes });
}

/** Write the cmip6 part of the fixture copy into `store` (whose root group exists). */
export async function writeCmip6Fixture(store: MirrorStore): Promise<void> {
	const g = gridOf(MIRROR_REGION, STEP);
	const { y0, x0, h, w } = CMIP6_FIXTURE.block;
	await group(store, 'cmip6');
	const index: Record<string, Record<string, number[]>> = {};
	for (const [model, spec] of Object.entries(CMIP6_FIXTURE.models)) {
		await group(store, `cmip6/${model}`);
		index[model] = {};
		for (const scenario of SCENARIOS) {
			const product = `cmip6/${model}/${scenario}`;
			const [first, last] = RECORD[scenario];
			await group(store, product, {
				model,
				scenario,
				variant: spec.variant,
				gridLabel: spec.grid,
				calendar: spec.calendar,
				firstYear: first,
				variables: { ...ARRAYS },
				source: SOURCE,
				licence: LICENCE,
				credit: CREDIT,
				citation: CITATION,
				method: METHOD,
				region: { ...MIRROR_REGION },
				grid: g
			});
			const files: Manifest['files'] = [];
			for (const variable of VARIABLES) {
				const arr = await zarr.create(zarr.root(store).resolve(`${product}/${ARRAYS[variable]}`), {
					shape: [last - first + 1, 12, rows, cols],
					chunkShape: CHUNKS,
					dtype: 'float32',
					fillValue: Number.NaN,
					codecs: CODECS,
					dimensionNames: ['year', 'month', 'lat', 'lon'],
					attributes: {
						units: variable === 'pr' ? 'mm' : 'degC',
						aggregation: variable === 'pr' ? 'monthly total' : 'monthly mean',
						long_name: {
							pr: 'monthly precipitation total',
							tasmax: 'monthly mean of daily maximum near-surface air temperature',
							tasmin: 'monthly mean of daily minimum near-surface air temperature'
						}[variable],
						firstYear: first,
						region: { ...MIRROR_REGION },
						grid: g
					}
				});
				for (const year of CMIP6_FIXTURE.years[scenario]) {
					const block = new Float32Array(12 * h * w);
					const region = Array.from({ length: 12 }, () => new Float32Array(rows * cols).fill(Number.NaN));
					for (let mo = 0; mo < 12; mo++) {
						for (let i = 0; i < h; i++) {
							for (let j = 0; j < w; j++) {
								const v = cmip6FixtureValue(model, scenario, variable, year, mo + 1, i, j);
								block[(mo * h + i) * w + j] = v;
								region[mo]![(y0 + i) * cols + x0 + j] = v;
							}
						}
					}
					await zarr.set(arr, [year - first, null, zarr.slice(y0, y0 + h), zarr.slice(x0, x0 + w)], { data: block, shape: [12, h, w], stride: [h * w, w, 1] });
					const version = versionOf(model, scenario, variable, year);
					files.push({
						url: fileUrl(model, scenario, variable, year, version),
						etag: null,
						lastModified: null,
						size: null,
						valuesSha256: manifestHash(region),
						revision: 1,
						fetchedAt: CMIP6_FIXTURE.fetchedAt,
						version: version ?? 'v1.0',
						license: licenseOf(model, scenario, variable, year)
					});
				}
			}
			const years = CMIP6_FIXTURE.years[scenario];
			await writeManifest(store, {
				product,
				revision: 1,
				region: { ...MIRROR_REGION },
				grid: g,
				years: { first: years[0]!, last: years.at(-1)! },
				finalThrough: null,
				prelimThrough: null,
				files: files.sort((a, b) => (a.url < b.url ? -1 : 1)),
				changes: []
			} as Manifest);
			index[model][scenario] = [...years];
		}
	}
	await store.set('/cmip6/index.json' as AbsolutePath, enc.encode(`${JSON.stringify({ products: index }, null, 2)}\n`));
}
