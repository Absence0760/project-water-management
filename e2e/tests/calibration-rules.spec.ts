// Automated calibration under pre-declared rules, run by the server (issue
// #153): the rules are saved before any fit is seen, the server fits them one
// background job per fit (run here by the job tick), and applying the kept
// fit is the server's too, saved with a record of how the rules chose it.
import { addMember, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { anySaveBar, saveSettings } from '../support/settings.ts';
import { runJobsTick } from '../support/jobs.ts';
import { projectDay } from '../support/dates.ts';

test('the saved rules pick the fit on the server: a rule change needs saving first, and the kept fit is applied with its rules', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Calibration rules');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=settings`);

	const rules = page.getByTestId('calibration-rules');
	await expect(rules.getByTestId('rules-status')).toContainText('Revision 1 · draft, not signed off by the hydrologist');
	await expect(rules.getByTestId('rules-fits')).toContainText('2 fits, each with the split-sample and dry → wet tests (at most 8).');

	const auto = page.getByRole('region', { name: /^Automated calibration/ });
	await expect(auto.getByText('These rules are drafts until the hydrologist signs them off')).toBeVisible();
	// The search is part of the rules: a smaller one is a rule change, saved first.
	await rules.getByLabel('Model runs per fit').fill('50');
	await rules.getByLabel('Starts per fit').fill('1');
	await rules.getByLabel('After a kept fit is applied, run the model and the uncertainty ensemble around it').uncheck();
	await expect(auto.getByTestId('auto-rules-unsaved')).toBeVisible();
	await expect(auto.getByRole('button', { name: 'Run the calibration rules' })).toBeDisabled();
	await saveSettings(page);
	await expect(rules.getByTestId('rules-status')).toContainText('Revision 2');
	await expect(auto.getByTestId('auto-rules')).toContainText('seed 1, 1 start per fit, 50 model runs per optimisation');

	await auto.getByRole('button', { name: 'Run the calibration rules' }).click();
	await expect(auto.getByRole('status').filter({ hasText: /^Fitting 1 of 2 on the server/ })).toBeVisible();
	await runJobsTick({ projects: [project.id], schedule: false });

	// 120 days of record: no dry → wet test, so the default rules keep nothing, and say why for each fit.
	const fits = auto.getByRole('table', { name: 'Fits the rules tried' });
	await expect(fits.getByRole('row')).toHaveCount(3);
	await expect(fits.getByRole('cell', { name: 'Not kept', exact: true })).toHaveCount(2);
	await expect(fits.getByText(/the record doesn’t allow the dry → wet test/).first()).toBeVisible();
	await expect(auto.getByText(/No fit passed the rules, so none is kept/)).toBeVisible();
	await expect(auto.getByRole('button', { name: 'Apply and save the kept fit' })).toHaveCount(0);

	// Keep by the split-sample test instead: saved first, then run again.
	await rules.getByLabel('on the held-out test').selectOption({ label: 'split-sample test (other half)' });
	await expect(auto.getByRole('button', { name: 'Run the calibration rules' })).toBeDisabled();
	await saveSettings(page);
	await expect(auto.getByTestId('auto-rules')).toContainText('Revision 3');
	await auto.getByRole('button', { name: 'Run the calibration rules' }).click();
	await expect(auto.getByRole('status').filter({ hasText: /^Fitting 1 of 2 on the server/ })).toBeVisible();
	await runJobsTick({ projects: [project.id], schedule: false });
	await expect(fits.getByRole('cell', { name: 'Kept', exact: true })).toHaveCount(1);

	// An unsaved edit holds Apply back (applying saves at once).
	const applyButton = auto.getByRole('button', { name: 'Apply and save the kept fit' });
	await rules.getByLabel('Seed').fill('2');
	await expect(applyButton).toBeDisabled();
	await expect(auto.getByTestId('auto-apply-hint')).toHaveText('Save the calibration rules first.');
	await rules.getByLabel('Seed').fill('1');
	await expect(applyButton).toBeEnabled();
	await applyButton.click();
	await expect(auto.getByTestId('auto-applied')).toContainText(', with a run');
	// Saved by the server: nothing unsaved in the form.
	await expect(anySaveBar(page)).toHaveCount(0);

	await page.reload();
	const prov = page.getByRole('region', { name: /^Fit record of these parameters/ });
	await expect(prov.getByTestId('fit-auto-badge')).toHaveText('Automated');
	await expect(prov.getByTestId('fit-auto')).toContainText('calibration rules revision 3 (draft, not signed off): kept');
	await expect(prov.getByText(/Automated calibration picked this fit under draft rules/)).toBeVisible();
});

