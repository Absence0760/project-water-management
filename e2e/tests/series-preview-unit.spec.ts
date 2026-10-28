// Preview all data's View select (issue #613, docs/ui.md § Data): pick a hydrological unit and see only what its rain
// is made of, side by side (its station raw and adjusted, each patch station raw and adjusted, its CHIRPS raw and
// bias-corrected with the twelve factors, the rain used and where each day came from), with the view kept in the URL through a reload and a close and reopen.
// Synthetic catchment: invented names and values only (public repo).
import type { APIRequestContext } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, node, putModel, updateSettings } from '../support/api.ts';
import { openData, seriesRow } from '../support/data.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const START = '2015-01-01';
const DAYS = 2192; // 2015 … 2020, so the CHIRPS pairing has its five whole years
const rain = (k: number, phase = 0) => Array.from({ length: DAYS }, (_, i) => Math.round(((i + phase) % 11 === 0 ? 24 * k : (i + phase) % 4 === 0 ? 2 * k : 0) * 10) / 10);

async function put(request: APIRequestContext, projectId: string, s: Record<string, unknown>, siteNodeId?: string): Promise<string> {
	const res = await request.put(`${API_URL}/projects/${projectId}/series`, { data: { unit: 'mm', startDate: START, ...s } });
	expect(res.status()).toBe(200);
	const { series } = (await (await request.get(`${API_URL}/projects/${projectId}/series`)).json()) as { series: { id: string; name: string }[] };
	const id = series.find((x) => x.name === s.name)!.id;
	if (siteNodeId) expect((await request.patch(`${API_URL}/projects/${projectId}/series/${id}`, { data: { siteNodeId } })).status()).toBe(200);
	return id;
}

/**
 * Two land units under per-unit rain, both on Bergwater (MAP 745 mm), each with its own CHIRPS; a flow record at the
 * outlet. `chain`: a third unit with no station, only its own CHIRPS and a MAP (§2.4h rule 3, issue #613 slice 2).
 */
async function seed(request: APIRequestContext, chain = false, patch = false) {
	const project = await createProject(request, 'Unit view');
	const gauge = node('Outflow gauge', 'gauge', null, 1, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const a = node('Upper unit', 'farm', gauge.id, 2, { mapMm: 863.1, mapSource: 'invented' });
	const b = node('Lower unit', 'farm', gauge.id, 3, { mapMm: 600, mapSource: 'invented' });
	const m = node('Middle unit', 'farm', gauge.id, 4, { mapMm: 700, mapSource: 'invented' });
	await putModel(request, project.id, { nodes: chain ? [gauge, a, b, m] : [gauge, a, b], crops: [], cropAreas: [], transfers: [] });
	// Bergwater misses ten days in 2015, which Upper unit fills from its CHIRPS corrected against it.
	const bergId = await put(request, project.id, {
		kind: 'rain_catchment_mm',
		name: 'Bergwater',
		values: rain(1.6, 1).map((v, i) => (i >= 40 && i < 50 ? null : v)),
		station: { mapMm: 745, mapSource: 'Station record, 1991–2020', lat: null, lon: null }
	});
	await put(request, project.id, { kind: 'rain_chirps_mm', name: 'CHIRPS Upper unit', values: rain(0.8, 1) }, a.id);
	await put(request, project.id, { kind: 'rain_chirps_mm', name: 'CHIRPS Lower unit', values: rain(0.5, 3) }, b.id);
	if (chain) await put(request, project.id, { kind: 'rain_chirps_mm', name: 'CHIRPS Middle unit', values: rain(0.6, 2) }, m.id);
	// `patch` (issue #613 slice 3): Kloof (MAP 500 mm) reads on the first five of Bergwater's ten gap days only, so a
	// two-step chain fills those from Kloof × 863.1 ÷ 500 and the last five from the corrected CHIRPS.
	const kloofId = patch
		? await put(request, project.id, {
				kind: 'rain_catchment_mm',
				name: 'Kloof',
				values: rain(1.5, 2).map((v, i) => (i >= 45 && i < 50 ? null : v)),
				station: { mapMm: 500, mapSource: 'Station record, 1991–2020', lat: null, lon: null }
			})
		: null;
	await put(request, project.id, { kind: 'flow_observed_m3s', name: 'Outlet weir', unit: 'm³/s', values: Array.from({ length: DAYS }, (_, i) => 0.1 + (i % 11) / 50) });
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		unitRain: { mode: 'perUnit' },
		// Each unit's CHIRPS is corrected against Bergwater's rain at that unit's MAP (engine 1.105.0, issue #612); the site
		// only places Bergwater's own checks.
		rainStations: {
			units: { [a.id]: kloofId ? { stationId: bergId, patch: [{ source: 'station', stationId: kloofId }, { source: 'chirps' }] } : { stationId: bergId }, [b.id]: { stationId: bergId } },
			sites: { [bergId]: { unitId: a.id } }
		}
	});
	return { project, a, m };
}

