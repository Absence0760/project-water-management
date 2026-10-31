// The evidence pack's reproduction bundle (issue #71, docs/evidence-pack.md §
// Reproduction): built from real engine runs of a small synthetic catchment
// (testing/packBundle.ts), it checks clean and re-runs to the same results
// digest; the same pack gives the same bytes; and each kind of tampering fails
// its own check, each beside a positive control. The series CSV and the
// results digest are pinned too.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RunInputsSnapshot } from '../compare';
import { canonicalJson } from '../manifest';
import { assessmentPackFixture, ASSESSMENT_FIXTURE, fixtureObservations, fixtureObservationsV1, headlinePackFixture, HEADLINE_KINDS, packBundleFixture, PACK_FIXTURE_ID } from '../testing/packBundle';
import { ENGINE_VERSION } from '../version';
import { crc32, storedZip, zip, ZipArchive } from '../zip';
import {
	BUNDLE_ASSESSMENT_FILE,
	BUNDLE_ASSESSMENT_REPORT,
	BUNDLE_BACKGROUND_INPUT,
	BUNDLE_ZIP_LIMITS,
	buildPackBundle,
	bundleRainCredits,
	bundleRunInput,
	checkPackBundle,
	COMBINED_NOT_INCLUDED,
	HEADLINE_NOT_INCLUDED,
	PACK_BUNDLE_VERSION,
	parseSeriesCsv,
	runResultsDigest,
	runResultsText,
	seriesCsv,
	type PackBundleIndex
} from './bundle';
import { packManifestText, packShortCode } from './pack';

const hash = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex');
const packInput = (opts: { application?: boolean } = {}) => packBundleFixture(hash, opts);

/** Open a bundle, change its entries, fix bundle.json's hashes (unless `keepIndex`), and zip it again. */
async function rezip(bytes: Uint8Array<ArrayBuffer>, edit: (files: Map<string, string>) => void, keepIndex = false): Promise<Uint8Array<ArrayBuffer>> {
	const archive = await ZipArchive.open(bytes);
	const files = new Map<string, string>();
	for (const n of archive.names) files.set(n, new TextDecoder().decode(await archive.read(n)));
	edit(files);
	if (!keepIndex) {
		const index = JSON.parse(files.get('bundle.json')!) as PackBundleIndex;
		index.files = {};
		for (const n of [...files.keys()].sort()) if (n !== 'bundle.json') index.files[n] = hash(files.get(n)!);
		files.set('bundle.json', canonicalJson(index));
	}
	return zip([...files.keys()].sort().map((name) => ({ name, data: new TextEncoder().encode(files.get(name)!) })));
}

const failing = (r: Awaited<ReturnType<typeof checkPackBundle>>) => r.checks.filter((c) => !c.ok).map((c) => c.id);

