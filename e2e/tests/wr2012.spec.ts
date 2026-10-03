// The optional WR2012 check (issue #4 phase 8): enter a quaternary's
// naturalised flow in Settings (with its plausibility checks), run the model,
// read the report on Runs & results, and see it in run comparison.
// The reference is synthetic: an invented quaternary and round numbers.
import { copyProject, createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveChanges, saveSettings } from '../support/settings.ts';
import { whatChanged } from '../support/compare.ts';
import { answerConfirm } from '../support/confirm.ts';

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

test('entering WR2012 data is checked for plausibility, saved, and every run reports against it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'WR2012 check');
	await page.goto(`/projects/${project.id}?tab=settings`);

	const section = page.getByRole('region', { name: /^WR2012 check/ });
	const save = saveChanges(page);
	await expect(section.getByLabel(/^Quaternary catchment/)).toHaveCount(0);
	await section.getByLabel('Compare runs with WR2012 naturalised flow').check();

	// A new reference needs every field before it can be saved.
	await expect(section.getByText('Enter the quaternary area.')).toBeVisible();
	await expect(save).toBeDisabled();
	await expectNoViolations(page);

	await section.getByLabel(/^Quaternary catchment/).fill('Z99A');
	await section.getByLabel(/^Quaternary area/).fill('50');
	await section.getByLabel(/^Naturalised MAR/).fill('1200');
	await section.getByLabel('From', { exact: true }).fill('1990');
	await section.getByLabel('To', { exact: true }).fill('2025');
	await section.getByLabel('Source').fill('Synthetic reference for tests');
	// Monthly means typed as if they were m³/s: they don't add up to the MAR.
	for (const m of MONTHS) await section.getByLabel(`WR2012 monthly mean, ${m}, Mm³`).fill('10');
	const sumMessage = 'The monthly means add up to 120 Mm³, more than 5 % away from the MAR (1\u202f200 Mm³/a).';
	await expect(section.getByText(sumMessage)).toBeVisible();
	// Each month's field is described by it, and marked.
	await expect(section.getByLabel('WR2012 monthly mean, Jan, Mm³')).toHaveAccessibleDescription(sumMessage);
	await expect(section.getByLabel('WR2012 monthly mean, Jan, Mm³')).toHaveAttribute('aria-invalid', 'true');
	await expect(save).toBeDisabled();
	for (const m of MONTHS) await section.getByLabel(`WR2012 monthly mean, ${m}, Mm³`).fill('100');
	await expect(section.getByText(/^The monthly means add up to/)).toHaveCount(0);
	await expect(section.getByRole('cell', { name: '1\u202f200.000' })).toBeVisible(); // the sum

	// A MAR larger than the rain on the quaternary: 100 mm × 50 km² = 5 Mm³/a.
	const map = section.getByLabel(/^Quaternary MAP/);
	await map.fill('100');
	await expect(section.getByText(/The MAR \(1\u202f200 Mm³\/a\) is more than the rain on the quaternary \(100 mm × 50 km² = 5 Mm³\/a\)\./)).toBeVisible();
	await expect(save).toBeDisabled();
	await map.fill('');

	// The MAR band (issue #4 phase 6): both bounds or neither, low ≤ high.
	await section.getByLabel('Add a soft penalty on the MAR when fitting automatically').check();
	await section.getByLabel('Use a MAR band instead of one target').check();
	// Both blank is still valid (no band, a single target): only a nudge, Save stays enabled.
	await expect(section.getByText('Enter both bounds, or untick')).toBeVisible();
	await expect(save).toBeEnabled();
	await section.getByLabel(/^Band low/).fill('20');
	await expect(section.getByText('Enter both a low and high bound for the MAR band, or leave both blank.')).toBeVisible();
	await expect(save).toBeDisabled();
	await section.getByLabel(/^Band high/).fill('10');
	await expect(section.getByText('The MAR band’s low bound can’t be above its high bound.')).toBeVisible();
	await expect(save).toBeDisabled();
	await section.getByLabel(/^Band high/).fill('30');
	await expect(section.getByText('The MAR band’s low bound can’t be above its high bound.')).toHaveCount(0);

	await expect(save).toBeEnabled();
	await saveSettings(page);

	await page.reload();
	await expect(section.getByLabel(/^Quaternary catchment/)).toHaveValue('Z99A');
	await expect(section.getByLabel(/^Naturalised MAR/)).toHaveValue('1200');
	await expect(section.getByLabel('WR2012 monthly mean, Jul, Mm³')).toHaveValue('100');
	await expect(section.getByLabel('Scale the reference by')).toHaveValue('area');
	await expect(section.getByLabel(/^Band low/)).toHaveValue('20');
	await expect(section.getByLabel(/^Band high/)).toHaveValue('30');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('With WR2012');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'With WR2012' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'WR2012 check' })).toBeVisible();

	const report = page.getByRole('region', { name: /^WR2012 check: Z99A/ });
	// The sample network's farms cover 20 km² of the 50 km² quaternary.
	await expect(report.getByText(/Area ratio: 20 km² ÷ 50 km² = 0\.4\./)).toBeVisible();
	// The synthetic catchment is far drier than a 1 200 Mm³/a reference: not usable.
	const flag = report.getByRole('status').filter({ hasText: 'Not usable for EWR findings' });
	await expect(flag).toContainText("Don't use this run for EWR findings until the difference is explained.");
	const mar = report.getByRole('table', { name: 'Mean annual runoff, simulated natural ÷ scaled WR2012' });
	await expect(mar.getByRole('rowheader', { name: /^Whole run/ })).toBeVisible();
	// 120 days of record: no complete water year overlaps the reference period.
	await expect(mar.getByText('no complete water year inside the reference period')).toBeVisible();
	const monthly = report.getByRole('table', { name: /^Monthly means over the whole run/ });
	for (const row of ['Simulated', 'WR2012 (scaled)', 'Ratio']) await expect(monthly.getByRole('rowheader', { name: row, exact: true })).toBeVisible();
	await expect(monthly.getByText('dry').first()).toBeVisible();
	await expect(report.getByText('Monthly pattern correlation')).toBeVisible();
	await expectNoViolations(page);
	// The same plain-language flag is a run warning.
	await expect(page.getByRole('status').filter({ hasText: /to check before relying on this run/ })).toContainText('WR2012 naturalised MAR for Z99A');
});