test('Preview all data’s View picks one unit: its station raw and adjusted, its CHIRPS raw and corrected with the factors, kept in the URL', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const { project, a } = await seed(page.request);
	await openData(page, project.id);
	await page.getByRole('button', { name: 'Preview all data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	const headers = dialog.locator('thead th');
	await expect(dialog.getByTestId('derived-tag').first()).toBeVisible();

	// All, as before: the stored series and the four derived lines per unit, no raw lines.
	const view = dialog.getByLabel('View', { exact: true });
	await expect(view).toHaveValue('all');
	await expect(page).toHaveURL(/[?&]preview=all(&|$)/);
	await expect(headers.filter({ hasText: /raw/ })).toHaveCount(0);
	await expect(view.locator('option')).toHaveText(['All', 'Upper unit', 'Lower unit', 'All rainfall stations', 'All flow']);

	// Upper unit: only its lines, in order, labelled with what they are made of; the factors above the table.
	await view.selectOption({ label: 'Upper unit' });
	await expect(page).toHaveURL(new RegExp(`[?&]preview=unit%3A${a.id}(&|$)`));
	await expect(headers).toHaveText([
		/^Date/,
		/^Bergwater raw/,
		/^Bergwater adjusted to Upper unit \(× 1\.159\)/,
		/^Upper unit CHIRPS raw/,
		/^Upper unit CHIRPS bias-corrected \(f\(m\) against Bergwater\)/,
		/^Upper unit rain used/,
		/^Upper unit rain used from/
	]);
	const factors = dialog.getByTestId('preview-factors');
	await expect(factors).toContainText('CHIRPS bias factors f(m) for Upper unit, fitted against Bergwater’s rain adjusted to Upper unit’s MAP over its own CHIRPS, January to December');
	// No patch station: the panel names no patching chain (CHIRPS alone, the default).
	await expect(factors.getByTestId('preview-patch-chain')).toHaveCount(0);
	await expect(factors.getByRole('listitem')).toHaveCount(12);
	// Bergwater is twice Upper unit's CHIRPS, taken to the unit's MAP: 2 × 863.1 ÷ 745 = 2.32 (issue #612).
	await expect(factors.getByRole('listitem').first()).toHaveText('Jan 2.32');

	// A Bergwater gap day: no raw station, so the rain used is the corrected CHIRPS (raw × January's 2.32).
	await dialog.getByLabel('Search by date or value').fill('2015-02-13');
	const cells = dialog.getByRole('table').getByRole('row').filter({ has: page.getByRole('cell', { name: '13 Feb 2015', exact: true }) }).getByRole('cell');
	await expect(cells).toHaveCount(7);
	await expect(cells.nth(1)).toHaveText('–');
	const raw = Number((await cells.nth(3).innerText()).trim());
	const corrected = (await cells.nth(4).innerText()).trim();
	expect(Number(corrected)).toBeCloseTo((raw * 2 * 863.1) / 745, 1);
	await expect(cells.nth(5)).toHaveText(corrected);
	await expect(cells.nth(6)).toHaveText('corrected CHIRPS');
	await expectNoViolations(page);

	// Missing only reads the raw lines' stored series: Bergwater's ten missing days.
	await dialog.getByLabel('Search by date or value').fill('');
	await dialog.getByRole('checkbox', { name: 'Missing only' }).check();
	await expect(dialog).toContainText(/\b10 of [\d\s]+ days shown/);
	await dialog.getByRole('checkbox', { name: 'Missing only' }).uncheck();

	// The column checkboxes hide a column within the view.
	await dialog.locator('summary', { hasText: 'Columns' }).click();
	await dialog.getByRole('checkbox', { name: 'Upper unit CHIRPS raw' }).uncheck();
	await dialog.locator('summary', { hasText: 'Columns' }).click();
	await expect(headers).toHaveCount(6);

	// A reload reopens the dialog on the same view.
	await page.reload();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel('View', { exact: true })).toHaveValue(`unit:${a.id}`);
	await expect(headers.nth(1)).toHaveText(/^Bergwater raw/);

	// Closed, the parameter goes; reopened in the same visit, the view is kept.
	await dialog.getByRole('button', { name: 'Close' }).last().click();
	await expect(dialog).toBeHidden();
	await expect(page).not.toHaveURL(/preview=/);
	await page.getByRole('button', { name: 'Preview all data' }).click();
	await expect(dialog.getByLabel('View', { exact: true })).toHaveValue(`unit:${a.id}`);
	await expect(page).toHaveURL(new RegExp(`[?&]preview=unit%3A${a.id}(&|$)`));

	// All flow: the outlet's record with its m³/day and the calibration exclusions.
	await dialog.getByLabel('View', { exact: true }).selectOption({ label: 'All flow' });
	await expect(headers).toHaveText([/^Date/, /^Flow — observed gauge · Outlet weir/, /^Flow — observed gauge · Outlet weir \(m³\/day\)/, /^Excluded from calibration/]);
	await expect(dialog.getByTestId('preview-factors')).toHaveCount(0);
});

