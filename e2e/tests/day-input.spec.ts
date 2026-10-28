// The shared day field (common/DayInput.svelte, issue #521; ui-playbook § 2 "A typed date is day first too"):
// every date in the app is typed day first or ISO, never through <input type="date">, whose order is the
// browser's own. Typed text reads with parseDay and shows back as "15 Nov 2021"; the value saved stays
// YYYY-MM-DD. Text it can't read is kept with a message at the field, counts in the save bar's list of
// problems (as a number field that needs fixing does), and a form that validates refuses to submit it.
// The other forms that use it are covered by their own specs (settings, dam-development, report-window,
// licence-record, applications, publication, unit-rain, …).
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, createRun, nominateRun, seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { anySaveBar, saveSettings } from '../support/settings.ts';

const MESSAGE = 'Enter a day, day first: 15 Nov 2021, 15/11/2021 or 2021-11-15';

test('a typed day reads day first or ISO, shows back day first and saves as YYYY-MM-DD; text it can’t read is a problem in the save bar', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Typed days');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const start = page.getByLabel('Simulation start');
	const end = page.getByLabel('Simulation end');
	await expect(start).toHaveAttribute('type', 'text');
	// Blank runs over the whole rain record, and the blank fields say so (a bare example day read as a stored period).
	await expect(start).toHaveAttribute('placeholder', 'First day with rain');
	await expect(end).toHaveAttribute('placeholder', 'Last day with rain');

	// Text that isn't a day: kept after leaving the field, marked, with its message at the field.
	await start.fill('soon');
	await start.blur();
	await expect(start).toHaveValue('soon');
	await expect(start).toHaveAttribute('aria-invalid', 'true');
	await expect(start).toHaveAccessibleDescription(MESSAGE);
	// The save bar lists it, and its link puts the cursor back in the field.
	const link = anySaveBar(page).getByRole('link', { name: `Simulation start: ${MESSAGE}` });
	await expect(link).toBeVisible();
	await expectNoViolations(page, { include: '#st-start' });
	await link.click();
	await expect(start).toBeFocused();

	// Day first and ISO both read; once left, each shows day first.
	await start.fill('15/11/2021');
	await expect(start).not.toHaveAttribute('aria-invalid', 'true');
	await expect(link).toHaveCount(0);
	await start.blur();
	await expect(start).toHaveValue('15 Nov 2021');
	await end.fill('2022-09-30');
	await end.blur();
	await expect(end).toHaveValue('30 Sep 2022');
	await saveSettings(page);
	const saved = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()) as { project: { settings: { simulationStart: string | null; simulationEnd: string | null } } };
	expect([saved.project.settings.simulationStart, saved.project.settings.simulationEnd]).toEqual(['2021-11-15', '2022-09-30']);
	await page.reload();
	await expect(start).toHaveValue('15 Nov 2021');

	// Discard puts a field that needs fixing back to its saved day.
	await start.fill('31/02/2022');
	await start.blur();
	await expect(start).toHaveAttribute('aria-invalid', 'true');
	await anySaveBar(page).getByRole('button', { name: 'Discard', exact: true }).click();
	await answerConfirm(page, true);
	await expect(start).toHaveValue('15 Nov 2021');
	await expect(start).not.toHaveAttribute('aria-invalid', 'true');

	// No sideways scroll on a phone with the fields in place.
	for (const width of [320, 390]) {
		await page.setViewportSize({ width, height: 800 });
		await expectNoSidewaysScroll(page);
	}
});

test('a form refuses to submit a day it can’t read', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Typed days form');
	const run = await createRun(page.request, project.id, 'Baseline');
	await nominateRun(page.request, project.id, run, 'Evidence for the typed days test');
	await page.goto(`/projects/${project.id}?tab=project`);
	const form = page.getByTestId('licence-record').getByRole('form', { name: 'Record the licence outcome' });
	await form.getByLabel('Outcome').selectOption('licence_refused');
	const on = form.getByLabel('Decided on');
	// A day, then text that isn't one: the day typed before must not go out behind the person's back.
	await on.fill('1/3/2026');
	await on.fill('the first of March');
	await form.getByLabel('Why').fill('Invented decision letter 2');
	let posted = false;
	page.on('request', (r) => {
		if (r.method() !== 'GET' && r.url().includes('/licence-record')) posted = true;
	});
	await form.getByRole('button', { name: 'Save the outcome' }).click();
	// The browser's own validation stops the submit at the field.
	await expect(on).toBeFocused();
	await expect(on).toHaveAttribute('aria-invalid', 'true');
	expect(await on.evaluate((el: HTMLInputElement) => el.validationMessage)).toBe(MESSAGE);
	expect(posted).toBe(false);
	// A day it reads (day first) submits, as YYYY-MM-DD.
	await on.fill('1 March 2026');
	await form.getByRole('button', { name: 'Save the outcome' }).click();
	await expect(page.getByTestId('licence-record').getByTestId('licence-record-status')).toHaveText('Licence refused on 1 Mar 2026. The record is kept until 1 Mar 2029.');
});

// A field's error line never moves its row (issue #521, round 6; app.css, after .form-row): rows align their fields
// to the bottom, so an error under one field used to push its neighbours down by the error's height.
test('a day field showing its error leaves its neighbour’s input where it was', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const project = await createProject(page.request, 'Errors in a row');
	await page.goto(`/projects/${project.id}?tab=settings`);
	await expectRowStays(page, page.getByLabel('Simulation start'), page.getByLabel('Simulation end'), 'soon');
	// The error lines wrap inside their fields on a phone.
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await expect(page.locator('#st-start-err')).toBeVisible();
		await expectNoSidewaysScroll(page);
	}
});

// The same for a number field (a NumberInput's own range error). The Hi/Lo MAP split's High and Low were the pair until
// engine 1.105.0 retired it (issue #616); the WR2012 reference's period is a number pair in one row.
test('a number field showing its error leaves its neighbour’s input where it was', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const project = await seedRunnableProject(page.request, 'Number errors in a row');
	await page.goto(`/projects/${project.id}?tab=calibration`);
	const wr = page.getByRole('region', { name: /^WR2012 check/ });
	await wr.getByLabel('Compare runs with WR2012 naturalised flow').check();
	await expectRowStays(page, wr.getByLabel('From', { exact: true }), wr.getByLabel('To', { exact: true }), '1500');
});

/** `field` and `neighbour` side by side in one row; `text` makes `field` show its error, which moves neither input. */
async function expectRowStays(page: Page, field: Locator, neighbour: Locator, text: string): Promise<void> {
	await neighbour.scrollIntoViewIfNeeded();
	const before = (await neighbour.boundingBox())!;
	// Side by side in one row at 1440.
	expect(Math.round((await field.boundingBox())!.y)).toBe(Math.round(before.y));
	await field.fill(text);
	await field.blur();
	await expect(field).toHaveAttribute('aria-invalid', 'true');
	const err = page.locator(`#${await field.getAttribute('id')}-err`);
	await expect(err).toBeVisible();
	const after = (await neighbour.boundingBox())!;
	expect(after.y).toBeCloseTo(before.y, 0);
	expect(after.x).toBeCloseTo(before.x, 0);
	// The field's own input stays level with it too.
	expect((await field.boundingBox())!.y).toBeCloseTo(before.y, 0);
}
