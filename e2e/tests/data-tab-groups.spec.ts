// The Data tab's grouped list (issue #553 round 5, docs/ui.md § Data): two rainfall stations with their MAPs and
// where their rain goes, the average catchment rainfall and each hydrological unit as a derived row saying what its
// rain is made of, a unit opened to its series and its rain used with the four lines behind it and the source strip,
// and the grouped CSV in both sizes. Synthetic catchment: invented names and values only (public repo).
import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, node, putModel, updateSettings } from '../support/api.ts';
import { areaRow, openData, seriesGroup, seriesRow, seriesTable } from '../support/data.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const START = '2015-01-01';
const DAYS = 2192; // 2015 … 2020: six whole calendar years, five of them complete for the station and CHIRPS
const rain = (k: number, phase = 0) => Array.from({ length: DAYS }, (_, i) => Math.round(((i + phase) % 11 === 0 ? 24 * k : (i + phase) % 4 === 0 ? 2 * k : 0) * 10) / 10);

/** Stores a series (a unit's own: placed at the unit afterwards, PATCH …/series/:id { siteNodeId }); returns its id. */
async function put(request: APIRequestContext, projectId: string, s: Record<string, unknown>, siteNodeId?: string): Promise<string> {
	const res = await request.put(`${API_URL}/projects/${projectId}/series`, { data: { unit: 'mm', startDate: START, ...s } });
	expect(res.status()).toBe(200);
	const { series } = (await (await request.get(`${API_URL}/projects/${projectId}/series`)).json()) as { series: { id: string; name: string }[] };
	const id = series.find((x) => x.name === s.name)!.id;
	if (siteNodeId) expect((await request.patch(`${API_URL}/projects/${projectId}/series/${id}`, { data: { siteNodeId } })).status()).toBe(200);
	return id;
}

/** A gauge with two land units (MAPs 863.1 and 600 mm), two stations, each unit's CHIRPS, the catchment CHIRPS and a flow record; stations assigned in Settings. */
async function seed(request: APIRequestContext) {
	const project = await createProject(request, 'Grouped data');
	const gauge = node('Outflow gauge', 'gauge', null, 1, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const a = node('Upper unit', 'farm', gauge.id, 2, { mapMm: 863.1, mapSource: 'invented' });
	const b = node('Lower unit', 'farm', gauge.id, 3, { mapMm: 600, mapSource: 'invented' });
	await putModel(request, project.id, { nodes: [gauge, a, b], crops: [], cropAreas: [], transfers: [] });
	// Bergwater misses ten days in 2015, which its unit fills from CHIRPS corrected against it.
	const berg = rain(1.6, 1).map((v, i) => (i >= 40 && i < 50 ? null : v));
	const bergId = await put(request, project.id, { kind: 'rain_catchment_mm', name: 'Bergwater', values: berg, station: { mapMm: 745, mapSource: 'Station record, 1991–2020', lat: null, lon: null } });
	const kloofId = await put(request, project.id, { kind: 'rain_catchment_mm', name: 'Kloof', values: rain(1.2, 3), station: { mapMm: 600, mapSource: 'Invented study', lat: null, lon: null } });
	await put(request, project.id, { kind: 'rain_chirps_mm', name: 'CHIRPS catchment', values: rain(0.7, 2) });
	await put(request, project.id, { kind: 'rain_chirps_mm', name: 'CHIRPS Upper unit', values: rain(0.8, 1) }, a.id);
	await put(request, project.id, { kind: 'rain_chirps_mm', name: 'CHIRPS Lower unit', values: rain(0.5, 3) }, b.id);
	await put(request, project.id, { kind: 'flow_observed_m3s', name: 'Outlet weir', unit: 'm³/s', values: Array.from({ length: DAYS }, (_, i) => 0.1 + (i % 11) / 50) });
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		unitRain: { mode: 'perUnit' },
		rainStations: {
			catchment: { stationId: bergId },
			units: { [a.id]: { stationId: bergId }, [b.id]: { stationId: kloofId, correctAgainst: bergId } },
			sites: { [bergId]: { unitId: a.id } }
		}
	});
	return { project, a, b };
}

async function downloaded(page: Page, item: string): Promise<{ name: string; lines: string[] }> {
	await page.getByTestId('data-export').getByRole('button', { name: 'Download (CSV)' }).click();
	const wait = page.waitForEvent('download');
	await page.getByTestId('data-export').getByRole('button', { name: new RegExp(`^${item}`) }).click();
	const d = await wait;
	const text = await readFile((await d.path())!, 'utf8');
	return { name: d.suggestedFilename(), lines: text.replace(/^﻿/, '').trimEnd().split('\r\n') };
}

