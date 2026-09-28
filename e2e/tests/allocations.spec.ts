// Allocations (WP-3.10, docs/allocations.md, docs/ui.md § Allocations): an
// editor imports a CSV of registered volumes, sees the preview with the bad
// row and the unmatched row first, matches the unmatched one by hand and
// imports; the list shows each volume with its source file, and the run's
// modelled use sits next to the registered volume per water year (the page's
// layout, the sheets and the big case: allocations-page.spec.ts). A viewer
// sees the volumes but no names and can't import. Axe-scanned, and on a
// phone. Licence conditions entered in the sheet show in the list, and a run
// capped at the registered volumes (settings.allocationMode, engine 1.18.0)
// says so above its comparison (issue #72). Synthetic data only.
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { grouped } from '../support/format.ts';

const CSV = [
	'registration_no,property_ref,farm,holder,authorisation,purpose,water_source,volume_m3_year,storage_m3,valid_from,valid_to,reference',
	'E2E-1,Portion 1,Upper farm,Invented Holder,licence,irrigation,surface,50000,150000,2020-01-01,,synthetic',
	'E2E-2,Portion 2,Somewhere else,Other Holder,registration,irrigation,surface,20000,,,,synthetic',
	'E2E-3,Portion 3,Upper farm,Broken Row,licence,irrigation,lake,100,,,,synthetic'
].join('\n');

