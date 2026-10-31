// A run whose GR4J read an AgERA5 feed's daily reference ET records the
// products it read (inputs.et0Products, runs/execute.ts; issue #604 R5-E), and
// the run's reads and exports credit them: GET …/runs/:runId, the summary CSV's
// block, the catchment's daily CSV and the reference ET series file. Under an
// A-pan PE GR4J doesn't read the series, so the run owes none (the control).
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, disableFeedsAfterFile, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

const START = '2021-10-01';
const DAYS = 400; // to 2022-11-04
const AGERA5_THROUGH = '2022-10-20';
const outlet = node('Weir', null);

let owner: User;
let pid: string;
let et0SeriesId: string;

disableFeedsAfterFile();

const text = async (path: string) => {
	const r = await app.request(path, { headers: { cookie: owner.cookie, origin: 'http://localhost:7777' } });
	return { status: r.status, body: await r.text() };
};
const run = async () => {
	const r = await owner.call('POST', `/projects/${pid}/runs`, { label: 'et0' });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	return r.body.run.id as string;
};
const settings = (pe: object) => owner.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(150), runoffModel: 'gr4j', pe, calibration: { catchmentAreaKm2: 50 } } });

beforeAll(async () => {
	owner = await signUp('Et0Credit');
	pid = (await owner.call('POST', '/projects', { name: 'Reference ET credits' })).body.project.id as string;
	expect((await owner.call('PUT', `/projects/${pid}/model`, { nodes: [outlet], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await settings({ kind: 'monthly', mm: monthly(120), source: 'test' })).status).toBe(200);
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 6 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rain })).status).toBe(200);
	expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'evap_et0_mm', unit: 'mm', startDate: START, values: Array(DAYS).fill(4) })).status).toBe(200);
	const feed = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'agera5_et0', config: { cells: [{ lat: -33.525, lon: 19.525, weight: 1 }] } });
	expect(feed.status, JSON.stringify(feed.body)).toBe(201);
	et0SeriesId = (await asOwner(`SELECT id FROM time_series WHERE project_id = $1 AND kind = 'evap_et0_mm'`, [pid]))[0].id as string;
	// As if the feed had written every day (031_feed_days), AgERA5's to AGERA5_THROUGH and NASA POWER's after.
	await asOwner(`UPDATE time_series SET feed_id = $2, feed_days = datemultirange(daterange($3::date, $3::date + $4::int)) WHERE id = $1`, [et0SeriesId, feed.body.feed.id, START, DAYS]);
	await asOwner(`UPDATE data_feed SET enabled = false, last_meta = $2::jsonb WHERE id = $1`, [feed.body.feed.id, JSON.stringify({ days: DAYS, agera5Days: 385, powerDays: 15, agera5Through: AGERA5_THROUGH })]);
}, 60_000);

describe('a run’s reference ET credits (issue #604 R5-E)', () => {
	it('GR4J read the feed’s days under a monthly PE row: both products credited in the run and its exports', async () => {
		const id = await run();
		expect((await owner.call('GET', `/projects/${pid}/runs/${id}`)).body.run.et0Products).toEqual(['agera5_et0', 'power_et0']);
		const summary = await text(`/projects/${pid}/runs/${id}/export/summary.csv`);
		expect(summary.status).toBe(200);
		expect(summary.body).toContain('Daily reference evapotranspiration');
		expect(summary.body).toContain('Credit: AgERA5 reference evapotranspiration');
		expect(summary.body).toContain('Credit: NASA POWER reference evapotranspiration');
		const daily = await text(`/projects/${pid}/runs/${id}/export/daily.csv`);
		expect(daily.body).toContain('# credit AgERA5 reference evapotranspiration: Contains modified Copernicus Climate Change Service information');
		expect(daily.body).toContain('# credit NASA POWER reference evapotranspiration: NASA Prediction of Worldwide Energy Resources (POWER) Project');
		// The series file of the reference ET credits it; catchment rain's (CHIRPS-free, no products) credits nothing.
		const et0File = await text(`/projects/${pid}/series/${et0SeriesId}/export.csv`);
		expect(et0File.status).toBe(200);
		expect(et0File.body).toContain('# credit NASA POWER reference evapotranspiration:');
		const rainId = (await asOwner(`SELECT id FROM time_series WHERE project_id = $1 AND kind = 'rain_catchment_mm'`, [pid]))[0].id as string;
		expect((await text(`/projects/${pid}/series/${rainId}/export.csv`)).body).not.toContain('# credit');
	});

	it('a person wrote over NASA POWER’s days: AgERA5 alone', async () => {
		await asOwner(`UPDATE time_series SET feed_days = feed_days - datemultirange(daterange($2::date + 1, $3::date + $4::int)) WHERE id = $1`, [et0SeriesId, AGERA5_THROUGH, START, DAYS]);
		const id = await run();
		expect((await owner.call('GET', `/projects/${pid}/runs/${id}`)).body.run.et0Products).toEqual(['agera5_et0']);
	});

	it('under an A-pan PE GR4J doesn’t read the series: none owed, nothing printed', async () => {
		expect((await settings({ kind: 'pan' })).status).toBe(200);
		const id = await run();
		expect((await owner.call('GET', `/projects/${pid}/runs/${id}`)).body.run.et0Products).toEqual([]);
		expect((await text(`/projects/${pid}/runs/${id}/export/summary.csv`)).body).not.toContain('reference evapotranspiration,');
		expect((await text(`/projects/${pid}/runs/${id}/export/daily.csv`)).body).not.toContain('# credit');
	});
});
