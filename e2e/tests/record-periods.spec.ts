// A record's own periods (issue #611 slice 2, docs/model.md §2.4i and
// §2.10h, ui.md § Settings): Calibration → Calibration record lists each flow
// record's missing periods (settings.flowMissing), and Model settings → Rain
// gaps → Flagged rain each rain record's unreliable periods
// (settings.rainStations.unreliable, any rain record). Each saves, reads
// back, reaches the run (fewer scored days) and is listed when comparing runs.
// Dates are typed, never today's. Synthetic records only.
import { API_URL } from '../support/env.ts';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { whatChanged } from '../support/compare.ts';
import { expect, test } from '../support/fixtures.ts';
import { anySaveBar, openFold, openSettings, saveChanges, saveSettings } from '../support/settings.ts';

const calibrationDays = async (request: import('@playwright/test').APIRequestContext, projectId: string, runId: string) => {
	const res = await request.get(`${API_URL}/projects/${projectId}/runs/${runId}`);
	expect(res.status()).toBe(200);
	return ((await res.json()) as { run: { summary: { calibration: { days: number } } } }).run.summary.calibration.days;
};

test('a flow record’s missing periods need a reason, save, leave the days out of the run and show when comparing runs', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Missing periods of a record');
	const before = await createRun(page.request, project.id, 'Before');
	await page.goto(`/projects/${project.id}?tab=calibration`);

	const group = page.getByRole('group', { name: /^Missing periods of Flow — observed gauge/ });
	await expect(group.getByText('None: every reading of this record is used.')).toBeVisible();
	// Adding a row and removing it again leaves nothing to save.
	await group.getByRole('button', { name: 'A date range missing' }).click();
	await group.getByRole('button', { name: 'Remove missing period 1' }).click();
	await expect(anySaveBar(page)).toHaveCount(0);

	await group.getByRole('button', { name: 'A date range missing' }).click();
	await expect(group.getByRole('alert')).toHaveText('Missing period 1: needs a reason.');
	await expect(saveChanges(page)).toBeDisabled();
	await group.getByLabel('From', { exact: true }).fill('2021-11-01');
	await group.getByLabel('From', { exact: true }).press('Tab');
	await group.getByLabel('To', { exact: true }).fill('2021-11-30');
	await group.getByLabel('To', { exact: true }).press('Tab');
	await group.getByLabel('Reason').fill('Weir silted up');
	await expect(group.getByRole('alert')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="flow-missing-periods"]' });
	await saveSettings(page);
	await page.reload();
	await expect(page.getByRole('group', { name: /^Missing periods of Flow — observed gauge/ }).getByLabel('Reason')).toHaveValue('Weir silted up');

	// The run reads those 30 days of the record as missing: its statistics score fewer days.
	const after = await createRun(page.request, project.id, 'After');
	expect((await calibrationDays(page.request, project.id, before)) - (await calibrationDays(page.request, project.id, after))).toBe(30);
	await page.goto(`/compare?a=${project.id}:${before}&b=${project.id}:${after}`);
	await expect(whatChanged(page).getByText('Missing period of Observed flow 1 Nov 2021 – 30 Nov 2021 added: “Weir silted up”')).toBeVisible();
});

test('a rain record’s unreliable periods are marked under Flagged rain, counted on the fold’s line, and kept', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Unreliable rain periods');
	await openSettings(page, project.id);
	await openFold(page, 'rain-defaults');
	const group = page.getByRole('group', { name: /^Unreliable periods of a rain record/ });
	const record = group.getByTestId('rain-record');
	await expect(record).toHaveCount(1);
	await expect(record).toContainText('Rainfall — catchment');
	await expect(record.getByText('None: every reading of this record is used.')).toBeVisible();

	await record.getByRole('button', { name: 'Mark a period unreliable' }).click();
	await record.getByLabel('From', { exact: true }).fill('2021-12-10');
	await record.getByLabel('From', { exact: true }).press('Tab');
	await record.getByLabel('To', { exact: true }).fill('2021-12-01');
	await record.getByLabel('To', { exact: true }).press('Tab');
	// Reversed: an alert, and Save is blocked.
	await expect(group.getByRole('alert')).toHaveText('Rainfall — catchment: Unreliable period 1: ends before it starts.');
	await expect(saveChanges(page)).toBeDisabled();
	await record.getByLabel('To', { exact: true }).fill('2021-12-20');
	await record.getByLabel('To', { exact: true }).press('Tab');
	await expect(group.getByRole('alert')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="rain-record-periods"]' });
	await saveSettings(page);

	await page.reload();
	await expect(page.getByTestId('rain-defaults').locator(':scope > summary')).toContainText('1 unreliable period');
	await openFold(page, 'rain-defaults');
	const saved = page.getByRole('group', { name: /^Unreliable periods of a rain record/ }).getByTestId('rain-record');
	await expect(saved.getByLabel('From', { exact: true })).toHaveValue('10 Dec 2021');
	await expect(saved.getByLabel('To', { exact: true })).toHaveValue('20 Dec 2021');
	// Removing it empties the setting again.
	await saved.getByRole('button', { name: 'Remove unreliable period 1 of Rainfall — catchment' }).click();
	await saveSettings(page);
	const res = await page.request.get(`${API_URL}/projects/${project.id}`);
	expect(((await res.json()) as { project: { settings: { rainStations?: unknown } } }).project.settings.rainStations ?? null).toBeNull();
});