test('a sign-off is a typed signature the server dates, and a viewer can read the rules but not change them', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Calibration rules sign-off');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=settings`);
	const rules = page.getByTestId('calibration-rules');
	const sign = rules.getByRole('button', { name: 'Sign off these rules' });
	await expect(sign).toBeDisabled();
	await rules.getByLabel('Your name, as a signature').fill('A. Hydrologist');
	await sign.click();
	// The server dates the sign-off on the project's calendar (Africa/Johannesburg, a new project's zone), not UTC's.
	// Read either side of the save, in case it straddles the project's midnight.
	const before = projectDay();
	await saveSettings(page);
	const after = projectDay();
	// Signing off changes no rule: the revision stays; the date is the server's.
	await expect(rules.getByTestId('rules-status')).toHaveText(new RegExp(`Signed off\\s*Revision 1 · signed off by A\\. Hydrologist on (${before}|${after})\\s*$`));

	const viewer = await signIn('Rules viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=settings`);
	const seen = viewer.page.getByTestId('calibration-rules');
	await expect(seen.getByTestId('rules-status')).toContainText('signed off by A. Hydrologist');
	await expect(seen.getByLabel('on the held-out test')).toBeDisabled();
	await expect(seen.getByTestId('rules-sign-off')).toHaveCount(0);
	await expect(viewer.page.getByRole('region', { name: /^Automated calibration/ }).getByRole('button', { name: 'Run the calibration rules' })).toHaveCount(0);
});

test('the flagged-days rule: its checkbox sits beside its words, and off and on again keeps the share typed', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Calibration rules share');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=settings`);
	const rules = page.getByTestId('calibration-rules');
	const leaveOut = rules.getByRole('checkbox', { name: 'Leave out a water year by its flagged days' });
	// Not stretched across its field: the box is box-sized and its words start right after it.
	const box = (await leaveOut.boundingBox())!;
	// The words are the label's own text node (no element of their own), so measure them with a range.
	const wordsX = await rules.locator('label.check').filter({ has: page.getByRole('checkbox', { name: 'Leave out a water year by its flagged days' }) }).evaluate((label) => {
		const text = [...label.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes('Leave out a water year by its flagged days'))!;
		const range = document.createRange();
		range.selectNodeContents(text);
		return [...range.getClientRects()].find((r) => r.width > 0)!.x;
	});
	expect(box.width).toBeLessThanOrEqual(24);
	expect(wordsX - (box.x + box.width)).toBeLessThan(12);

	// settled: the rules card is drawn and measured above, and nothing changes the tick since.
	if (!(await leaveOut.isChecked())) await leaveOut.check();
	const share = rules.getByLabel(/^When more than this share of its observed days are flagged/);
	await share.fill('35');
	await share.blur();
	await leaveOut.uncheck();
	await expect(share).toHaveCount(0);
	await leaveOut.check();
	await expect(share).toHaveValue('35');
});