test('a link to a view the project doesn’t offer opens on All; a row’s own Preview of a series outside the view switches to All', async ({ page, owner }) => {
	void owner;
	const { project, a } = await seed(page.request);
	await openData(page, project.id, '&preview=unit%3Agone');
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	const view = dialog.getByLabel('View', { exact: true });
	await expect(view).toHaveValue('all');
	await expect(page).toHaveURL(/[?&]preview=all(&|$)/);

	// Upper unit's view holds no flow record, so the weir's own Preview shows All with the weir highlighted.
	await view.selectOption({ label: 'Upper unit' });
	await expect(page).toHaveURL(new RegExp(`[?&]preview=unit%3A${a.id}(&|$)`));
	await dialog.getByRole('button', { name: 'Close' }).last().click();
	await expect(page).not.toHaveURL(/preview=/);
	await seriesRow(page, 'Outlet weir').getByRole('button', { name: 'Preview' }).click();
	await expect(view).toHaveValue('all');
	await expect(dialog.locator('thead th.hl').first()).toContainText('Outlet weir');

	// A phone: the View select and the factors fit, no sideways scroll, no a11y violations.
	await page.setViewportSize({ width: 390, height: 844 });
	await view.selectOption({ label: 'Upper unit' });
	await expect(dialog.getByTestId('preview-factors').getByRole('listitem')).toHaveCount(12);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await expectNoViolations(page);
});