describe('buildPackBundle + checkPackBundle', () => {
	const input = packInput();

	it('builds a bundle that checks clean and re-runs both runs to the same results digest', async () => {
		const built = await buildPackBundle(input, hash);
		expect(built.sha256).toBe(hash(built.bytes));
		const manifestSha256 = hash(packManifestText(input.manifest));
		expect(built.index.version).toBe(PACK_BUNDLE_VERSION);
		expect(built.index.pack).toEqual({ id: PACK_FIXTURE_ID, version: 1, manifestSha256, shortCode: packShortCode(manifestSha256) });
		expect(Object.keys(built.index.files).sort()).toEqual(
			[
				'README.md',
				'manifest.json',
				'runs/application/input.json',
				'runs/application/results.json',
				'runs/baseline/input.json',
				'runs/baseline/results.json',
				'scenario.json',
				// Both runs share their rain: one file.
				`series/${input.baseline.inputs.series.rain_catchment_mm!.valuesSha256}.csv`
			].sort()
		);
		const r = await checkPackBundle(built.bytes, { hash, expectManifestSha256: manifestSha256 });
		expect(failing(r)).toEqual([]);
		expect(r.ok).toBe(true);
		expect(r.checks.map((c) => c.id)).toEqual(['archive', 'files', 'manifest', 'runs', 'inputs:baseline', 'inputs:application', 'changes', 'scenario', 'results:baseline', 'results:application', 'reproduce:baseline', 'reproduce:application', 'headline']);
		// No headline board in this report: said, not failed (#523 G2).
		expect(r.checks.find((c) => c.id === 'headline')!.detail).toBe('no headline board to re-run (the report has none)');
		expect(r.headline).toBe('none');
		expect(r.pack).toEqual(built.index.pack);
		expect(r.engine).toEqual({ here: ENGINE_VERSION, runs: [ENGINE_VERSION, ENGINE_VERSION] });
		// manifest.json IS the manifest's canonical text: its SHA-256 is the pack's hash.
		const archive = await ZipArchive.open(built.bytes);
		expect(hash(await archive.read('manifest.json'))).toBe(manifestSha256);
		expect(new TextDecoder().decode(await archive.read('README.md'))).toContain(`pnpm reproduce:pack path/to/pack-${packShortCode(manifestSha256)}.zip`);
	});

	it('credits the rain sources its input series hold in the README (issue #604 R4-E), and none on CHIRPS alone', async () => {
		const plain = new TextDecoder().decode(await (await ZipArchive.open((await buildPackBundle(input, hash)).bytes)).read('README.md'));
		expect(plain).not.toContain('## Data credits');
		expect(bundleRainCredits(input)).toEqual([]);
		// The baseline filled gaps from ERA5-Land and IMERG Late V07; the application's forecast came from an ECMWF feed.
		const gapRain = { products: [{ product: 'era5l', version: null, present: true }, { product: 'imerg_late', version: 'V07', present: true }, { product: 'imerg_late', version: 'V08', present: false }] };
		const withProducts = structuredClone(input);
		withProducts.baseline.summary = { ...(withProducts.baseline.summary as object), gapRain };
		withProducts.application!.inputs = { ...withProducts.application!.inputs, forecastRainSource: 'ecmwf_ens' };
		const credits = bundleRainCredits(withProducts);
		expect(credits.map((c) => c.product)).toEqual(['era5l', 'imerg_late', 'ecmwf_ens']);
		// A forecast an ECMWF feed wrote only some days of still owes its credit.
		const partly = structuredClone(input);
		partly.application!.inputs = { ...partly.application!.inputs, forecastRainSource: 'other', forecastRainEcmwf: true };
		expect(bundleRainCredits(partly).map((c) => c.product)).toEqual(['ecmwf_ens']);
		// Reference ET from an AgERA5 feed (R5-E): the products the run read, each once across both runs, after the rain's.
		const et0 = structuredClone(input);
		et0.baseline.inputs = { ...et0.baseline.inputs, et0Products: ['agera5_et0'] };
		et0.application!.inputs = { ...et0.application!.inputs, et0Products: ['power_et0', 'agera5_et0'] };
		expect(bundleRainCredits(et0).map((c) => c.product)).toEqual(['agera5_et0', 'power_et0']);
		// The fixture's report records no creation day; a real pack's is the baseline run's, whose year Copernicus's line takes.
		withProducts.manifest = { ...withProducts.manifest, report: { ...withProducts.manifest.report, identity: { ...withProducts.manifest.report.identity, baseline: { ...withProducts.manifest.report.identity?.baseline, createdAt: '2026-10-27T08:00:00.000Z' } } } } as typeof withProducts.manifest;
		const year = '2026';
		const readme = new TextDecoder().decode(await (await ZipArchive.open((await buildPackBundle(withProducts, hash)).bytes)).read('README.md'));
		expect(readme).toContain('## Data credits');
		expect(readme).toContain(`- ERA5-Land: Contains modified Copernicus Climate Change Service information ${year}. Neither the European Commission nor ECMWF is responsible`);
		expect(readme).toContain('GPM IMERG Late Precipitation L3 1 day 0.1 degree x 0.1 degree V07');
		// A version the run's input didn't have is not credited.
		expect(readme).not.toContain('degree V08');
		expect(readme).toContain('- ECMWF ENS forecast: ECMWF open data, CC BY 4.0');
	});

	it('is deterministic: the same pack gives the same bytes and SHA-256', async () => {
		const a = await buildPackBundle(input, hash);
		const b = await buildPackBundle(JSON.parse(JSON.stringify(input)), hash);
		expect(b.sha256).toBe(a.sha256);
		expect(b.bytes).toEqual(a.bytes);
	});

	it('builds a baseline pack without a scenario.json or an application run', async () => {
		const built = await buildPackBundle(packInput({ application: false }), hash);
		expect(built.index.runs.application).toBeNull();
		expect(Object.keys(built.index.files)).not.toContain('scenario.json');
		const r = await checkPackBundle(built.bytes, { hash });
		expect(failing(r)).toEqual([]);
		expect(r.checks.map((c) => c.id)).toEqual(['archive', 'files', 'manifest', 'runs', 'inputs:baseline', 'results:baseline', 'reproduce:baseline']);
	});

	it('skips the re-run with rerun: false', async () => {
		const r = await checkPackBundle((await buildPackBundle(input, hash)).bytes, { hash, rerun: false });
		expect(r.ok).toBe(true);
		expect(r.checks.some((c) => c.id.startsWith('reproduce:'))).toBe(false);
	});

	it('re-runs a run with its CHIRPS series choice from input.json, whose warning is in its results (issue #561)', async () => {
		const withChoice = packBundleFixture(hash, { application: false, seriesChoice: true });
		expect((withChoice.baseline.summary as { warnings: string[] }).warnings.some((w) => w.startsWith('the run read the CHIRPS series “CHIRPS boundary”'))).toBe(true);
		const built = await buildPackBundle(withChoice, hash);
		const r = await checkPackBundle(built.bytes, { hash });
		expect(failing(r)).toEqual([]);
		// Without it the re-run has no warning, so its results differ: the re-run read it.
		const stripped = await rezip(built.bytes, (f) => {
			const inp = JSON.parse(f.get('runs/baseline/input.json')!) as RunInputsSnapshot;
			delete inp.seriesChoice;
			f.set('runs/baseline/input.json', canonicalJson(inp));
		});
		expect(failing(await checkPackBundle(stripped, { hash }))).toEqual(['reproduce:baseline']);
	});

	it('rebuilds a run’s input with what the engine reads beside settings and model: seriesChoice, and a forecast run’s source (issue #561)', () => {
		const snap = { settings: {}, model: { nodes: [], crops: [], cropAreas: [], transfers: [] } } as unknown as RunInputsSnapshot;
		const series = { rain_catchment_mm: { startDate: '2020-01-01', values: [1] } };
		const choice = { rain_chirps_mm: { name: 'A', others: [] } };
		expect(bundleRunInput(snap, series)).toEqual({ settings: {}, model: snap.model, series });
		expect(bundleRunInput({ ...snap, seriesChoice: choice, forecastRainSource: 'chirps_gefs' }, series)).toEqual({ settings: {}, model: snap.model, series, seriesChoice: choice, forecastRainSource: 'chirps_gefs' });
		expect(bundleRunInput({ ...snap, forecastRainSource: 'other' }, series).forecastRainSource).toBe('other');
		// The rainfall stations' details (issue #553), which the station forcing reads.
		const stations = { 'b1c3e1f0-0000-4000-8000-000000000001': { name: 'Gauge A', mapMm: 745, mapSource: 'study', lat: -33.9, lon: 18.8, isCatchmentGauge: true } };
		expect(bundleRunInput({ ...snap, stations }, series)).toEqual({ settings: {}, model: snap.model, series, stations });
		for (const bad of [null, [], 'x']) expect(bundleRunInput({ ...snap, stations: bad as never }, series)).not.toHaveProperty('stations');
		// Anything else from an input.json no hash covers is left out.
		for (const bad of [null, 'gefs', 3]) expect(bundleRunInput({ ...snap, forecastRainSource: bad as never }, series)).not.toHaveProperty('forecastRainSource');
	});

	it('refuses to build from input values that fail their SHA-256', async () => {
		const bad = structuredClone(input);
		bad.baseline.values = { ...bad.baseline.values, rain_catchment_mm: [99, ...bad.baseline.values.rain_catchment_mm!.slice(1)] };
		await expect(buildPackBundle(bad, hash)).rejects.toThrow(/fails its SHA-256 check/);
	});

	describe('§ 1’s locality map (evidence-12)', () => {
		it('draws the figure again from the manifest and checks its SVG’s SHA-256; the README says so', async () => {
			const built = await buildPackBundle(packBundleFixture(hash, { locality: true }), hash);
			const r = await checkPackBundle(built.bytes, { hash, rerun: false });
			expect(failing(r)).toEqual([]);
			expect(r.checks.map((c) => c.id)).toEqual(['archive', 'files', 'manifest', 'figure:locality', 'runs', 'inputs:baseline', 'inputs:application', 'changes', 'scenario', 'results:baseline', 'results:application', 'headline']);
			expect(r.checks.find((c) => c.id === 'figure:locality')!.detail).toMatch(/^the locality map drawn again from the manifest's 4 map features hashes to [0-9a-f]{64}, the SHA-256 the manifest names$/);
			const archive = await ZipArchive.open(built.bytes);
			expect(new TextDecoder().decode(await archive.read('README.md'))).toContain('`figure:locality`');
		});

		it('a manifest naming another SVG hash fails figure:locality alone', async () => {
			const built = await buildPackBundle(packBundleFixture(hash, { locality: { svgSha256: 'c'.repeat(64) } }), hash);
			const r = await checkPackBundle(built.bytes, { hash, rerun: false });
			expect(failing(r)).toEqual(['figure:locality']);
			expect(r.checks.find((c) => c.id === 'figure:locality')!.detail).toContain(`not the ${'c'.repeat(64)} the manifest names`);
		});

		it('a figure drawn by other drawing rules says which engine to check out', async () => {
			const input = packBundleFixture(hash, { locality: true });
			(input.manifest.report.localityMap as { version: string }).version = 'locality-0';
			const r = await checkPackBundle((await buildPackBundle(input, hash)).bytes, { hash, rerun: false });
			expect(failing(r)).toEqual(['figure:locality']);
			expect(r.checks.find((c) => c.id === 'figure:locality')!.detail).toMatch(/drawn with locality-0; this code draws locality-1: check out the engine that built the report/);
		});

		it('a pack from before evidence-12 has no figure, and no figure check: it checks as it always did (positive control above)', async () => {
			const built = await buildPackBundle(packBundleFixture(hash), hash);
			const r = await checkPackBundle(built.bytes, { hash, rerun: false });
			expect(r.ok).toBe(true);
			expect(r.checks.some((c) => c.id === 'figure:locality')).toBe(false);
			const archive = await ZipArchive.open(built.bytes);
			expect(new TextDecoder().decode(await archive.read('README.md'))).not.toContain('locality');
		});
	});

	describe('observed wet days (evidence-24: each source, and the dates together)', () => {
		const OBS = ['observations:days', 'observations:s2', 'observations:wofs'];
		const detail = (r: Awaited<ReturnType<typeof checkPackBundle>>, id: string) => r.checks.find((c) => c.id === id)!.detail;

		it('classifies each source’s dates again under its rule, and the dates together; the README says so', async () => {
			const built = await buildPackBundle(packBundleFixture(hash, { observations: true }), hash);
			const r = await checkPackBundle(built.bytes, { hash, rerun: false });
			expect(failing(r)).toEqual([]);
			expect(r.checks.map((c) => c.id).filter((id) => id.startsWith('observations:')).sort()).toEqual(OBS);
			expect(detail(r, 'observations:s2')).toBe("the Sentinel-2 dates of 1 dam over the baseline run's period (2001-10-01 to 2030-01-01) classify again from the manifest's 4 observed dates");
			expect(detail(r, 'observations:wofs')).toBe("the WOfS dates of 1 dam over the baseline run's period (2001-10-01 to 2030-01-01) classify again from the manifest's 5 observed dates");
			expect(detail(r, 'observations:days')).toBe(
				"the 8 dates either source saw over the baseline run's period (2001-10-01 to 2030-01-01) count again from the manifest's dates, each read by the sharper source that calls it"
			);
			const readme = new TextDecoder().decode(await (await ZipArchive.open(built.bytes)).read('README.md'));
			for (const id of OBS) expect(readme).toContain(`\`${id}\``);
			expect(readme).toContain('Copernicus Sentinel data');
		});

		it('a Sentinel-2 count its dates don’t give fails observations:s2 alone', async () => {
			const obs = fixtureObservations();
			obs.dams[0]!.sources.s2.wetDates = 2;
			const r = await checkPackBundle((await buildPackBundle(packBundleFixture(hash, { observations: obs }), hash)).bytes, { hash, rerun: false });
			expect(failing(r)).toEqual(['observations:s2']);
			expect(detail(r, 'observations:s2')).toContain('(Sentinel-2): 2 wet dates named, 1 counted');
		});

		it('a WOfS count its dates don’t give fails observations:wofs alone', async () => {
			const obs = fixtureObservations();
			obs.dams[0]!.sources.wofs.wetDates = 3;
			const r = await checkPackBundle((await buildPackBundle(packBundleFixture(hash, { observations: obs }), hash)).bytes, { hash, rerun: false });
			expect(failing(r)).toEqual(['observations:wofs']);
			expect(detail(r, 'observations:wofs')).toContain('(WOfS): 3 wet dates named, 2 counted');
		});

		it('a together count the two sources’ dates don’t give fails observations:days alone', async () => {
			const obs = fixtureObservations();
			obs.dams[0]!.dryDates = 2;
			const r = await checkPackBundle((await buildPackBundle(packBundleFixture(hash, { observations: obs }), hash)).bytes, { hash, rerun: false });
			expect(failing(r)).toEqual(['observations:days']);
			expect(detail(r, 'observations:days')).toContain('2 dry dates named, 3 counted');
		});

		it('a Sentinel-2 credit for other years than its dates fails observations:s2', async () => {
			const obs = fixtureObservations();
			expect(obs.sources[0]!.citation).toBe('Contains modified Copernicus Sentinel data 2020–2021, processed by Digital Earth Africa');
			obs.sources[0]!.citation = 'Contains modified Copernicus Sentinel data 2020, processed by Digital Earth Africa';
			const r = await checkPackBundle((await buildPackBundle(packBundleFixture(hash, { observations: obs }), hash)).bytes, { hash, rerun: false });
			expect(failing(r)).toEqual(['observations:s2']);
		});

		it('a period other than the baseline run’s the manifest records fails every observation check, though the manifest hashes', async () => {
			// Counted over a shorter span than the baseline: consistent with itself, and the manifest's hash covers it, but not the report's period.
			const obs = { ...fixtureObservations(), endDate: '2021-12-31' };
			const r = await checkPackBundle((await buildPackBundle(packBundleFixture(hash, { observations: obs }), hash)).bytes, { hash, rerun: false });
			expect(failing(r).sort()).toEqual(OBS);
			for (const id of OBS) expect(detail(r, id)).toContain("not the baseline run's period 2001-10-01–2030-01-01 the manifest records");
		});

		it('another counting version names the engine that built the report', async () => {
			const obs = { ...fixtureObservations(), version: 'dam-obs-9' } as unknown as ReturnType<typeof fixtureObservations>;
			const r = await checkPackBundle((await buildPackBundle(packBundleFixture(hash, { observations: obs }), hash)).bytes, { hash, rerun: false });
			expect(failing(r)).toEqual(['observations:wofs']);
			expect(detail(r, 'observations:wofs')).toMatch(/counted by dam-obs-9; this code counts dam-obs-1 and dam-obs-2: check out the engine that built the report \(\d+\.\d+\.\d+/);
		});

		it('a pack from before evidence-21 has no such check (positive control above)', async () => {
			const r = await checkPackBundle((await buildPackBundle(packBundleFixture(hash), hash)).bytes, { hash, rerun: false });
			expect(r.checks.some((c) => c.id.startsWith('observations:'))).toBe(false);
		});
	});

	describe('observed wet days of a pack drafted from evidence-21 to evidence-23 (dam-obs-1, WOfS alone)', () => {
		it('still classifies them again, as observations:wofs alone; the README says WOfS only', async () => {
			const built = await buildPackBundle(packBundleFixture(hash, { observations: fixtureObservationsV1() }), hash);
			const r = await checkPackBundle(built.bytes, { hash, rerun: false });
			expect(failing(r)).toEqual([]);
			expect(r.checks.filter((c) => c.id.startsWith('observations:')).map((c) => c.id)).toEqual(['observations:wofs']);
			expect(r.checks.find((c) => c.id === 'observations:wofs')!.detail).toBe("the observed wet days of 1 dam over the baseline run's period (2001-10-01 to 2030-01-01) classify again from the manifest's 5 observed dates");
			const readme = new TextDecoder().decode(await (await ZipArchive.open(built.bytes)).read('README.md'));
			expect(readme).toContain('`observations:wofs`');
			expect(readme).not.toContain('`observations:s2`');
		});

		it('a count the dates don’t give fails observations:wofs alone', async () => {
			const obs = fixtureObservationsV1();
			obs.dams[0]!.wetDates = 3;
			const r = await checkPackBundle((await buildPackBundle(packBundleFixture(hash, { observations: obs }), hash)).bytes, { hash, rerun: false });
			expect(failing(r)).toEqual(['observations:wofs']);
			expect(r.checks.find((c) => c.id === 'observations:wofs')!.detail).toContain('3 wet dates named, 2 counted');
		});

		it('a period other than the baseline run’s fails observations:wofs alone', async () => {
			const obs = { ...fixtureObservationsV1(), endDate: '2020-12-31' };
			const r = await checkPackBundle((await buildPackBundle(packBundleFixture(hash, { observations: obs }), hash)).bytes, { hash, rerun: false });
			expect(failing(r)).toEqual(['observations:wofs']);
			expect(r.checks.find((c) => c.id === 'observations:wofs')!.detail).toContain("not the baseline run's period 2001-10-01–2030-01-01 the manifest records");
		});
	});

	describe('§ 8 future yield (evidence-23)', () => {
		it('runs every pair again from the frozen factors; the README says so', async () => {
			const built = await buildPackBundle(packBundleFixture(hash, { future: true }), hash);
			const r = await checkPackBundle(built.bytes, { hash });
			expect(failing(r)).toEqual([]);
			expect(r.checks.find((c) => c.id === 'climate:delta')!.detail).toBe(
				`every pair of 12 cases (3 models × 2 SSPs × 2 horizons), method delta-1 run again with engine ${ENGINE_VERSION} from the frozen factors gives the manifest's § 8`
			);
			const archive = await ZipArchive.open(built.bytes);
			expect(new TextDecoder().decode(await archive.read('README.md'))).toContain('`climate:delta`');
			// Without re-running, only the table is read.
			expect((await checkPackBundle(built.bytes, { hash, rerun: false })).checks.find((c) => c.id === 'climate:delta')!.detail).toMatch(/freezes the factors of 12 cases.*not re-run$/);
		});

		it('a case that doesn’t follow from its factors fails climate:delta alone', async () => {
			const tampered = packBundleFixture(hash, { future: (r) => ({ ...r, cases: r.cases.map((c, i) => (i === 0 ? { ...c, ewrDaysChange: c.ewrDaysChange + 1 } : c)) }) });
			const r = await checkPackBundle((await buildPackBundle(tampered, hash)).bytes, { hash });
			expect(failing(r)).toEqual(['climate:delta']);
			expect(r.checks.find((c) => c.id === 'climate:delta')!.detail).toBe('1 of 12 cases give other values (SYN-A SSP2-4.5 mid)');
		});

		it('a pack from before evidence-23 has no such check (positive control above)', async () => {
			const r = await checkPackBundle((await buildPackBundle(packBundleFixture(hash), hash)).bytes, { hash, rerun: false });
			expect(r.checks.some((c) => c.id === 'climate:delta')).toBe(false);
		});
	});

	describe('tampering', () => {
		it('a file changed without bundle.json: files fails', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const r = await checkPackBundle(await rezip(bytes, (f) => f.set('README.md', f.get('README.md') + 'x'), true), { hash });
			expect(r.ok).toBe(false);
			expect(failing(r)).toEqual(['files']);
			// Positive control: the same rezip with no change checks clean.
			expect((await checkPackBundle(await rezip(bytes, () => {}, true), { hash, rerun: false })).ok).toBe(true);
		});

		it('an entry bundle.json does not list: archive fails', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const r = await checkPackBundle(await rezip(bytes, (f) => f.set('extra.txt', 'hi'), true), { hash });
			expect(failing(r)).toEqual(['archive']);
		});

		it('another manifest hash than expected: manifest fails', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const r = await checkPackBundle(bytes, { hash, expectManifestSha256: 'a'.repeat(64) });
			expect(failing(r)).toEqual(['manifest']);
		});

		it('a manifest edited with its hashes fixed: manifest fails (it no longer hashes to the pack’s hash)', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const r = await checkPackBundle(await rezip(bytes, (f) => f.set('manifest.json', f.get('manifest.json')!.replace('"Catchment"', '"Katchment"'))), { hash });
			expect(failing(r)).toEqual(['manifest']);
		});

		it('an input value changed, bundle.json fixed: the series fails its SHA-256, and nothing is re-run', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const file = `series/${input.baseline.inputs.series.rain_catchment_mm!.valuesSha256}.csv`;
			const r = await checkPackBundle(
				await rezip(bytes, (f) => {
					const lines = f.get(file)!.split('\n');
					lines[1] = lines[1]!.replace(/,.*$/, ',77');
					f.set(file, lines.join('\n'));
				}),
				{ hash }
			);
			expect(failing(r)).toEqual(['inputs:baseline', 'inputs:application', 'reproduce:baseline', 'reproduce:application']);
			expect(r.checks.find((c) => c.id === 'inputs:baseline')!.detail).toMatch(/fail their SHA-256 check/);
		});

		it('a baseline setting changed in input.json: inputs fails against the manifest', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const r = await checkPackBundle(
				await rezip(bytes, (f) => {
					const snap = JSON.parse(f.get('runs/baseline/input.json')!) as RunInputsSnapshot;
					(snap.settings as Record<string, unknown>).gr4j = { x1: 421, x2: 0, x3: 85, x4: 2.1, warmupDays: 90 };
					f.set('runs/baseline/input.json', canonicalJson(snap));
				}),
				{ hash }
			);
			expect(failing(r)).toContain('inputs:baseline');
			expect(r.checks.find((c) => c.id === 'inputs:baseline')!.detail).toMatch(/settings aren't the manifest's \(gr4j\.x1\)/);
		});

		it('scenario ops edited: scenario fails', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const r = await checkPackBundle(
				await rezip(bytes, (f) => f.set('scenario.json', f.get('scenario.json')!.replace('600000', '700000'))),
				{ hash, rerun: false }
			);
			expect(failing(r)).toEqual(['scenario']);
		});

		it('stored results the engine does not reproduce: results check, re-run fails and names the output', async () => {
			// A run whose stored daily output was altered before the bundle was built (so every hash agrees).
			const tampered = structuredClone(input);
			const out = tampered.baseline.series.find((s) => s.key === 'simulated_outflow')!;
			out.values = out.values.map((v, i) => (i === 100 && v !== null ? v + 1 : v));
			const built = await buildPackBundle(tampered, hash);
			const r = await checkPackBundle(built.bytes, { hash });
			expect(failing(r)).toEqual(['reproduce:baseline']);
			expect(r.checks.find((c) => c.id === 'reproduce:baseline')!.detail).toMatch(/1 daily output differs \(simulated_outflow\)/);
			// Positive control: the untampered pack reproduces.
			expect((await checkPackBundle((await buildPackBundle(input, hash)).bytes, { hash })).ok).toBe(true);
		});

		it('a stored summary other than the manifest’s: results fails', async () => {
			const tampered = structuredClone(input);
			(tampered.baseline.summary as Record<string, unknown>).tampered = 1;
			const r = await checkPackBundle((await buildPackBundle(tampered, hash)).bytes, { hash });
			expect(failing(r)).toEqual(['results:baseline', 'reproduce:baseline']);
		});

		it('a hostile many-entry zip is refused at its directory, beside a valid bundle (control)', async () => {
			const enc = new TextEncoder();
			const tiny = enc.encode('x');
			const crc = crc32(tiny);
			const many = storedZip([{ name: 'bundle.json', data: enc.encode('{}'), crc: crc32(enc.encode('{}')) }, ...Array.from({ length: 50_000 }, (_, i) => ({ name: `f${i}`, data: tiny, crc }))]);
			const r = await checkPackBundle(many, { hash });
			expect(failing(r)).toEqual(['archive']);
			expect((await checkPackBundle((await buildPackBundle(input, hash)).bytes, { hash, rerun: false })).ok).toBe(true);
		});

		it('many unlisted entries within the cap, and an index listing more files than a bundle holds, fail with a short message', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const flooded = await rezip(
				bytes,
				(f) => {
					for (let i = 0; i < BUNDLE_ZIP_LIMITS.maxEntries - 20; i++) f.set(`junk/${i}`, 'x');
				},
				true
			);
			const r = await checkPackBundle(flooded, { hash });
			expect(failing(r)).toEqual(['archive']);
			expect(r.checks[0]!.detail).toMatch(/and \d+ more/);
			expect(r.checks[0]!.detail.length).toBeLessThan(500);
			const bloated = await rezip(
				bytes,
				(f) => {
					const index = JSON.parse(f.get('bundle.json')!) as PackBundleIndex;
					for (let i = 0; i <= BUNDLE_ZIP_LIMITS.maxEntries; i++) index.files[`ghost/${i}`] = 'a'.repeat(64);
					f.set('bundle.json', canonicalJson(index));
				},
				true
			);
			expect(failing(await checkPackBundle(bloated, { hash }))).toEqual(['archive']);
		});

		it('not a zip: archive fails, never throws', async () => {
			const r = await checkPackBundle(new TextEncoder().encode('nope'), { hash });
			expect(r.ok).toBe(false);
			expect(r.pack).toBeNull();
			expect(failing(r)).toEqual(['archive']);
		});

		// A hostile or corrupt bundle whose every file matches its hash but isn't what its name says: a failing check, never an exception.
		describe('malformed, hashes fixed: never throws', () => {
			const check = async (edit: (f: Map<string, string>) => void) => checkPackBundle(await rezip((await buildPackBundle(input, hash)).bytes, edit), { hash });

			it('control: the same rezip with no edit checks clean', async () => {
				expect((await check(() => {})).ok).toBe(true);
			});

			it('bundle.json without its pack: archive fails, pack null', async () => {
				const r = await check((f) => {
					const index = JSON.parse(f.get('bundle.json')!) as Partial<PackBundleIndex>;
					delete index.pack;
					f.set('bundle.json', JSON.stringify(index));
				});
				expect(r.ok).toBe(false);
				expect(r.pack).toBeNull();
				expect(failing(r)).toEqual(['archive']);
				expect(r.checks[0]!.detail).toMatch(/doesn't name the pack/);
			});

			it('bundle.json without its baseline run: archive fails', async () => {
				const r = await check((f) => {
					const index = JSON.parse(f.get('bundle.json')!) as PackBundleIndex;
					f.set('bundle.json', JSON.stringify({ ...index, runs: { application: index.runs.application } }));
				});
				expect(failing(r)).toEqual(['archive']);
			});

			it('a manifest.json that is not JSON: structure fails', async () => {
				const r = await check((f) => f.set('manifest.json', 'not json'));
				expect(r.ok).toBe(false);
				expect(r.pack).toBeNull();
				expect(failing(r)).toEqual(['structure']);
				expect(r.checks.find((c) => c.id === 'structure')!.detail).toMatch(/^the bundle is malformed: /);
			});

			it('a canonical manifest of the pack with no report, its hash fixed in bundle.json: structure fails', async () => {
				const r = await check((f) => {
					const manifest = JSON.parse(f.get('manifest.json')!) as { pack: unknown };
					const text = canonicalJson({ pack: manifest.pack });
					f.set('manifest.json', text);
					const index = JSON.parse(f.get('bundle.json')!) as PackBundleIndex;
					index.pack.manifestSha256 = hash(text);
					f.set('bundle.json', JSON.stringify(index));
				});
				expect(failing(r)).toEqual(['structure']);
			});

			it('a results.json that is not JSON: structure fails', async () => {
				const r = await check((f) => f.set('runs/baseline/results.json', '{'));
				expect(failing(r)).toEqual(['structure']);
			});
		});
	});
});

