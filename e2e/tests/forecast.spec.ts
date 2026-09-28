// Forecast runs (WP-2.12, docs/ui.md § Forecast runs): an editor runs a
// forecast on a project with a forecast series past its record; the run is
// tagged, its forecast days get their own panel, every daily chart shades them
// with a text key (not colour alone, axe-clean), and the daily CSV marks them
// F; its report says on the cover that those days use forecast rain,
// crediting CHIRPS-GEFS only when a CHIRPS-GEFS feed wrote them.
// Published, the forecast run gives the linked farmer a "Next 14 days"
// card; an ordinary run of the same data stops at the record.
import { putSeries, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { plantGefsForecastDays } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

// seedRunnableProject records rain 2021-10-01 … 2022-01-28 (120 days).
const FROM = '2022-01-29';
const TO = '2022-02-11';

test('a forecast run keeps its forecast days apart: tagged, its own panel, a labelled band, F in the CSV, and a farmer’s Next 14 days', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Forecast');
	await putSeries(page.request, project.id, {
		kind: 'rain_forecast_mm',
		unit: 'mm',
		startDate: FROM,
		values: Array.from({ length: 14 }, (_, i) => (i % 4 === 0 ? 9 : 0))
	});
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByText('No runs yet. Run the model to see results.')).toBeVisible();

	await page.getByLabel(/^Run label/).fill('Next fortnight');
	await page.getByRole('button', { name: 'Run forecast' }).click();

	const list = page.getByRole('region', { name: 'Runs', exact: true });
	const picked = list.getByRole('button', { name: /^Next fortnight/ });
	await expect(picked).toHaveAttribute('aria-current', 'true');
	await expect(picked).toContainText('Forecast');
	await expect(page.locator('#res-h').locator('..')).toContainText('2021-10-01 → 2022-02-11');
	await expect(page.getByRole('link', { name: `Forecast from ${FROM}` })).toBeVisible();

	// The forecast panel: the days, per farm, the outlet, all worded as expectations.
	const panel = page.getByTestId('forecast-panel');
	await expect(panel.getByRole('heading', { name: 'Forecast' })).toBeVisible();
	await expect(panel).toContainText(`Next 14 days: ${FROM} to ${TO}, modelled on`);
	await expect(panel.getByText('Modelled on forecast rain, not measured')).toBeVisible();
	await expect(panel.getByRole('rowheader', { name: 'Upper farm' })).toBeVisible();
	await expect(panel.getByRole('rowheader', { name: 'Lower farm' })).toBeVisible();
	await expect(panel.getByTestId('forecast-outlet')).toContainText('The model expects');

	// Every daily chart shades the forecast days, and says so in text.
	const hydro = page.locator('#res-hydrograph figure');
	await expect(hydro).toHaveAttribute('data-ready', 'true');
	await expect(hydro).toHaveAttribute('data-band-from', FROM);
	await expect(hydro.getByText(`(hatched, from ${FROM})`)).toBeVisible();
	await expect(hydro.locator('.band-key strong')).toHaveText('Forecast');
	await expectNoViolations(page, { include: '#res-forecast' });
	await expectNoViolations(page, { include: '#res-hydrograph' });
	const runId = new URL(page.url()).searchParams.get('run')!;
	// EWR vs outflow, on River & reserve now, shades the forecast days too.
	await page.goto(`/projects/${project.id}?tab=river&run=${runId}`);
	await expect(page.locator('#res-ewr figure')).toHaveAttribute('data-band-from', FROM);
	await page.goBack();

	// The daily CSV leads with the forecast flag.
	const csv = await page.request.get(`${API_URL}/projects/${project.id}/runs/${runId}/export/daily.csv`);
	expect(csv.status()).toBe(200);
	const [provenance, ...lines] = (await csv.text()).replace(/^﻿/, '').trim().split('\r\n');
	// Row 1 says which run made the file (docs/api.md § Export), the header follows it.
	expect(provenance).toMatch(/^# run=Next fortnight; engine=[^;]+; runoff_model=gr4j; created=[^;]+; period=2021-10-01\.\.2022-02-11$/);
	expect(lines[0]!.split(',').slice(0, 2)).toEqual(['date', 'forecast (F = modelled on forecast rain)']);
	const flag = new Map(lines.slice(1).map((l) => [l.slice(0, 10), l.split(',')[1]]));
	expect(flag.get('2022-01-28')).toBe('');
	expect(flag.get(FROM)).toBe('F');
	expect(flag.get(TO)).toBe('F');

	// Its report says, on the cover, that the days from the first forecast day use forecast rain;
	// an uploaded forecast names no product (a CHIRPS-GEFS feed's: the next test).
	await page.goto(`/projects/${project.id}/report?run=${runId}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(page.getByTestId('report-forecast-note')).toHaveText(
		`From ${FROM}, this run uses forecast rain, not recorded rain. Rain forecasts are often wrong, more so further ahead, and each new forecast replaces the last.`
	);
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);

	// An ordinary run of the same data stops at the record, with no band.
	await page.getByLabel(/^Run label/).fill('Record only');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(list.getByRole('button', { name: /^Record only/ })).toHaveAttribute('aria-current', 'true');
	await expect(page.locator('#res-h').locator('..')).toContainText('2021-10-01 → 2022-01-28');
	await expect(page.locator('#res-hydrograph figure')).toHaveAttribute('data-ready', 'true');
	await expect(page.locator('#res-hydrograph figure')).not.toHaveAttribute('data-band-from');
	await expect(page.getByTestId('forecast-panel')).toHaveCount(0);
	// …and its report has no forecast-rain line.
	await page.goto(`/projects/${project.id}/report?run=${new URL(page.url()).searchParams.get('run')}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(page.getByTestId('report-forecast-note')).toHaveCount(0);

	// Published, the forecast run gives the linked farmer their Next 14 days.
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	const farmer = await signIn('Forecast farmer');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [upper] } })).status()).toBe(201);
	await farmer.page.goto(`/farm/${project.id}`);
	const card = farmer.page.getByTestId('farm-forecast');
	await expect(card.getByRole('heading', { name: /^Next 14\sdays$/ })).toBeVisible();
	await expect(card).toContainText('Forecast');
	await expect(card).toContainText('Forecasts change');
	await expectNoViolations(farmer.page, { include: '[data-testid="farm-forecast"]' });
});

test('a forecast run whose forecast days a CHIRPS-GEFS feed wrote credits CHIRPS-GEFS on its report', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'GEFS forecast');
	await putSeries(page.request, project.id, { kind: 'rain_forecast_mm', unit: 'mm', startDate: FROM, values: Array.from({ length: 14 }, (_, i) => (i % 4 === 0 ? 9 : 0)) });
	await plantGefsForecastDays(project.id);
	const res = await page.request.post(`${API_URL}/projects/${project.id}/runs`, { data: { label: 'GEFS fortnight', forecast: true } });
	expect(res.status()).toBe(201);
	const runId = ((await res.json()) as { run: { id: string } }).run.id;

	await page.goto(`/projects/${project.id}/report?run=${runId}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(page.getByTestId('report-forecast-note')).toHaveText(
		`From ${FROM}, this run uses forecast rain (CHIRPS-GEFS, Climate Hazards Center, doi:10.15780/G2PH2M), not recorded rain. Rain forecasts are often wrong, more so further ahead, and each new forecast replaces the last.`
	);
});