test('the list is grouped: stations with their MAPs and areas, the catchment’s and each unit’s rain as derived rows', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const { project } = await seed(page.request);
	await openData(page, project.id);

	const table = seriesTable(page);
	await expect(table.getByRole('heading', { level: 3 })).toHaveText(['Rainfall stations', 'Catchment rainfall', 'Hydrological units', 'Flow records']);
	await expect(seriesGroup(page, 'Rainfall stations').locator('tr[data-series]')).toHaveText([/Bergwater/, /Kloof/]);
	await expect(seriesRow(page, 'Bergwater').getByTestId('series-station')).toHaveText('MAP 745.0 mm (Station record, 1991–2020)');
	await expect(seriesRow(page, 'Bergwater').getByTestId('series-station-uses')).toHaveText('Rain for the catchment and Upper unit. Corrects the CHIRPS gaps of Lower unit.');
	await expect(seriesRow(page, 'Kloof').getByTestId('series-station-uses')).toHaveText('Rain for Lower unit.');
	// The badges agree: Bergwater is the catchment rain read by name; Kloof isn't, but a run reads it for Lower unit.
	await expect(seriesRow(page, 'Kloof').getByTestId('series-role')).toHaveText('Rainfall station');

	// The catchment's average rainfall: Bergwater × the units' area-weighted mean MAP ÷ its MAP.
	const avg = areaRow(page, 'Average catchment rainfall');
	await expect(avg.getByRole('rowheader')).toContainText('Catchment average (derived)');
	await expect(avg.getByTestId('area-map')).toHaveText('MAP 731.6 mm (the units’ area-weighted mean)');
	await expect(avg.getByTestId('area-sentence')).toHaveText(
		'Bergwater × 0.98 (catchment MAP, the units’ area-weighted mean 731.6 mm ÷ station MAP 745.0 mm); gaps from CHIRPS corrected against Bergwater.'
	);
	await expect(seriesGroup(page, 'Catchment rainfall').locator('tr[data-series]')).toHaveText([/CHIRPS catchment/]);

	// One row a unit: its MAP, what its rain is, and its series behind the disclosure (not listed until opened).
	const upper = areaRow(page, 'Upper unit');
	await expect(upper.getByTestId('area-map')).toHaveText('MAP 863.1 mm');
	await expect(upper.getByTestId('area-sentence')).toHaveText('Bergwater × 1.16 (unit MAP 863.1 mm ÷ station MAP 745.0 mm); gaps from CHIRPS corrected against Bergwater.');
	await expect(upper.getByTestId('area-series')).toHaveText('1 series measured here: CHIRPS Upper unit');
	await expect(areaRow(page, 'Lower unit').getByTestId('area-sentence')).toHaveText('Kloof × 1.00 (unit MAP 600.0 mm ÷ station MAP 600.0 mm); gaps from CHIRPS corrected against Bergwater.');
	await expect(seriesRow(page, 'CHIRPS Upper unit')).toHaveCount(0);
	await expectNoViolations(page);

	// Opened: the unit's own series under it, and its rain used with the lines behind it and where each day came from.
	const show = upper.getByRole('button', { name: 'Show rain used: Upper unit' });
	await expect(show).toHaveAttribute('aria-expanded', 'false');
	await show.click();
	const hide = upper.getByRole('button', { name: 'Hide rain used: Upper unit' });
	await expect(hide).toHaveAttribute('aria-expanded', 'true');
	// It controls the unit's series rows and the panel.
	await expect(hide).toHaveAttribute('aria-controls', /^ser-row-[^ ]+ area-unit-[^ ]+$/);
	await expect(seriesRow(page, 'CHIRPS Upper unit')).toBeVisible();
	await expect(seriesRow(page, 'CHIRPS Upper unit').getByTestId('series-role')).toHaveText('Upper unit’s own rain');
	const panel = page.getByTestId('area-rain');
	await expect(panel.getByTestId('area-rain-days')).toHaveText(/^2.182 days from the station, 10 from corrected CHIRPS\. CHIRPS factors for Upper unit, fitted against Bergwater adjusted to its MAP, January to December: Jan 2\.32, /);
	// 2.32: Bergwater is twice the unit's CHIRPS, taken to the unit's MAP (863.1 ÷ 745; one pairing per area since engine 1.105.0, issue #612).
	const chart = panel.locator('figure.chart');
	await expect(chart).toHaveAttribute('data-ready', 'true');
	await expect(chart).toContainText('Upper unit: rain used and the lines behind it');
	for (const line of ['Rain used', 'Bergwater as recorded', 'Bergwater × 1.16', 'CHIRPS as stored', 'CHIRPS corrected against Bergwater']) await expect(chart).toContainText(line);
	await expect(chart).toContainText('Where the rain used came from');
	await expect(chart).toContainText('10 days from corrected CHIRPS (the station has no reading, or it was set aside)');
	await expectNoViolations(page);

	// Hide closes it again: its series and its chart go.
	await hide.click();
	await expect(page.getByTestId('area-rain')).toHaveCount(0);
	await expect(seriesRow(page, 'CHIRPS Upper unit')).toHaveCount(0);

	// A phone: the groups and the unit rows as cards, no sideways scroll.
	await page.setViewportSize({ width: 390, height: 844 });
	await upper.getByRole('button', { name: 'Show rain used: Upper unit' }).click();
	await expect(page.getByTestId('area-rain').locator('figure.chart')).toHaveAttribute('data-ready', 'true');
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await expectNoViolations(page);
});