describe('the headline board’s full-allocation pair (bundle-2, evidence-19, issue #523 G2)', () => {
	it('records both digests in bundle.json, re-derives the pair from the baseline input and scenario.json, re-runs it and checks the digests, the board and the mix', async () => {
		const input = await headlinePackFixture(hash);
		const built = await buildPackBundle(input, hash);
		const rec = input.manifest.report.licenceImpactAuthorised!.reproduction!;
		expect(built.index.version).toBe(PACK_BUNDLE_VERSION);
		expect(built.index.headline).toEqual({ baselineResultsSha256: rec.baselineResultsSha256, applicationResultsSha256: rec.applicationResultsSha256 });
		// The pair isn't the stored runs: different digests (every holder at their registered volume).
		expect(rec.baselineResultsSha256).not.toBe(built.index.runs.baseline!.resultsSha256);
		// As at the baseline: one entry per take (the s21b row takes nothing), sorted by id.
		expect(rec.kinds).toEqual(Object.entries(HEADLINE_KINDS).map(([allocationId, authorisation]) => ({ allocationId, authorisation })));
		const r = await checkPackBundle(built.bytes, { hash });
		expect(failing(r)).toEqual([]);
		expect(r.checks.map((c) => c.id).slice(-2)).toEqual(['headline', 'reproduce:headline']);
		expect(r.checks.find((c) => c.id === 'reproduce:headline')!.detail).toMatch(/both results digests and the headline board are the same/);
		expect(r.headline).toBe('checked');
		const readme = new TextDecoder().decode(await (await ZipArchive.open(built.bytes)).read('README.md'));
		expect(readme).toContain(rec.baselineResultsSha256);
		expect(readme).toContain('`reproduce:headline`');
	});

	it('with rerun: false checks the record and the mix, and re-runs nothing', async () => {
		const r = await checkPackBundle((await buildPackBundle(await headlinePackFixture(hash), hash)).bytes, { hash, rerun: false });
		expect(failing(r)).toEqual([]);
		expect(r.checks.map((c) => c.id).at(-1)).toBe('headline');
		expect(r.headline).toBe('checked');
	});

	it('a recorded digest the pair doesn’t give (the manifest consistent): reproduce:headline fails alone, naming the run', async () => {
		const input = await headlinePackFixture(hash);
		input.manifest.report.licenceImpactAuthorised!.reproduction!.applicationResultsSha256 = 'd'.repeat(64);
		const r = await checkPackBundle((await buildPackBundle(input, hash)).bytes, { hash });
		expect(failing(r)).toEqual(['reproduce:headline']);
		expect(r.ok).toBe(false);
		expect(r.checks.find((c) => c.id === 'reproduce:headline')!.detail).toContain(`the full-allocation application's results digest is`);
		expect(r.checks.find((c) => c.id === 'reproduce:headline')!.detail).toContain(`not ${'d'.repeat(64)}`);
	});

	it('a headline digest tampered in bundle.json (its hashes fixed): headline fails', async () => {
		const built = await buildPackBundle(await headlinePackFixture(hash), hash);
		const tampered = await rezip(built.bytes, (f) => {
			const index = JSON.parse(f.get('bundle.json')!) as PackBundleIndex;
			index.headline!.baselineResultsSha256 = 'e'.repeat(64);
			f.set('bundle.json', canonicalJson(index));
		});
		const r = await checkPackBundle(tampered, { hash, rerun: false });
		expect(failing(r)).toEqual(['headline']);
		expect(r.checks.find((c) => c.id === 'headline')!.detail).toContain("bundle.json's headline digests aren't the ones the manifest records");
	});

	it('a kind recorded other than the mix it gave: headline fails on the mix', async () => {
		const input = await headlinePackFixture(hash);
		input.manifest.report.licenceImpactAuthorised!.reproduction!.kinds[1]!.authorisation = 'licence';
		const r = await checkPackBundle((await buildPackBundle(input, hash)).bytes, { hash, rerun: false });
		expect(failing(r)).toEqual(['headline']);
		expect(r.checks.find((c) => c.id === 'headline')!.detail).toMatch(/the mix from the baseline's volumes and the recorded kinds isn't the manifest's/);
	});

	it('a board other than the pair gives: reproduce:headline fails on the board', async () => {
		const input = await headlinePackFixture(hash);
		(input.manifest.report.licenceImpactAuthorised!.board as { siteFellBack: boolean }).siteFellBack = true;
		const r = await checkPackBundle((await buildPackBundle(input, hash)).bytes, { hash });
		expect(failing(r)).toEqual(['reproduce:headline']);
		expect(r.checks.find((c) => c.id === 'reproduce:headline')!.detail).toMatch(/the board built again isn't the manifest's \(siteFellBack\)/);
	});

	it('a board built before its pair was recorded: the headline isn’t included, said, and the pack verifies as it did', async () => {
		const built = await buildPackBundle(await headlinePackFixture(hash, { legacy: true }), hash);
		expect(built.index.headline).toBeNull();
		const r = await checkPackBundle(built.bytes, { hash });
		expect(failing(r)).toEqual([]);
		expect(r.checks.find((c) => c.id === 'headline')!.detail).toContain(HEADLINE_NOT_INCLUDED);
		expect(r.checks.some((c) => c.id === 'reproduce:headline')).toBe(false);
		expect(r.headline).toBe('older');
	});

	it('an older bundle (bundle-1, a pack issued before): checked as it was, the headline not included (older pack)', async () => {
		const built = await buildPackBundle(await headlinePackFixture(hash, { legacy: true }), hash);
		const older = await rezip(built.bytes, (f) => {
			const index = JSON.parse(f.get('bundle.json')!) as PackBundleIndex & { headline?: unknown };
			delete index.headline;
			f.set('bundle.json', canonicalJson({ ...index, version: 'bundle-1' }));
		});
		const r = await checkPackBundle(older, { hash });
		expect(failing(r)).toEqual([]);
		expect(r.ok).toBe(true);
		expect(r.checks.find((c) => c.id === 'headline')!.detail).toMatch(/^headline not included \(older pack\): its bundle \(bundle-1\)/);
		expect(r.headline).toBe('older');
		// An unknown layout is still refused (control).
		const unknown = await rezip(built.bytes, (f) => f.set('bundle.json', canonicalJson({ ...(JSON.parse(f.get('bundle.json')!) as object), version: 'bundle-9' })));
		expect(failing(await checkPackBundle(unknown, { hash, rerun: false }))).toEqual(['archive']);
	});
});

describe('the combined row’s cumulative assessment (bundle-3, followups § Cumulative impact)', () => {
	const plain = assessmentPackFixture(hash);
	const withBackground = assessmentPackFixture(hash, { background: true });
	const ids = (r: Awaited<ReturnType<typeof checkPackBundle>>) => r.checks.map((c) => c.id);
	const detail = (r: Awaited<ReturnType<typeof checkPackBundle>>, id: string) => r.checks.find((c) => c.id === id)!.detail;
	/** Rewrite a JSON entry of a built bundle (its hashes fixed), so the check reached is the assessment's, not `files`. */
	const editJson = (bytes: Uint8Array<ArrayBuffer>, name: string, edit: (v: any) => void) =>
		rezip(bytes, (f) => {
			const v = JSON.parse(f.get(name)!);
			edit(v);
			f.set(name, canonicalJson(v));
		});

	it('carries the members, the stored report and nothing else without a background; re-runs every row and the dam rows', async () => {
		const built = await buildPackBundle(plain, hash);
		expect(built.index.assessment).toEqual({ id: ASSESSMENT_FIXTURE.id, engineVersion: ENGINE_VERSION, backgroundRunId: null });
		expect(Object.keys(built.index.files)).toEqual(expect.arrayContaining([BUNDLE_ASSESSMENT_FILE, BUNDLE_ASSESSMENT_REPORT]));
		expect(Object.keys(built.index.files)).not.toContain(BUNDLE_BACKGROUND_INPUT);
		// The fixture touches Farm one's dam: the report has its rows.
		expect(plain.assessment!.report.dams).toEqual({ nodeIds: ['F1'], onVolumes: false });
		const r = await checkPackBundle(built.bytes, { hash });
		expect(failing(r)).toEqual([]);
		expect(ids(r).slice(-3)).toEqual(['assessment', 'reproduce:combined', 'reproduce:dams']);
		expect(r.combined).toBe('checked');
		expect(detail(r, 'reproduce:combined')).toMatch(/each of the 2 applications alone and all of them together, re-run with engine .*, give every row of the stored report/);
		const readme = new TextDecoder().decode(await (await ZipArchive.open(built.bytes)).read('README.md'));
		expect(readme).toContain('`reproduce:combined`');
		expect(readme).not.toContain('`reproduce:background`');
	});

	it('with a background at full allocation: its input is checked and its row set re-run too', async () => {
		const built = await buildPackBundle(withBackground, hash);
		expect(built.index.assessment!.backgroundRunId).toBe(ASSESSMENT_FIXTURE.background);
		expect(Object.keys(built.index.files)).toContain(BUNDLE_BACKGROUND_INPUT);
		const r = await checkPackBundle(built.bytes, { hash });
		expect(failing(r)).toEqual([]);
		expect(ids(r).slice(-5)).toEqual(['assessment', 'inputs:background', 'reproduce:combined', 'reproduce:dams', 'reproduce:background']);
		// --no-run: the static checks alone.
		const quick = await checkPackBundle(built.bytes, { hash, rerun: false });
		expect(failing(quick)).toEqual([]);
		expect(ids(quick).slice(-2)).toEqual(['assessment', 'inputs:background']);
	});

	it('a member’s op tampered (its hash left): assessment fails on the hash; with the hash fixed too, the re-run fails', async () => {
		const built = await buildPackBundle(plain, hash);
		const op = (v: any) => (v.members[1].ops[0].areaM2 = 900_000);
		const r = await checkPackBundle(await editJson(built.bytes, BUNDLE_ASSESSMENT_FILE, op), { hash });
		expect(failing(r)).toEqual(['assessment', 'reproduce:combined', 'reproduce:dams']);
		expect(detail(r, 'assessment')).toContain(`"Farm two maize"'s ops hash to`);
		expect(detail(r, 'reproduce:combined')).toBe('not re-run: the assessment or the baseline inputs failed a check above');
		const rehashed = await editJson(built.bytes, BUNDLE_ASSESSMENT_FILE, (v) => {
			op(v);
			v.members[1].opsSha256 = hash(canonicalJson(v.members[1].ops));
		});
		const again = await checkPackBundle(rehashed, { hash });
		expect(failing(again)).toEqual(['reproduce:combined']);
		expect(detail(again, 'reproduce:combined')).toMatch(/^re-run with engine .*: .* differs \(stored all together [0-9.e-]+, here [0-9.e-]+\)/);
	});

	it('a stored row tampered: the manifest’s combined section no longer reads from it (assessment), or the re-run differs (reproduce:dams)', async () => {
		const built = await buildPackBundle(plain, hash);
		const outlet = await editJson(built.bytes, BUNDLE_ASSESSMENT_REPORT, (v) => {
			const row = v.rows.find((x: any) => x.metric === 'ewr_days_not_met' && x.isOutlet);
			row.combined += 1;
		});
		expect(failing(await checkPackBundle(outlet, { hash, rerun: false }))).toEqual(['assessment']);
		// A row the manifest doesn't carry (the dam's assurance alone): only the re-run sees it.
		const dam = await editJson(built.bytes, BUNDLE_ASSESSMENT_REPORT, (v) => {
			const row = v.rows.find((x: any) => x.metric === 'dam_reliability');
			row.singles[1] = 0.123;
		});
		const r = await checkPackBundle(dam, { hash });
		expect(failing(r)).toEqual(['reproduce:dams']);
		expect(detail(r, 'reproduce:dams')).toContain('dam_reliability at Farm one differs');
	});

	it('a background input tampered: inputs:background fails, and the background isn’t re-run', async () => {
		const built = await buildPackBundle(withBackground, hash);
		// One more op that changes the catchment, not only the volumes (the hash fixed): not the baseline at full allocation.
		const bad = await editJson(built.bytes, BUNDLE_BACKGROUND_INPUT, (v) => {
			v.scenario.ops.push({ op: 'cropArea.set', nodeId: 'F2', cropId: 'c', areaM2: 900_000 });
			v.scenario.opsSha256 = hash(canonicalJson(v.scenario.ops));
			v.model.cropAreas.find((a: any) => a.nodeId === 'F2').areaM2 = 900_000;
		});
		const r = await checkPackBundle(bad, { hash });
		expect(failing(r)).toEqual(['inputs:background', 'reproduce:background']);
		expect(detail(r, 'inputs:background')).toContain("an op isn't the baseline at full allocation");
		expect(detail(r, 'reproduce:background')).toMatch(/^not re-run/);
		// The volumes changed instead, as an allocation op would, but not recorded as one: its model isn't the baseline's with its ops.
		const quiet = await editJson(built.bytes, BUNDLE_BACKGROUND_INPUT, (v) => (v.model.allocations[0].volumeM3PerYear = 99_000));
		const q = await checkPackBundle(quiet, { hash, rerun: false });
		expect(failing(q)).toEqual(['inputs:background']);
		expect(detail(q, 'inputs:background')).toContain("its model isn't the baseline's with its ops applied");
	});

	it('refuses to build without the assessment the manifest cites, and an assessment it doesn’t cite fails the check', async () => {
		await expect(buildPackBundle({ ...plain, assessment: null }, hash)).rejects.toThrow(/cites assessment/);
		const built = await buildPackBundle(plain, hash);
		const r = await checkPackBundle(
			await rezip(built.bytes, (f) => {
				for (const n of [BUNDLE_ASSESSMENT_FILE, BUNDLE_ASSESSMENT_REPORT]) f.delete(n);
			}),
			{ hash, rerun: false }
		);
		expect(failing(r)).toEqual(['assessment']);
		expect(detail(r, 'assessment')).toMatch(/cites assessment .*, which the bundle doesn't carry/);
	});

	it('an older bundle (bundle-2) of a pack whose combined row cites an assessment: checked as it was, the row not included', async () => {
		const built = await buildPackBundle(plain, hash);
		const older = await rezip(built.bytes, (f) => {
			for (const n of [BUNDLE_ASSESSMENT_FILE, BUNDLE_ASSESSMENT_REPORT]) f.delete(n);
			const index = JSON.parse(f.get('bundle.json')!) as PackBundleIndex;
			delete index.assessment;
			f.set('bundle.json', canonicalJson({ ...index, version: 'bundle-2' }));
		});
		const r = await checkPackBundle(older, { hash });
		expect(failing(r)).toEqual([]);
		expect(detail(r, 'assessment')).toMatch(new RegExp(`^${COMBINED_NOT_INCLUDED.replace(/[()]/g, '\\$&')}: its bundle \\(bundle-2\\)`));
		expect(r.combined).toBe('older');
		expect(ids(r)).not.toContain('reproduce:combined');
		// A pack that cites none adds no check (control).
		expect((await checkPackBundle((await buildPackBundle(packInput(), hash)).bytes, { hash, rerun: false })).combined).toBe('none');
	});
});

describe('seriesCsv / parseSeriesCsv', () => {
	it('round-trips values exactly, a missing day empty', () => {
		const values = [0, 0.1 + 0.2, null, 1e-7, -3.5, 123456789.123];
		const csv = seriesCsv('2000-02-28', values);
		expect(csv.split('\n').slice(0, 4)).toEqual(['date,value', '2000-02-28,0', '2000-02-29,0.30000000000000004', '2000-03-01,']);
		expect(parseSeriesCsv(csv)).toEqual({ startDate: '2000-02-28', values });
		expect(parseSeriesCsv('date,value\n')).toEqual({ startDate: null, values: [] });
	});

	it('refuses a gap in the dates, a bad number and another header', () => {
		expect(() => parseSeriesCsv('date,value\n2000-01-01,1\n2000-01-03,2\n')).toThrow(/doesn't follow/);
		expect(() => parseSeriesCsv('date,value\n2000-01-01,abc\n')).toThrow(/not a number/);
		expect(() => parseSeriesCsv('date,value\n2000-01-01, 1\n')).toThrow(/not a number/);
		expect(() => parseSeriesCsv('day,value\n')).toThrow(/header/);
	});
});

describe('runResultsText / runResultsDigest', () => {
	const r = {
		startDate: '2000-01-01',
		summary: { mar: 1.5, nan: Number.NaN },
		series: [
			{ nodeId: 'b', key: 'k', label: 'B', values: [1, 2] },
			{ nodeId: null, key: 'flow', label: 'Flow', values: [Number.POSITIVE_INFINITY, 3] }
		]
	};

	it('ignores labels and order, and stores NaN and infinity as null', async () => {
		const a = await runResultsDigest(r, hash);
		const b = await runResultsDigest({ ...r, summary: { nan: null, mar: 1.5 }, series: [{ ...r.series[1]!, label: 'x', values: [null, 3] }, r.series[0]!] }, hash);
		expect(b.sha256).toBe(a.sha256);
		expect(a.series.map((s) => s.nodeId)).toEqual([null, 'b']);
		expect(hash(runResultsText({ ...r, series: a.series }))).toBe(a.sha256);
	});

	it('changes with a value, the first day or the summary', async () => {
		const a = (await runResultsDigest(r, hash)).sha256;
		expect((await runResultsDigest({ ...r, series: [{ ...r.series[0]!, values: [1, 2.0000001] }, r.series[1]!] }, hash)).sha256).not.toBe(a);
		expect((await runResultsDigest({ ...r, startDate: '2000-01-02' }, hash)).sha256).not.toBe(a);
		expect((await runResultsDigest({ ...r, summary: { mar: 1.6 } }, hash)).sha256).not.toBe(a);
	});
});
