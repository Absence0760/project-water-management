// Calibration → Flow calibration → "WR2012 S-pan by quaternary" (docs/ui.md §
// Set up the fit, docs/maps.md § WR2012 S-pan). The committed INVENTED
// quaternaries (region Z, with invented MAEs and evaporation zones) under a
// boundary across the Z01A/Z01B divide: each quaternary's zone, MAE, share
// and S-pan row, the catchment's area-weighted S-pan, no A-pan until an
// equation is picked, then Use asks first and saves one settings revision
// naming the quaternaries and the equation, which History shows. The tables
// are read, never the map.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box, loadSyntheticQuaternaries } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const panel = (page: Page) => page.getByTestId('wr2012-span-proposal');
const row = (page: Page, name: string, code?: string) => panel(page).locator(`tr[data-row="${name}"]${code ? `[data-code="${code}"]` : ''}`);

test.beforeAll(async () => {
	await loadSyntheticQuaternaries();
});

test('an editor turns the quaternaries’ WR2012 S-pan into the A-pan with the equation picked; History names them', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'WR2012 S-pan');
	// 0.10° in Z01A and 0.05° in Z01B: about two thirds and one third.
	const made = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: [box(21.15, -33.7, 0.15)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	await page.goto(`/projects/${project.id}?tab=calibration`);
	await expect(panel(page).getByTestId('wr2012-span-body')).toHaveAttribute('data-ready', 'true');

	await expect(panel(page).getByTestId('wr2012-span-synthetic')).toContainText('Synthetic test data.');
	const qs = panel(page).getByTestId('wr2012-span-quaternaries');
	await expect(qs.locator('tr[data-code="Z01A"]')).toHaveText(/Z01A\s*Z1\s*1\s?500\s*66 %/);
	await expect(qs.locator('tr[data-code="Z01B"]')).toHaveText(/Z01B\s*Z1\s*1\s?560\s*34 %/);
	await expect(panel(page).getByTestId('wr2012-span-mean')).toHaveText('The catchment’s S-pan is the mean of the 2 quaternaries’ rows, each weighted by its share of the catchment’s area.');
	await expect(row(page, 'quaternary', 'Z01A').getByRole('cell').first()).toHaveText('153');
	await expect(row(page, 'quaternary', 'Z01B').getByRole('cell').first()).toHaveText('159.1');
	await expect(row(page, 'span').getByRole('cell').first()).toHaveText('155.1');
	await expect(row(page, 'proposed')).toContainText('Pick an equation above');
	await expect(panel(page).getByRole('button', { name: 'Use as the A-pan' })).toHaveCount(0);
	await expect(panel(page).getByTestId('wr2012-span-conversion')).toContainText('cannot be inverted');

	await panel(page).getByTestId('wr2012-span-conversion').getByRole('radio', { name: /Taljaard/ }).check();
	await expect(row(page, 'proposed').getByRole('cell').first()).toHaveText('191');
	const use = panel(page).getByRole('button', { name: 'Use as the A-pan' });
	await expect(use).toHaveAccessibleDescription('Saves now');
	await use.click();
	await answerConfirm(page, true, /from the area-weighted WR2012 S-pan of Z01A \(66 %\), Z01B \(34 %\), converted by the Taljaard \(2023\) general monthly equation, inverted\./);
	await expect(panel(page).getByTestId('wr2012-span-notice')).toContainText(/The A-pan row is now .* mm a year from WR2012’s S-pan for Z01A, Z01B, saved as a settings revision/);
	await expect(panel(page).getByTestId('wr2012-span-notice')).toBeFocused();
	await expect(panel(page).getByTestId('wr2012-span-same')).toBeVisible();
	await expect(row(page, 'saved').getByRole('cell').first()).toHaveText('191');
	await expectNoViolations(page, { include: '[data-testid="wr2012-span-proposal"]' });

	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoSidewaysScroll(page);

	await page.goto(`/projects/${project.id}?tab=history`);
	await expect(page.getByTestId('history-entry').filter({ hasText: 'A-pan evaporation from WR2012 S-pan' }).first()).toContainText(
		/Z01A 66 % \(zone Z1, MAE 1500 mm\), Z01B 34 % \(zone Z1, MAE 1560 mm\).*Taljaard \(2023\)/
	);
});
