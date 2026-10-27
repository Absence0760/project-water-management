// The gap-filling product (issue #604 R4-E, settings.gapRain, docs/model.md
// §2.4b *Gap-filling product*): Settings → Rain gaps chooses it in plain
// words, and Data draws ERA5-Land beside CHIRPS over the CHIRPS feed's cells,
// with Copernicus's credit, and the per-day preview names the product that
// filled a blank day. Everything comes from the committed synthetic copy
// (backend/fixtures/mirror/: era5l 2024-01-01 to 2025-12-30 over the fixture
// grid; FEED_SOURCE=fixtures, CHIRPS_SOURCE=mirror): no network, no key.
import { API_URL } from '../support/env.ts';
import { createProject, putSeries, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';
import { openFold, openSettings, saveSettings, showExplanations } from '../support/settings.ts';

test('Settings → Rain gaps chooses the gap-filling product and IMERG Late in plain words, and keeps them', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Gap product settings');
	await openSettings(page, project.id);
	await showExplanations(page);
	await openFold(page, 'rain-defaults');
	const card = page.getByTestId('gap-rain-card');
	const product = card.getByLabel('Fill blank catchment-rain days from');
	const imerg = card.getByRole('checkbox', { name: 'Fill the last few days from IMERG Late' });
	// The default: CHIRPS, no IMERG, and no state line.
	await expect(product).toHaveValue('chirps');
	await expect(imerg).not.toBeChecked();
	await expect(card.getByTestId('gap-rain-note')).toHaveCount(0);
	await expect(product).toHaveAccessibleDescription(/^Blank catchment-rain days take CHIRPS/);

	await product.selectOption({ label: 'ERA5-Land instead of CHIRPS' });
	// Why to pick it, in the field's own description.
	await expect(product).toHaveAccessibleDescription(/daily r 0\.57 against 0\.25 for CHIRPS/);
	await imerg.check();
	await expect(imerg).toHaveAccessibleDescription(/covers the days before CHIRPS’ first values appear/);
	const note = card.getByTestId('gap-rain-note');
	await expect(note).toContainText('from our copy of the rain data over the CHIRPS feed’s cells');
	await expect(note.getByRole('link', { name: 'Rain products side by side' })).toHaveAttribute('href', '?tab=series#data-gap-rain');
	await saveSettings(page);

	await page.reload();
	await expect(page.getByTestId('summary-rain')).toContainText('Gaps from ERA5-Land, and IMERG Late for the recent days');
	// No longer at the defaults: the fold opens on its own, its line naming the product first.
	await expect(page.getByTestId('rain-defaults')).toHaveAttribute('open', '');
	await expect(page.getByTestId('rain-defaults').locator(':scope > summary')).toContainText('gaps from ERA5-Land, and IMERG Late for the recent days');
	await expect(product).toHaveValue('era5l');
	await expect(imerg).toBeChecked();

	// Back to CHIRPS without IMERG stores nothing (null): the fold's line reads as at the defaults again.
	await imerg.uncheck();
	await product.selectOption('chirps');
	await saveSettings(page);
	await page.reload();
	await expect(page.getByTestId('summary-rain')).not.toContainText('Gaps from');
	const stored = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()) as { project: { settings: { gapRain?: unknown } } };
	expect(stored.project.settings.gapRain ?? null).toBeNull();
});

test('Data draws ERA5-Land beside CHIRPS with its credit, and the preview names the product that filled a blank day', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Gap products on Data');
	await updateSettings(page.request, project.id, { gapRain: { product: 'era5l', imergLate: false } });
	// A catchment rain record with five blank days, inside the copy's ERA5-Land years.
	await putSeries(page.request, project.id, {
		kind: 'rain_catchment_mm',
		unit: 'mm',
		startDate: '2024-01-01',
		values: Array.from({ length: 30 }, (_, i) => (i >= 5 && i < 10 ? null : (i % 4) * 2))
	});
	// A CHIRPS feed over a cell of the fixture grid: its fetch from the copy fills ERA5-Land for the same cells.
	const feed = await page.request.post(`${API_URL}/projects/${project.id}/feeds`, { data: { source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17 }], startDate: '2024-01-01' } } });
	expect(feed.status(), await feed.text()).toBe(201);
	const feedId = ((await feed.json()) as { feed: { id: string } }).feed.id;
	expect((await page.request.post(`${API_URL}/projects/${project.id}/feeds/${feedId}/run-now`, { data: {} })).status()).toBe(202);
	await runJobsTick({ projects: [project.id], schedule: false });

	await page.goto(`/projects/${project.id}?tab=series#data-gap-rain`);
	const panel = page.getByTestId('gap-rain-products');
	await expect(panel.getByRole('heading', { level: 2, name: 'Rain products side by side' })).toBeVisible();
	await expect(panel).toContainText('Gaps in the catchment rain are filled from ERA5-Land');
	await expect(panel.getByText('Daily rain: CHIRPS, ERA5-Land and IMERG Late')).toBeVisible();
	await expect(panel).toContainText(/Held: ERA5-Land \d+ days\./);
	// Two years of ERA5-Land are too few for its double mass: said, not drawn.
	await expect(panel).toContainText('No double mass against the products yet');
	const credits = panel.getByTestId('gap-rain-credits');
	await expect(credits).toContainText(/ERA5-Land: Contains modified Copernicus Climate Change Service information \d{4}\. Neither the European Commission nor ECMWF is responsible/);
	// No axe violation in the panel, and on a phone it fits with no sideways scroll.
	await expectNoViolations(page, { include: '[data-testid="gap-rain-products"]' });
	await resizeTo(page, { width: 390, height: 844 });
	await expectNoSidewaysScroll(page);
	await resizeTo(page, { width: 1280, height: 800 });
	// The section menu links it.
	await expect(page.getByRole('navigation', { name: 'Data sections' }).getByRole('link', { name: 'Rain products side by side' }).first()).toBeAttached();

	await page.getByRole('button', { name: 'Preview all data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Input time series — daily preview' });
	await dialog.getByRole('searchbox', { name: 'Search by date or value' }).fill('7 Jan 2024');
	const row = dialog.getByRole('row').filter({ hasText: '7 Jan 2024' });
	await expect(row.getByTestId('rain-source')).toHaveText(/·\s*ERA5-Land$/);
	// A recorded day stays the catchment's (positive control).
	await dialog.getByRole('searchbox', { name: 'Search by date or value' }).fill('2 Jan 2024');
	await expect(dialog.getByRole('row').filter({ hasText: '2 Jan 2024' }).getByTestId('rain-source')).toHaveText(/·\s*catchment$/);
	await expect(dialog.getByTestId('preview-credits')).toContainText('ERA5-Land: Contains modified Copernicus Climate Change Service information');
});