test('a unit without a station shows its own chain: its CHIRPS raw and levelled to its MAP, the rain used and the link of each day', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const { project, m } = await seed(page.request, true);
	await openData(page, project.id);
	await page.getByRole('button', { name: 'Preview all data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	const headers = dialog.locator('thead th');
	const view = dialog.getByLabel('View', { exact: true });
	await expect(view.locator('option')).toHaveText(['All', 'Upper unit', 'Lower unit', 'Middle unit', 'All rainfall stations', 'All flow']);

	await view.selectOption({ label: 'Middle unit' });
	await expect(page).toHaveURL(new RegExp(`[?&]preview=unit%3A${m.id}(&|$)`));
	// Bergwater is the catchment gauge too, so Middle unit (MAP 700 mm) reads it × 700 ÷ 745 first (rule 2), its own
	// CHIRPS levelled to its MAP on Bergwater's gaps.
	await expect(headers).toHaveText([
		/^Date/,
		/^Catchment gauge adjusted to Middle unit \(× 0\.940\)/,
		/^Middle unit CHIRPS raw/,
		/^Middle unit CHIRPS levelled \(× \d\.\d{3} to its MAP\)/,
		/^Middle unit rain used/,
		/^Middle unit rain used from/
	]);
	const k = Number((await headers.nth(3).innerText()).match(/× (\d\.\d{3})/)![1]);
	const panel = dialog.getByTestId('preview-factors');
	await expect(panel.getByTestId('preview-chain-rule')).toHaveText(
		'Middle unit has no rainfall station: under per-unit rain a run reads the catchment gauge × its MAP ratio, its gaps from its own CHIRPS, then the catchment rain (§2.4h).'
	);
	await expect(panel).toContainText('MAP ratio × 0.940');
	await expect(panel).toContainText(`Its CHIRPS is levelled × ${k.toFixed(3)} to its MAP.`);

	const search = dialog.getByLabel('Search by date or value');
	const row = (day: string) => dialog.getByRole('table').getByRole('row').filter({ has: page.getByRole('cell', { name: day, exact: true }) }).getByRole('cell');
	// A Bergwater gap day: the rain used is the unit's CHIRPS × k.
	await search.fill('2015-02-12');
	const gap = row('12 Feb 2015');
	await expect(gap).toHaveCount(6);
	await expect(gap.nth(1)).toHaveText('–');
	expect(Number((await gap.nth(2).innerText()).trim())).toBe(14.4);
	const levelled = (await gap.nth(3).innerText()).trim();
	expect(Number(levelled)).toBeCloseTo(14.4 * k, 1);
	await expect(gap.nth(4)).toHaveText(levelled);
	await expect(gap.nth(5)).toHaveText('own CHIRPS (levelled)');
	// A Bergwater day: the rain used is the gauge × 0.940.
	await search.fill('2015-01-10');
	const wet = row('10 Jan 2015');
	await expect(wet.nth(5)).toHaveText('catchment gauge × MAP ratio');
	await expect(wet.nth(4)).toHaveText((await wet.nth(1).innerText()).trim());
	await expectNoViolations(page);

	// All gains its derived links too, beside the station units' lines.
	await view.selectOption({ label: 'All' });
	await expect(headers.filter({ hasText: /^Middle unit: CHIRPS levelled/ })).toHaveCount(1);
	await expect(headers.filter({ hasText: /^Middle unit: rain used from/ })).toHaveCount(1);
});

test('a unit’s two-step patching chain: Bergwater, then Kloof raw and adjusted, then the CHIRPS; a day filled from Kloof names it (issue #613 slice 3)', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const { project } = await seed(page.request, false, true);
	await openData(page, project.id);
	await page.getByRole('button', { name: 'Preview all data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	const headers = dialog.locator('thead th');
	const view = dialog.getByLabel('View', { exact: true });
	await view.selectOption({ label: 'Upper unit' });
	// The patch station sits between the main station and the CHIRPS, numbered by its place in the priority.
	await expect(headers).toHaveText([
		/^Date/,
		/^Bergwater raw/,
		/^Bergwater adjusted to Upper unit \(× 1\.159\)/,
		/^Patch 1: Kloof raw/,
		/^Patch 1: Kloof adjusted to Upper unit \(× 1\.726\)/,
		/^Upper unit CHIRPS raw/,
		/^Upper unit CHIRPS bias-corrected \(f\(m\) against Bergwater\)/,
		/^Upper unit rain used/,
		/^Upper unit rain used from/
	]);
	const panel = dialog.getByTestId('preview-factors');
	// The factors are Upper unit's own: Bergwater taken to its MAP over its own CHIRPS (issue #612).
	await expect(panel).toContainText('CHIRPS bias factors f(m) for Upper unit, fitted against Bergwater’s rain adjusted to Upper unit’s MAP over its own CHIRPS');
	await expect(panel.getByTestId('preview-patch-chain')).toHaveText(/^Its station’s gaps are patched from 1\. Kloof × 1\.726 \(5 days\), 2\. its corrected CHIRPS \(5 days\), in that order\.$/);

	const search = dialog.getByLabel('Search by date or value');
	const row = (day: string) => dialog.getByRole('table').getByRole('row').filter({ has: page.getByRole('cell', { name: day, exact: true }) }).getByRole('cell');
	// A Bergwater gap day Kloof reads on: the rain used is Kloof × 863.1 ÷ 500, and Rain used from names it.
	await search.fill('2015-02-12');
	const kloofDay = row('12 Feb 2015');
	await expect(kloofDay).toHaveCount(9);
	await expect(kloofDay.nth(1)).toHaveText('–');
	expect(Number((await kloofDay.nth(3).innerText()).trim())).toBe(36);
	const adjusted = (await kloofDay.nth(4).innerText()).trim();
	expect(Number(adjusted)).toBeCloseTo((36 * 863.1) / 500, 1);
	await expect(kloofDay.nth(7)).toHaveText(adjusted);
	await expect(kloofDay.nth(8)).toHaveText('patch 1: Kloof');
	// A gap day Kloof misses too: the next in the chain, the corrected CHIRPS.
	await search.fill('2015-02-16');
	const chirpsDay = row('16 Feb 2015');
	await expect(chirpsDay.nth(3)).toHaveText('–');
	await expect(chirpsDay.nth(7)).toHaveText((await chirpsDay.nth(6).innerText()).trim());
	await expect(chirpsDay.nth(8)).toHaveText('corrected CHIRPS');
	await expectNoViolations(page);

	// All shows Kloof × its ratio after Bergwater's, not its raw record (a stored column there already).
	await view.selectOption({ label: 'All' });
	await expect(headers.filter({ hasText: /^Upper unit: patch 1: Kloof × ratio/ })).toHaveCount(1);
	await expect(headers.filter({ hasText: /^Patch 1: Kloof raw/ })).toHaveCount(0);
});