test('a link to a unit’s series opens its unit; the grouped CSV downloads compact and full, each saying what each area’s rain is made of', async ({ page, owner }) => {
	void owner;
	const { project } = await seed(page.request);
	const { series } = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()) as { series: { id: string; name: string }[] };
	await openData(page, project.id, `&series=${series.find((s) => s.name === 'CHIRPS Lower unit')!.id}`);
	await expect(seriesRow(page, 'CHIRPS Lower unit')).toHaveClass(/selected/);
	await expect(areaRow(page, 'Lower unit').getByRole('button', { name: 'Hide rain used: Lower unit' })).toHaveAttribute('aria-expanded', 'true');

	const compact = await downloaded(page, 'Compact');
	expect(compact.name).toMatch(/^data-series-compact-\d{4}-\d{2}-\d{2}\.csv$/);
	expect(compact.lines[0]).toMatch(/^# Data tab export \(compact\); engine \d+\.\d+\.\d+; exported /);
	expect(compact.lines).toContain('# Upper unit: Bergwater × 1.16 (unit MAP 863.1 mm ÷ station MAP 745.0 mm); gaps from CHIRPS corrected against Bergwater.');
	const header = compact.lines.find((l) => l.startsWith('date,'))!;
	expect(header).toBe('date,Bergwater (mm),Kloof (mm),Average catchment rainfall: rain used (mm),Upper unit: rain used (mm),Lower unit: rain used (mm),Outlet weir (m³/s)');
	expect(compact.lines.filter((l) => /^\d{4}-/.test(l))).toHaveLength(DAYS);

	const full = await downloaded(page, 'Full');
	expect(full.name).toMatch(/^data-series-full-/);
	expect(full.lines.some((l) => /^# Upper unit: CHIRPS factors Jan to Dec /.test(l))).toBe(true);
	const fullHeader = full.lines.find((l) => l.startsWith('date,'))!.split(',');
	expect(fullHeader).toEqual([
		'date',
		'Bergwater (mm)',
		'Kloof (mm)',
		'Average catchment rainfall: station × ratio (mm)',
		'Average catchment rainfall: CHIRPS corrected (mm)',
		'Average catchment rainfall: rain used (mm)',
		'Average catchment rainfall: rain used from',
		'CHIRPS catchment (mm)',
		'CHIRPS Upper unit (mm)',
		'Upper unit: station × ratio (mm)',
		'Upper unit: CHIRPS corrected (mm)',
		'Upper unit: rain used (mm)',
		'Upper unit: rain used from',
		'CHIRPS Lower unit (mm)',
		'Lower unit: station × ratio (mm)',
		'Lower unit: CHIRPS corrected (mm)',
		'Lower unit: rain used (mm)',
		'Lower unit: rain used from',
		'Outlet weir (m³/s)'
	]);
	// A gap day of Bergwater: Upper unit's rain is its corrected CHIRPS, and says so.
	const day = full.lines.find((l) => l.startsWith('2015-02-15,'))!.split(',');
	const at = (h: string) => day[fullHeader.indexOf(h)];
	expect(at('Bergwater (mm)')).toBe('');
	expect(at('Upper unit: rain used from')).toBe('chirps');
	expect(at('Upper unit: rain used (mm)')).toBe(at('Upper unit: CHIRPS corrected (mm)'));
});

test('with the model input unavailable a unit says why and offers Try again, and the CSV still downloads, saying what it couldn’t compute', async ({ page, owner }) => {
	void owner;
	const { project } = await seed(page.request);
	let fail = true;
	await page.route(`${API_URL}/projects/${project.id}/model-input`, (route) => (fail ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }) : route.fallback()));
	await openData(page, project.id);
	await areaRow(page, 'Upper unit').getByRole('button', { name: 'Show rain used: Upper unit' }).click();
	const err = page.getByTestId('area-rain').getByRole('alert');
	await expect(err).toContainText('Couldn’t compute the rain of Upper unit');
	const compact = await downloaded(page, 'Compact');
	expect(compact.lines).toContain('# Upper unit: not computed (unavailable)');
	expect(compact.lines.find((l) => l.startsWith('date,'))).toBe('date,Bergwater (mm),Kloof (mm),Outlet weir (m³/s)');
	// Back again: Try again computes it.
	fail = false;
	await err.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByTestId('area-rain').locator('figure.chart')).toHaveAttribute('data-ready', 'true');
});