test('a running run of the rules stays with its project: another project never shows it, and its polling stops there', async ({ page, owner }) => {
	void owner;
	const a = await seedRunnableProject(page.request, 'Rules run here');
	const b = await seedRunnableProject(page.request, 'Rules not run here');
	for (const p of [a, b]) await updateSettings(page.request, p.id, { runoffModel: 'gr4j' });
	// Every poll of one run (A's, under any project's address), to show they stop once another project is open.
	const polls: string[] = [];
	page.on('request', (r) => {
		if (r.method() === 'GET' && r.url().includes('/auto-calibrations/')) polls.push(r.url());
	});
	// The page's own clock, so the 1.5 s polls are stepped through rather than waited for.
	await page.clock.install();
	await page.goto(`/projects/${a.id}?tab=settings`);
	const auto = page.getByRole('region', { name: /^Automated calibration/ });
	const sections = page.getByRole('navigation', { name: 'Project sections' });
	const fitting = auto.getByRole('status').filter({ hasText: /^Fitting 1 of 2 on the server/ });
	await auto.getByRole('button', { name: 'Run the calibration rules' }).click();
	await expect(fitting).toBeVisible();
	await page.clock.runFor(1_600);
	await expect.poll(() => polls.length).toBeGreaterThan(0);

	// Through the project list to B: the workspace closes, A's polling ends, and B shows no run.
	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' }).click();
	await page.getByRole('link', { name: 'Rules not run here', exact: true }).click();
	await sections.getByRole('link', { name: 'Settings & calibration', exact: true }).click();
	await expect(auto.getByRole('button', { name: 'Run the calibration rules' })).toBeEnabled();
	const seen = polls.length;
	await page.clock.runFor(6_000);
	await expect(auto.getByTestId('auto-result')).toHaveCount(0);
	await expect(fitting).toHaveCount(0);
	expect(polls.length).toBe(seen);

	// Straight from B back to A (Back, the same workspace page reused): A's run is still followed.
	await page.evaluate(() => history.go(-3));
	await expect(page).toHaveURL(new RegExp(`/projects/${a.id}\\?tab=settings`));
	await expect(fitting).toBeVisible();
	// Hold A's next poll on the wire, then go straight on to B: the reply lands after B is open,
	// the race a slow network makes. Nothing of A's may show on B, and A's polling must end with it.
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	let holding!: () => void;
	const isHeld = new Promise<void>((r) => (holding = r));
	let first = true;
	await page.route(`**/projects/${a.id}/auto-calibrations/*`, async (route) => {
		if (first) {
			first = false;
			holding();
			await held;
		}
		await route.continue();
	});
	await page.clock.runFor(1_600);
	await isHeld;
	const bLoaded = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().endsWith(`/projects/${b.id}/auto-calibrations`));
	await page.evaluate(() => history.go(3));
	await (await bLoaded).finished();
	await expect(page).toHaveURL(new RegExp(`/projects/${b.id}\\?tab=settings`));
	await expect(auto.getByRole('button', { name: 'Run the calibration rules' })).toBeEnabled();
	const seenAgain = polls.length;
	const stale = page.waitForResponse((r) => r.url().includes(`/projects/${a.id}/auto-calibrations/`));
	release();
	await (await stale).finished();
	// Let the page take the reply in before the clock moves on (two round trips to its event loop).
	for (let i = 0; i < 2; i++) await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
	await page.clock.runFor(6_000);
	await expect(auto.getByTestId('auto-result')).toHaveCount(0);
	await expect(fitting).toHaveCount(0);
	await expect(auto.getByRole('alert')).toHaveCount(0);
	expect(polls.length).toBe(seenAgain);
	// One run at a time per person: B says where the running one is, rather than seeming to run here too.
	await auto.getByRole('button', { name: 'Run the calibration rules' }).click();
	await expect(auto.getByRole('alert')).toHaveText(
		'you already have an automated calibration queued or running in the project “Rules run here”, and only one at a time is allowed; wait for it to finish, then start this one'
	);
	await expect(auto.getByTestId('auto-result')).toHaveCount(0);

	// Back on A, the run finishes and shows there.
	await runJobsTick({ projects: [a.id], schedule: false });
	await page.evaluate(() => history.go(-3));
	await expect(page).toHaveURL(new RegExp(`/projects/${a.id}\\?tab=settings`));
	await page.clock.runFor(1_600);
	await expect(auto.getByRole('table', { name: 'Fits the rules tried' })).toBeVisible();
	await expect(fitting).toHaveCount(0);
});
