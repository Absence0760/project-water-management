// The Warnings page's Run warnings (issue #611 slice 5, docs/ui.md §
// Warnings): the shown run's coded warnings, each with a link to the setting
// that changes it (engine warningCodes.ts WARNING_CODES), checks before notes;
// and the way there from Calibration. A project with no flow record: its run
// warns that there is nothing to calibrate against (calibration.noObserved,
// Calibration record) and of its rain's flat stretches (data.flatline, Data
// quality). Synthetic series only.
import { createRun } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { pinClockToProject } from '../support/clock.ts';
import { expect, test } from '../support/fixtures.ts';
import { openWarnings, runWarnings, seedWarnings } from '../support/warnings.ts';

test.use({ timezoneId: 'UTC', viewport: { width: 1440, height: 960 } });

test('each coded run warning links to its setting, checks first, and the link lands on that panel', async ({ page, owner }) => {
	void owner;
	const project = await seedWarnings(page.request, 'Run warnings', { flow: false });
	const run = await createRun(page.request, project.id, 'Without flow');
	await pinClockToProject(page, project.id, 'lastRunAt');
	await openWarnings(page, project.id, '#warn-run');
	const panel = runWarnings(page);
	await expect(panel.getByRole('heading', { name: 'Run warnings' })).toBeFocused();
	await expect(page.getByTestId('warn-run-line')).toContainText('From Without flow, ran today');

	const items = page.getByTestId('warn-run-list').getByRole('listitem');
	const noRecord = items.filter({ hasText: 'No observed flow series: calibration statistics not computed' });
	await expect(noRecord.getByText('Check', { exact: true })).toBeVisible();
	await expect(noRecord.getByRole('link', { name: 'Go to Calibration record' })).toHaveAttribute('href', '?tab=calibration#set-record');
	const flat = items.filter({ hasText: /flat stretches? of/ });
	await expect(flat.getByText('Note', { exact: true })).toBeVisible();
	await expect(flat.getByRole('link', { name: 'Go to Data quality' })).toHaveAttribute('href', '?tab=settings#set-quality');
	// Checks come before notes.
	const texts = await items.allInnerTexts();
	const firstNote = texts.findIndex((t) => t.startsWith('Note'));
	expect(texts.slice(firstNote).every((t) => t.startsWith('Note'))).toBe(true);
	await expectNoViolations(page);

	// Go to the setting: Calibration, its Calibration record panel's heading focused; Back returns here.
	await noRecord.getByRole('link', { name: 'Go to Calibration record' }).click();
	await expect(page).toHaveURL(/[?&]tab=calibration/);
	await expect(page.getByRole('heading', { name: 'Calibration record' })).toBeFocused();
	await page.goBack();
	await expect(page.getByRole('heading', { level: 1, name: 'Warnings' })).toBeVisible();

	// Calibration's shown run has a line on to them.
	await page.goto(`/projects/${project.id}?tab=calibration`);
	const line = page.getByTestId('calibration-to-warnings');
	await expect(line.getByRole('link')).toHaveAttribute('href', `?tab=warnings&run=${run}#warn-run`);
	await line.getByRole('link').click();
	await expect(page.getByRole('heading', { name: 'Run warnings' })).toBeFocused();
});

test('a run with no warnings and a project with no run say so', async ({ page, owner }) => {
	void owner;
	const project = await seedWarnings(page.request, 'No run yet', { flats: 0, flow: false });
	await openWarnings(page, project.id);
	await expect(page.getByTestId('warnings-empty')).toHaveText('No data check flags a period in the loaded series.');
	await expect(page.getByTestId('warn-run-line')).toHaveText('No run yet.');
});
