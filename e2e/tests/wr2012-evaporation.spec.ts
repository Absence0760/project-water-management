// Model settings → Demand → "Where the A-pan row comes from" (docs/ui.md §
// Demand, docs/maps.md § WR2012 evaporation by quaternary). The committed
// INVENTED quaternaries (region Z) and their invented monthly S-pan and A-pan
// under a boundary across the Z01A/Z01B divide: each quaternary's share, MAE,
// S-pan and A-pan totals and module agreement (Z01B's runoff modules
// disagree), the catchment's area-weighted rows, then Use asks first and saves
// the A-pan as it stands, as one settings revision History shows. Then the
// typed S-pan, converted by the equation picked, and the links to the stations
// and the grid. The tables are read, never the map.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box, loadSyntheticQuaternaries, loadSyntheticQuaternaryEvaporation } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const panel = (page: Page) => page.getByTestId('wr2012-evaporation-proposal');
const row = (page: Page, name: string, code?: string) => panel(page).locator(`tr[data-row="${name}"]${code ? `[data-code="${code}"]` : ''}`);

test.beforeAll(async () => {
	await loadSyntheticQuaternaries();
	await loadSyntheticQuaternaryEvaporation();
});

test('an editor uses WR2012’s A-pan for the quaternaries under the boundary, as it stands; History names them', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'WR2012 evaporation');
	// 0.10° in Z01A and 0.05° in Z01B: about two thirds and one third.
	const made = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: [box(21.15, -33.7, 0.15)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	await page.goto(`/projects/${project.id}?tab=settings`);
	await page.getByTestId('apan-from').selectOption('wr2012');
	await expect(panel(page).getByTestId('wr2012-evaporation-body')).toHaveAttribute('data-ready', 'true');

	await expect(panel(page).getByTestId('wr2012-evaporation-synthetic')).toContainText('Synthetic test data.');
	const qs = panel(page).getByTestId('wr2012-evaporation-quaternaries');
	await expect(qs.locator('tr[data-code="Z01A"]')).toHaveText(/Z01A\s*66 %\s*Z1\s*1\s?500\s*1\s?530\s*1\s?943\s*1\.27\s*2 modules agree\s*2 modules agree/);
	await expect(qs.locator('tr[data-code="Z01B"]')).toHaveAttribute('data-disagree', 'true');
	await expect(qs.locator('tr[data-code="Z01B"]')).toContainText(/2 of 3 agree; others 1\s?620 mm/);
	await expect(panel(page).getByTestId('wr2012-evaporation-disagree')).toBeVisible();
	await expect(panel(page).getByTestId('wr2012-evaporation-mean')).toHaveText('The catchment’s A-pan is the mean of the 2 quaternaries’ rows, each weighted by its share of the catchment’s area.');
	await expect(row(page, 'quaternary', 'Z01A').getByRole('cell').first()).toHaveText('190');
	await expect(row(page, 'span').getByRole('cell').first()).toHaveText('152');
	await expect(row(page, 'proposed').getByRole('cell').first()).toHaveText('193.4');

	const use = panel(page).getByRole('button', { name: 'Use as the A-pan' });
	await expect(use).toHaveAccessibleDescription('Saves now');
	await use.click();
	await answerConfirm(page, true, /WR2012’s A-pan from the irrigation modules of Z01A \(66 %\), Z01B \(34 %\), area-weighted, as it stands\./);
	await expect(panel(page).getByTestId('wr2012-evaporation-notice')).toContainText(/The A-pan row is now .* mm a year from WR2012’s irrigation modules for Z01A, Z01B, saved as a settings revision/);
	await expect(panel(page).getByTestId('wr2012-evaporation-notice')).toBeFocused();
	await expect(panel(page).getByTestId('wr2012-evaporation-same')).toBeVisible();
	await expect(page.getByTestId('apan-row').getByLabel('A-pan evaporation, Oct, mm', { exact: true })).toHaveValue('193.4');
	await expectNoViolations(page, { include: '[data-testid="wr2012-evaporation-proposal"]' });

	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoSidewaysScroll(page);

	await page.goto(`/projects/${project.id}?tab=history`);
	await expect(page.getByTestId('history-entry').filter({ hasText: 'A-pan evaporation from WR2012’s WRSM2000 irrigation modules' }).first()).toContainText(
		/Z01A 66 %, Z01B 34 %; from 3 module files/
	);
});