test('Preview all data shows each area’s derived rain beside the stored series, in its own column group, marked not stored', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const { project, a } = await seed(page.request);
	await openData(page, project.id);
	await page.getByRole('button', { name: 'Preview all data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });

	// The column chooser has the Full CSV's derived columns for the catchment and each unit, as their own group.
	await dialog.getByText('Columns', { exact: true }).click();
	const areaGroup = dialog.getByRole('group', { name: 'Each area’s rain (derived, not stored)' });
	const lines = ['station × ratio', 'CHIRPS corrected', 'rain used', 'rain used from'];
	await expect(areaGroup.getByRole('checkbox')).toHaveCount(12);
	for (const area of ['Average catchment rainfall', 'Upper unit', 'Lower unit'])
		for (const line of lines) await expect(areaGroup.getByRole('checkbox', { name: `${area}: ${line}`, exact: true })).toBeChecked();
	await dialog.getByText('Columns', { exact: true }).click();

	// Each header says it is derived, not stored.
	const headers = dialog.locator('thead th');
	await expect(headers.filter({ hasText: 'Upper unit: rain used from' }).getByTestId('derived-tag')).toHaveText('Derived · not stored');
	await expect(dialog.getByTestId('derived-tag')).toHaveCount(12);
	await expect(dialog.getByTestId('preview-areas')).toHaveCount(0);

	// Upper unit's columns by their ids (preview.ts areaColumnId), the Date column first.
	const ids = await headers.evaluateAll((ths) => ths.map((th) => th.getAttribute('data-series-col')));
	const col = (line: string) => ids.indexOf(`area:${a.id}:${line}`);
	const search = dialog.getByLabel('Search by date or value');
	const row = (day: string) => dialog.getByRole('table').getByRole('row').filter({ has: page.getByRole('cell', { name: day, exact: true }) });
	const cell = (day: string, label: string) => row(day).getByRole('cell').nth(col(label));

	// A Bergwater gap day: Upper unit's rain used is its corrected CHIRPS, and says so.
	await search.fill('2015-02-13');
	await expect(dialog).toContainText(/1 of [\d\s]+ days shown/);
	await expect(cell('13 Feb 2015', 'source')).toHaveText('corrected CHIRPS');
	const corrected = (await cell('13 Feb 2015', 'chirpsCorrected').innerText()).trim();
	expect(corrected).toMatch(/^\d/);
	await expect(cell('13 Feb 2015', 'rainUsed')).toHaveText(corrected);

	// A day the station read: the rain used is Bergwater × 1.16.
	await search.fill('2015-01-11');
	await expect(cell('11 Jan 2015', 'source')).toHaveText('station');
	const scaled = (await cell('11 Jan 2015', 'stationScaled').innerText()).trim();
	expect(scaled).toMatch(/^44\.\d+$/); // 38.4 × 863.1 / 745
	await expect(cell('11 Jan 2015', 'rainUsed')).toHaveText(scaled);
	await expectNoViolations(page);
});

test('Preview all data says when each area’s rain couldn’t be computed, and Try again computes it', async ({ page, owner }) => {
	void owner;
	const { project } = await seed(page.request);
	let fail = true;
	await page.route(`${API_URL}/projects/${project.id}/model-input`, (route) => (fail ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }) : route.fallback()));
	await openData(page, project.id);
	await page.getByRole('button', { name: 'Preview all data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	const note = dialog.getByTestId('preview-areas');
	await expect(note).toContainText('Couldn’t compute the rain of Average catchment rainfall (unavailable)');
	await expect(dialog.getByTestId('derived-tag')).toHaveCount(0);
	fail = false;
	await note.getByRole('button', { name: 'Try again' }).click();
	await expect(dialog.getByTestId('derived-tag')).toHaveCount(12);
	await expect(note).toHaveCount(0);
});
