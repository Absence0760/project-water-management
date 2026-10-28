// The Warnings page's Run warnings (issue #611, docs/ui.md § Warnings): the
// shown run's warnings, checks before notes, each with how to fix it and an
// action (warnings/fixes.ts): a one-value setting saved here that reads
// Fixed until a run confirms it, the exact field (landed on, opened, focused
// and outlined), a page, or this page's data checks; Keep with a note and
// Reopen (settings.warningsKept); the filters across every row in the URL;
// the way there from Calibration. Synthetic series only.
import { addMember, createRun, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { pinClockToProject } from '../support/clock.ts';
import { expect, test } from '../support/fixtures.ts';
import { openWarnings, runWarningRow, runWarnings, savedSettings, seedAccumulation, seedWarnings } from '../support/warnings.ts';

test.use({ timezoneId: 'UTC', viewport: { width: 1440, height: 960 } });

test('each run warning says how to fix it, checks first, and its action goes there', async ({ page, owner }) => {
	void owner;
	const project = await seedWarnings(page.request, 'Run warnings', { flow: false });
	const run = await createRun(page.request, project.id, 'Without flow');
	await pinClockToProject(page, project.id, 'lastRunAt');
	await openWarnings(page, project.id, '#warn-run');
	const panel = runWarnings(page);
	await expect(panel.getByRole('heading', { name: 'Run warnings' })).toBeFocused();
	await expect(page.getByTestId('warn-run-line')).toContainText('From Without flow, ran today');

	const noRecord = runWarningRow(page, 'No observed flow series: calibration statistics not computed');
	await expect(noRecord).toHaveAttribute('data-state', 'open');
	await expect(noRecord.getByText('To check', { exact: true })).toBeVisible();
	await expect(noRecord).toContainText('How to fix: No observed flow record, so the run has no calibration scores.');
	await expect(noRecord.getByRole('link', { name: 'Add data' })).toHaveAttribute('href', '?tab=series&add=data');
	const flat = runWarningRow(page, /flat stretches? of/);
	await expect(flat.getByText('Note', { exact: true })).toBeVisible();
	// Checks come before notes.
	const order = await page.getByTestId('warn-run-list').locator(':scope > li').evaluateAll((els) => els.map((e) => e.classList.contains('note')));
	expect(order).toEqual([...order].sort((x, y) => Number(x) - Number(y)));
	await expectNoViolations(page);

	// A data-check warning is solved period by period: its action filters this page to those periods.
	await flat.getByRole('link', { name: 'Show the periods' }).click();
	await expect(page).toHaveURL(/[?&]source=checks&status=open&check=flatline/);
	await expect(page.getByTestId('warnings-table')).toBeVisible();
	await expect(page.locator('#warn-run')).toHaveCount(0);

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

test.describe('solving a run warning (issue #611)', () => {
	test('an inline fix saves, reads Fixed until Run now, and the new run no longer warns', async ({ page, owner }) => {
		void owner;
		const project = await seedAccumulation(page.request, 'Accumulation as recorded');
		await updateSettings(page.request, project.id, { zeroRainRuns: { accumulationMode: 'asRecorded' } });
		await createRun(page.request, project.id, 'As recorded');
		await pinClockToProject(page, project.id, 'lastRunAt');
		await openWarnings(page, project.id, '&source=run#warn-run');
		const row = runWarningRow(page, /multi-day accumulation run as recorded/);
		await expect(row).toContainText('How to fix: Multi-day accumulations run as one day’s rain');
		await row.getByRole('button', { name: /^Spread accumulations:/ }).click();
		await expect(page.getByTestId('warnings-notice')).toHaveText('Saved: spread accumulations. Run the model to see which warnings remain.');
		expect(((await savedSettings(page.request, project.id)).zeroRainRuns as { accumulationMode: string }).accumulationMode).toBe('spread');
		// It leaves Open; under Fixed or handled it reads Fixed until a run confirms it.
		await expect(row).toHaveCount(0);
		await page.getByTestId('warnings-status').getByRole('link', { name: /^Fixed or handled/ }).click();
		await expect(runWarningRow(page, /multi-day accumulation run as recorded/)).toContainText('Fixed: rerun to confirm');
		const rerun = page.getByTestId('warnings-rerun');
		await expect(rerun).toContainText('1 warning is fixed in the settings since this run');
		await rerun.getByRole('button', { name: 'Run now' }).click();
		// The run opens back here, on its warnings: the fixed one is gone.
		await expect(page).toHaveURL(/[?&]tab=warnings&run=[0-9a-f-]{36}#warn-run$/);
		await expect(page.getByTestId('warn-run-line')).toContainText('From After fixing warnings');
		await expect(page.getByText(/multi-day accumulation run as recorded/)).toHaveCount(0);
	});

	test('a field link lands on its field, opened, focused and outlined', async ({ page, owner }) => {
		void owner;
		const project = await seedAccumulation(page.request, 'Accumulation spread');
		await createRun(page.request, project.id, 'Spread');
		await openWarnings(page, project.id, '&source=run&status=all');
		const row = runWarningRow(page, /accumulations? spread/i);
		const go = row.getByRole('link', { name: 'Go to Keep as recorded' });
		await expect(go).toHaveAttribute('href', '?tab=settings&field=fld-keep-readings');
		await go.click();
		await expect(page.getByRole('heading', { level: 1, name: 'Model settings' })).toBeVisible();
		// Inside the Rain gaps fold, which opens for it; its first control has the focus; the parameter is dropped.
		const field = page.locator('#fld-keep-readings');
		await expect(field).toBeInViewport();
		await expect(field).toHaveAttribute('data-field-landed', '');
		await expect(field.locator('button').first()).toBeFocused();
		await expect(page).not.toHaveURL(/field=/);
	});

	test('Keep takes an optional note, shows under Kept with it, and Reopen brings it back; a viewer reads it without buttons', async ({ page, owner, signIn }) => {
		void owner;
		const project = await seedWarnings(page.request, 'Keep a run warning', { flow: false });
		await createRun(page.request, project.id, 'Without flow');
		await openWarnings(page, project.id, '&source=run');
		const row = runWarningRow(page, 'No observed flow series');
		await expect(row.getByRole('link', { name: 'Add data' })).toHaveAttribute('href', '?tab=series&add=data');
		await row.getByRole('button', { name: /^Keep:/ }).click();
		const dialog = page.getByRole('dialog', { name: 'Keep this warning' });
		await dialog.getByLabel('Why (optional)').fill('No gauge in this catchment yet');
		await dialog.getByRole('button', { name: 'Keep', exact: true }).click();
		await expect(page.getByTestId('warnings-notice')).toHaveText('Kept it. Run the model to see which warnings remain.');
		const kept = (await savedSettings(page.request, project.id)).warningsKept as { id: string; note: string }[];
		expect(kept).toEqual([{ id: expect.stringMatching(/^run:calibration\.noObserved:[0-9a-f]{8}$/), note: 'No gauge in this catchment yet' }]);
		await expect(row).toHaveCount(0);

		await page.getByTestId('warnings-status').getByRole('link', { name: /^Kept/ }).click();
		await expect(page).toHaveURL(/[?&]status=kept/);
		await expect(runWarningRow(page, 'No observed flow series')).toContainText('Kept No gauge in this catchment yet');
		await expectNoViolations(page);

		// A viewer: the row and its note, no ticks, Keep or Reopen.
		const viewer = await signIn('Kept warnings viewer');
		await addMember(page.request, project.id, viewer.user.email, 'viewer');
		await openWarnings(viewer.page, project.id, '&source=run&status=kept');
		const seen = runWarningRow(viewer.page, 'No observed flow series');
		await expect(seen).toContainText('No gauge in this catchment yet');
		await expect(seen.getByRole('button')).toHaveCount(0);
		await expect(seen.getByRole('checkbox')).toHaveCount(0);

		await runWarningRow(page, 'No observed flow series').getByRole('button', { name: /^Reopen:/ }).click();
		await expect(page.getByTestId('warnings-notice')).toHaveText('Reopened it. Run the model to see which warnings remain.');
		expect((await savedSettings(page.request, project.id)).warningsKept ?? null).toBeNull();
	});

	test('the filters cover every row and live in the URL: area, severity, search', async ({ page, owner }) => {
		void owner;
		const project = await seedWarnings(page.request, 'Filters everywhere', { flow: false });
		await createRun(page.request, project.id, 'Without flow');
		await openWarnings(page, project.id);
		await page.getByTestId('warnings-area').getByRole('link', { name: /^Calibration \d+$/ }).click();
		await expect(page).toHaveURL(/[?&]area=calibration/);
		await expect(runWarningRow(page, 'No observed flow series')).toBeVisible();
		await expect(page.getByTestId('warnings-table')).toHaveCount(0);
		await page.getByTestId('warnings-severity').getByRole('link', { name: /^Notes/ }).click();
		await expect(page).toHaveURL(/[?&]sev=note/);
		await expect(runWarningRow(page, 'No observed flow series')).toHaveCount(0);
		await page.goBack();
		await page.goBack();
		await expect(page).not.toHaveURL(/area=/);
		await page.getByTestId('warnings-search').fill('observed flow');
		await expect(page).toHaveURL(/[?&]q=observed\+flow/);
		await expect(runWarningRow(page, 'No observed flow series')).toBeVisible();
		await expect(page.getByTestId('warnings-table')).toHaveCount(0);
		await page.goBack();
		await expect(page).not.toHaveURL(/q=/);
		await expect(page.getByTestId('warnings-table')).toBeVisible();
	});
});