test('a catchment in a quaternary with S-pan only proposes no A-pan and points to the typed S-pan', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'WR2012 S-pan only');
	const made = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'catchment_boundary', name: 'In Z02C', geometry: { type: 'Polygon', coordinates: [box(21.55, -33.95, 0.1)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	await page.goto(`/projects/${project.id}?tab=settings`);
	await page.getByTestId('apan-from').selectOption('wr2012');
	await expect(panel(page).getByTestId('wr2012-evaporation-body')).toHaveAttribute('data-ready', 'true');
	await expect(panel(page).getByTestId('wr2012-evaporation-problem')).toContainText('no irrigation module gives the A-pan of Z02C, only its S-pan');
	await expect(panel(page).getByTestId('wr2012-evaporation-quaternaries').locator('tr[data-code="Z02C"]')).toContainText('None: no irrigation module gives its A-pan, only S-pan');
	await expect(panel(page).getByRole('button', { name: 'Use as the A-pan' })).toHaveCount(0);
});

test('Demand’s A-pan source: typed S-pan converted by the equation picked, and links to where the other sources live', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Typed S-pan');
	// A month saved with many decimals (a pasted spreadsheet's) shows to 0.1 mm; the stored value is kept.
	const fine = [128.7363636, 170, 190, 195, 160, 140, 95, 70, 55, 57, 78, 105];
	const saved = await page.request.patch(`${API_URL}/projects/${project.id}`, { data: { settings: { apanMm: fine } } });
	expect(saved.status(), await saved.text()).toBe(200);
	await page.goto(`/projects/${project.id}?tab=settings`);
	await expect(page.getByTestId('apan-row').getByLabel('A-pan evaporation, Oct, mm', { exact: true })).toHaveValue('128.7');
	const from = page.getByTestId('apan-from');
	await expect(from).toHaveValue('typed');
	await expect(page.getByTestId('grid-actions').getByRole('button', { name: 'Paste from a spreadsheet…' })).toBeVisible();
	await from.selectOption('station');
	await expect(page.getByTestId('apan-from-link').getByRole('link', { name: 'Evaporation stations' })).toHaveAttribute('href', '?tab=calibration#set-evaporation-station');
	await from.selectOption('span');
	const entry = page.getByTestId('span-entry');
	await entry.getByLabel(/Paste the 12 S-pan months/).fill(['150', '170', '190', '195', '160', '140', '95', '70', '55', '57', '78', '105'].join('\t'));
	await entry.getByRole('button', { name: 'Fill the months' }).click();
	await expect(entry.locator('tr[data-row="span"] td').last()).toHaveText(/1\s?465/);
	await expect(entry.locator('tr[data-row="proposed"]')).toContainText('Pick an equation below');
	await entry.getByTestId('span-entry-conversion').getByRole('radio', { name: /Taljaard/ }).check();
	await expect(entry.locator('tr[data-row="proposed"] td').first()).toHaveText('185.1');
	await entry.getByLabel(/Where the S-pan comes from/).fill('Invented S-pan for the test');
	await entry.getByRole('button', { name: 'Use as the A-pan' }).click();
	await answerConfirm(page, true, /from 1\s?465 mm of S-pan \(Invented S-pan for the test\), converted by the Taljaard \(2023\) general monthly equation, inverted\./);
	await expect(entry.getByTestId('span-entry-notice')).toBeFocused();
	await expect(page.getByTestId('apan-row').getByLabel('A-pan evaporation, Oct, mm', { exact: true })).toHaveValue('185.1');
	await expectNoViolations(page, { include: '[data-testid="span-entry"]' });

	await page.goto(`/projects/${project.id}?tab=history`);
	await expect(page.getByTestId('history-entry').filter({ hasText: 'A-pan evaporation from S-pan typed or pasted' }).first()).toContainText(/\(Invented S-pan for the test\).*Oct–Sep, mm: 150 170 190/);
});