test('run comparison lists the WR2012 inputs that changed and compares the ratios', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'WR2012 baseline');
	const before = await createRun(page.request, project.id, 'No reference');
	const copy = await copyProject(page.request, project.id, 'WR2012 copy');
	const monthlyMm3 = new Array(12).fill(0.5);
	await updateSettings(page.request, copy, {
		wr2012: {
			reference: { quaternary: 'Z99A', areaKm2: 60, marMm3: 6, monthlyMm3, periodStart: 1990, periodEnd: 2025, mapMm: null, source: 'Synthetic' },
			calibrationPenalty: { enabled: true, weight: 1, marLowMm3: null, marHighMm3: null }
		}
	});
	const after = await createRun(page.request, copy, 'With reference');

	await page.goto(`/compare?a=${project.id}:${before}&b=${copy}:${after}`);
	await expect(page.getByRole('heading', { name: 'Headline results' })).toBeVisible();
	await expect(whatChanged(page).getByText('WR2012 reference added (Z99A, MAR 6 Mm³/a over 60 km², 1990/91 – 2025/26)')).toBeVisible();
	await expect(whatChanged(page).getByText('WR2012 calibration penalty: off → on')).toBeVisible();
	await expect(page.getByRole('heading', { name: /^WR2012 check/ })).toBeVisible();
	const table = page.getByRole('table', { name: 'WR2012 check for both runs' });
	await expect(table.getByRole('rowheader', { name: 'MAR ratio, whole run' })).toBeVisible();
	await expect(table.getByRole('rowheader', { name: 'Monthly pattern correlation' })).toBeVisible();
});

test('unticking the check or the MAR band and ticking it again keeps what was typed, until saved or discarded', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'WR2012 keep');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const section = page.getByRole('region', { name: /^WR2012 check/ });
	const on = section.getByLabel('Compare runs with WR2012 naturalised flow');
	await on.check();
	await section.getByLabel(/^Quaternary catchment/).fill('Z99A');
	await section.getByLabel(/^Quaternary area/).fill('50');
	await section.getByLabel('WR2012 monthly mean, Mar, Mm³').fill('7');
	await section.getByLabel('Add a soft penalty on the MAR when fitting automatically').check();
	await section.getByLabel('Use a MAR band instead of one target').check();
	await section.getByLabel(/^Band low/).fill('20');
	await section.getByLabel(/^Band high/).fill('30');

	// The band, off and on again: its bounds come back.
	await section.getByLabel('Use a MAR band instead of one target').uncheck();
	await section.getByLabel('Use a MAR band instead of one target').check();
	await expect(section.getByLabel(/^Band low/)).toHaveValue('20');
	await expect(section.getByLabel(/^Band high/)).toHaveValue('30');
	// The check, off and on again: the reference and the penalty come back.
	await on.uncheck();
	await expect(section.getByLabel(/^Quaternary catchment/)).toHaveCount(0);
	await on.check();
	await expect(section.getByLabel(/^Quaternary catchment/)).toHaveValue('Z99A');
	await expect(section.getByLabel(/^Quaternary area/)).toHaveValue('50');
	await expect(section.getByLabel('WR2012 monthly mean, Mar, Mm³')).toHaveValue('7');
	await expect(section.getByLabel('Add a soft penalty on the MAR when fitting automatically')).toBeChecked();
	// Another tab and back keeps the unsaved form too (the page holds it).
	await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Network', exact: true }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Network' })).toBeVisible();
	await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Settings & calibration', exact: true }).click();
	await expect(section.getByLabel(/^Quaternary catchment/)).toHaveValue('Z99A');

	// Discard forgets what was kept: ticked again, the reference starts blank.
	await page.getByRole('region', { name: /^Unsaved / }).getByRole('button', { name: 'Discard', exact: true }).click();
	await answerConfirm(page, true);
	await on.check();
	await expect(section.getByLabel(/^Quaternary catchment/)).toHaveValue('');
});

test('Propose from the map can be closed again', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'WR2012 propose close');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const section = page.getByRole('region', { name: /^WR2012 check/ });
	await section.getByLabel('Compare runs with WR2012 naturalised flow').check();
	await section.getByRole('button', { name: 'Propose from the map' }).click();
	await section.getByRole('button', { name: 'Close the proposal' }).click();
	await expect(section.getByRole('button', { name: 'Close the proposal' })).toHaveCount(0);
	await expect(section.getByRole('button', { name: 'Propose from the map' })).toBeFocused();
});