test('an editor imports registered volumes and compares them with modelled use', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Allocations golden path');
	await createRun(page.request, project.id, 'Baseline');

	await page.goto(`/projects/${project.id}?tab=allocations`);
	await expect(page.getByTestId('allocations-empty')).toContainText('No registered volumes yet.');
	// With nothing registered, the modelled use shows as having no registered volume.
	const compare = page.getByTestId('allocation-compare-table');
	await expect(compare.getByRole('row', { name: /Upper farm/ }).first()).toContainText('No registered volume');

	// Import the template-shaped CSV, in the header's Import sheet.
	await page.getByTestId('section-header').getByRole('link', { name: 'Import', exact: true }).click();
	const wizard = page.getByTestId('allocation-import');
	await wizard.getByLabel('What the file is').selectOption('csv');
	await wizard.getByLabel('Reference (optional)').fill('e2e synthetic');
	await wizard.getByLabel('File (CSV, up to 2 MB)').setInputFiles({ name: 'allocations.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
	const summary = page.getByTestId('allocation-preview-summary');
	await expect(summary).toHaveText("allocations.csv: 3 rows, 1 matched to a hydrological unit, 1 not matched, 1 with problems (they won't be imported).");
	// The row with a problem first, then the unmatched one.
	const previewRows = page.getByTestId('allocation-preview').locator('tbody tr');
	await expect(previewRows.nth(0)).toContainText('unknown water source “lake”');
	await expect(previewRows.nth(1)).toContainText('Somewhere else');
	await page.getByLabel('Hydrological unit for line 3').selectOption({ label: 'Lower farm' });
	await expect(summary).toContainText('2 matched to a hydrological unit, 0 not matched');
	await expectNoViolations(page);
	await page.getByRole('button', { name: 'Import 2 rows' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Imported 2 rows' })).toHaveText('Imported 2 rows from allocations.csv; 1 with problems were left out.');

	// The list: each volume with its farm, holder (an editor sees names) and source file.
	const list = page.getByTestId('allocation-list');
	await expect(list.getByRole('row', { name: /Upper farm/ })).toContainText('Invented Holder');
	await expect(list.getByRole('row', { name: /Upper farm/ })).toContainText('50\u202f000');
	await expect(list.getByRole('row', { name: /Upper farm/ })).toContainText('allocations.csv');
	await expect(list.getByRole('row', { name: /Lower farm/ })).toContainText('20\u202f000');

	// The comparison: the run covers part of 2021/22, so the volume is prorated to its days.
	const upper = compare.getByRole('row', { name: /Upper farm/ }).first();
	await expect(upper).toContainText('Surface water');
	await expect(upper).toContainText('2021/22');
	await expect(upper).toContainText('part (120 d)');
	await expect(upper).toContainText(grouped((50_000 * 120) / 365));
	await expect(page.getByTestId('allocation-compare')).toContainText('modelled, not metered');

	// A viewer reads the volumes, without names, and can't import or change them.
	const viewer = await signIn('Allocations viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.goto(`/projects/${project.id}?tab=allocations`);
	const vList = v.getByTestId('allocation-list');
	await expect(vList.getByRole('row', { name: /Upper farm/ })).toContainText('50\u202f000');
	await expect(vList).not.toContainText('Invented Holder');
	await expect(vList.getByRole('columnheader', { name: 'Registered user' })).toHaveCount(0);
	await expect(v.getByText('Names of registered users are shown to editors only.')).toBeVisible();
	await expect(v.getByRole('link', { name: 'Import', exact: true })).toHaveCount(0);
	await expect(v.getByRole('link', { name: '+ Add volume' })).toHaveCount(0);
	await expectNoViolations(v);

	// On a phone, the comparison is one card per row.
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(compare.locator('thead')).toBeHidden();
	await expect(upper.getByText('2021/22')).toBeVisible();
	await expectNoViolations(page);
});

test('licence conditions entered by hand show with the volume, and a capped run says so', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Allocations conditions');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=allocations`);
	await expect(page.getByTestId('allocations-empty')).toBeVisible();
	// Compare only: nothing said about a mode.
	await expect(page.getByTestId('allocation-compare-table')).toBeVisible();
	await expect(page.getByTestId('allocation-mode-note')).toHaveCount(0);

	await page.getByTestId('section-header').getByRole('link', { name: '+ Add volume' }).click();
	const sheet = page.getByRole('dialog', { name: 'Add a registered volume' });
	await sheet.getByLabel('Unit or water user').selectOption({ label: 'Upper farm' });
	await sheet.getByLabel('Volume (m³ per year)').fill('1000');
	await sheet.getByLabel('Registration or licence number').fill('E2E-LIC');
	const months = sheet.getByRole('group', { name: 'Months water may be taken' });
	for (const m of ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar']) await months.getByLabel(m, { exact: true }).check();
	await sheet.getByLabel('Maximum rate (m³/s)').fill('0.05');
	await sheet.getByLabel('Other conditions, one a line').fill('No abstraction below 0.2 m³/s at the weir\nMeter and report monthly');
	await expectNoViolations(page);
	await sheet.getByRole('button', { name: 'Save' }).click();
	await expect(sheet).toBeHidden();
	const row = page.getByTestId('allocation-list').getByRole('row', { name: /Upper farm/ });
	await expect(row.getByTestId('allocation-conditions')).toHaveText('Oct–Mar only · at most 0.05 m³/s · 2 conditions');

	// Reopened, the sheet shows what was saved.
	await row.getByRole('button', { name: 'Change E2E-LIC' }).click();
	const change = page.getByRole('dialog', { name: 'Change the registered volume' });
	await expect(change.getByRole('group', { name: 'Months water may be taken' }).getByLabel('Oct', { exact: true })).toBeChecked();
	await expect(change.getByRole('group', { name: 'Months water may be taken' }).getByLabel('Apr', { exact: true })).not.toBeChecked();
	await expect(change.getByLabel('Other conditions, one a line')).toHaveValue('No abstraction below 0.2 m³/s at the weir\nMeter and report monthly');
	await change.getByRole('button', { name: 'Cancel' }).click();

	// A run capped at the registered volumes: the comparison says what the cap did.
	await updateSettings(page.request, project.id, { allocationMode: 'cap' });
	const capped = await createRun(page.request, project.id, 'Capped');
	await page.goto(`/projects/${project.id}?tab=allocations&run=${capped}`);
	await expect(page.getByTestId('allocation-mode-note')).toContainText('This run capped each unit’s use at its registered volume per water year');
});
