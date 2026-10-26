// The journeys the Calibration page exists for (issue #586 Round 3, docs/ui.md § Calibration): the calibration loop
// on one page (fit, save with an edit on Model settings, run from the header, read the new run's fit here), the one
// save bar across Model settings and Calibration as a person moves between them (history included) and the leave
// guard only when leaving the project, old links that land on the moved panels (the ones calibration-forwards.spec.ts
// doesn't pin: an old Runs link with no run, a note's link), and a viewer reading the fit with no fit controls. The
// single pins (each panel, each anchor, each forward, the blockers' links) are calibration-page, calibration-results,
// calibration-forwards and settings-layout-pins.spec.ts'. Synthetic data only.
import type { Page } from '@playwright/test';
import { addMember, createProject, createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { answerConfirm, confirmBox } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { ungroup } from '../support/format.ts';
import { calibrationRunPicker } from '../support/runs.ts';
import { sectionHeader } from '../support/sectionHeader.ts';
import { anySaveBar, isProjectPatch, openCalibration, openFold, settingsBar } from '../support/settings.ts';

test.use({ viewport: { width: 1440, height: 960 } });

const sections = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const calTitle = (page: Page) => page.getByRole('heading', { level: 1, name: 'Calibration', exact: true });
const settingsTitle = (page: Page) => page.getByRole('heading', { level: 1, name: 'Model settings', exact: true });
const results = (page: Page) => page.getByTestId('calibration-results');
/** Where the shown run's parameters came from, under Calibration against observed flow. */
const provenance = (page: Page) => page.locator('#res-calibration').getByRole('region', { name: /^Where the parameters came from/ });
const x1Field = (page: Page) => page.locator('#set-flow').getByLabel(/^Production store capacity X1/);
const apanOct = (page: Page) => page.locator('#set-demand').getByLabel('A-pan evaporation, Oct, mm');
const projectsLink = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' });

async function savedSettings(page: Page, projectId: string) {
	const res = await page.request.get(`${API_URL}/projects/${projectId}`);
	return ((await res.json()) as { project: { settings: { apanMm: number[]; gr4j: { x1: number }; fitRecord?: { auto?: unknown } | null } } }).project.settings;
}

test('the calibration loop on one page: fit, an edit on Model settings, one save, run from the header, the new run’s fit read here', async ({ page, owner }) => {
	void owner;
	test.setTimeout(120_000); // a fit in the browser and a run
	const project = await seedRunnableProject(page.request, 'Calibration loop');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	const before = await createRun(page.request, project.id, 'Before the fit');

	// The page shows the run there is, fitted by hand: no fit record.
	await openCalibration(page, project.id);
	await expect(results(page)).toHaveAttribute('data-run', before);
	await expect(provenance(page)).toContainText('No fit record: this run’s parameters were set by hand');
	await expect(anySaveBar(page)).toHaveCount(0);

	// Fit automatically, small enough to finish quickly on the synthetic record, then Apply to form: unsaved.
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await openFold(fit, 'fit-search');
	await fit.getByLabel('Model runs per fit').fill('60');
	await fit.getByLabel('Starts').fill('3');
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();
	const params = fit.getByRole('table', { name: 'Parameters', exact: true });
	await expect(params).toBeVisible();
	const fitted = ungroup((await params.getByRole('row', { name: /^Production store capacity X1/ }).getByRole('cell').nth(1).textContent())!);
	await fit.getByRole('button', { name: 'Apply to form' }).click();
	await expect(x1Field(page)).not.toHaveValue('350');
	const applied = ungroup(await x1Field(page).inputValue());
	expect(applied).toBeCloseTo(fitted, -1);
	await expect(settingsBar(page)).toContainText('Unsaved changes to the settings');

	// Model settings, from the sidebar: no question, the same bar; an edit there joins the draft.
	await sections(page).getByRole('link', { name: 'Model settings', exact: true }).click();
	await expect(settingsTitle(page)).toBeVisible();
	await expect(confirmBox(page)).toBeHidden();
	await expect(settingsBar(page)).toContainText('Unsaved changes to the settings');
	await apanOct(page).fill('152');
	await apanOct(page).blur();
	await expect(anySaveBar(page)).toHaveCount(1);

	// Back on Calibration, the fit is still in the form, under the one bar.
	await sections(page).getByRole('link', { name: 'Calibration', exact: true }).click();
	await expect(calTitle(page)).toBeVisible();
	await expect(confirmBox(page)).toBeHidden();
	expect(ungroup(await x1Field(page).inputValue())).toBe(applied);
	await expect(anySaveBar(page)).toHaveCount(1);

	// Run model from the header: it asks to save both edits first, in one request, then runs.
	const patches: string[] = [];
	page.on('request', (r) => {
		if (isProjectPatch(r.method(), r.url())) patches.push(r.postData() ?? '');
	});
	await sectionHeader(page).getByTestId('header-run').click();
	const form = page.getByRole('dialog', { name: 'Run the model' });
	await expect(form.getByRole('status')).toHaveText(/^You have unsaved changes: Run model asks to save them first/);
	await form.getByLabel(/^Run label/).fill('After the fit');
	const ran = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/projects/${project.id}/runs`));
	await form.getByRole('button', { name: 'Run model' }).click();
	await answerConfirm(page, true, 'A run uses the saved model.');
	const res = await ran;
	expect(res.status()).toBeLessThan(300);
	const after = ((await res.json()) as { run: { id: string } }).run.id;
	expect(patches).toHaveLength(1);
	await expect(anySaveBar(page)).toHaveCount(0);
	const saved = await savedSettings(page, project.id);
	expect(saved.apanMm[0]).toBe(152);
	expect(saved.gr4j.x1).toBeCloseTo(applied, 0);

	// The run opens here, on How the shown run fits, focused: the picker follows it and its fit is the one applied.
	await expect(page).toHaveURL(new RegExp(`\\?tab=calibration&run=${after}#cal-fit$`));
	await expect(calTitle(page)).toBeVisible();
	await expect(page.locator('#cal-fit').getByRole('heading', { level: 2, name: 'How the shown run fits' })).toBeFocused();
	await expect(calibrationRunPicker(page).locator('option:checked')).toHaveText(/^After the fit · .* · latest$/);
	await expect(results(page)).toHaveAttribute('data-run', after);
	// The fit applied is the new run's record; the A-pan edit on Model settings after it is the forcing it flags.
	await expect(provenance(page).locator('strong').first()).toHaveText(/^GR4J fit of /);
	await expect(provenance(page).getByText('Forcing changed since fit', { exact: true })).toBeVisible();
	await expect(page.locator('#res-hydrograph').getByRole('heading', { name: 'Hydrograph' })).toBeVisible();
	// The header's run form says so on this page.
	await sectionHeader(page).getByTestId('header-run').click();
	await expect(form.getByRole('status')).toHaveText(/^Runs the saved network, crops, transfers, settings and time series, and shows its fit below\.$/);
	await page.keyboard.press('Escape');
	await expect(form).toBeHidden();

	// The run before, picked, still reads as set by hand; Back returns to the new one.
	await calibrationRunPicker(page).selectOption(before);
	await expect(results(page)).toHaveAttribute('data-run', before);
	await expect(provenance(page)).toContainText('No fit record');
	await page.goBack();
	await expect(results(page)).toHaveAttribute('data-run', after);
	await expect(provenance(page).locator('strong').first()).toHaveText(/^GR4J fit of /);
});

test('the save bar goes along between the two pages, Back and Forward included, its problems linked across; Discard restores both; leaving the project asks', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Calibration bar journey');
	await openCalibration(page, project.id);
	const pe = page.locator('#set-flow').getByRole('radio', { name: 'Monthly PE, entered directly' });
	await expect(pe).not.toBeChecked();

	// A Save blocker on Calibration: a monthly PE row with no source.
	await pe.check();
	await expect(settingsBar(page).getByRole('link', { name: /^Flow calibration:/ })).toHaveAttribute('href', '#set-flow');
	await expect(settingsBar(page).getByRole('button', { name: 'Save changes' })).toBeDisabled();

	// Model settings: no question; the blocker is listed there too, linked to its panel on Calibration. An edit joins.
	await sections(page).getByRole('link', { name: 'Model settings', exact: true }).click();
	await expect(settingsTitle(page)).toBeVisible();
	await expect(confirmBox(page)).toBeHidden();
	const toFlow = settingsBar(page).getByRole('link', { name: /^Flow calibration:/ });
	await expect(toFlow).toHaveAttribute('href', '?tab=calibration#set-flow');
	await apanOct(page).fill('152');
	await apanOct(page).blur();

	// Back and Forward between the two pages ask nothing and keep both.
	await page.goBack();
	await expect(calTitle(page)).toBeVisible();
	await expect(confirmBox(page)).toBeHidden();
	await expect(pe).toBeChecked();
	await page.goForward();
	await expect(settingsTitle(page)).toBeVisible();
	await expect(confirmBox(page)).toBeHidden();
	await expect(apanOct(page)).toHaveValue('152');

	// The blocker's link lands on its panel on Calibration, focused.
	await toFlow.click();
	await expect(page).toHaveURL(/\?tab=calibration#set-flow$/);
	await expect(confirmBox(page)).toBeHidden();
	const flowHeading = page.locator('#set-flow').locator('h2, h3').first();
	await expect(flowHeading).toBeFocused();
	await expect(flowHeading).toBeInViewport();

	// Leaving the project asks, naming the settings; Stay keeps the page and the edits.
	await projectsLink(page).click();
	await answerConfirm(page, false, 'You have unsaved changes (settings). Leave and go to All projects?');
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=calibration`));
	await expect(pe).toBeChecked();

	// Discard (from Calibration) restores both pages' edits.
	await settingsBar(page).getByRole('button', { name: 'Discard', exact: true }).click();
	await answerConfirm(page, true, 'Your unsaved changes to the settings will be lost.');
	await expect(anySaveBar(page)).toHaveCount(0);
	await expect(pe).not.toBeChecked();
	await sections(page).getByRole('link', { name: 'Model settings', exact: true }).click();
	await expect(apanOct(page)).toHaveValue('0');

	// With nothing unsaved, leaving asks nothing.
	await projectsLink(page).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(confirmBox(page)).toBeHidden();
	const saved = await savedSettings(page, project.id);
	expect(saved.apanMm[0]).toBe(0);
});

test('old links land on the moved panels: a Runs link with no run, on a project with runs and with none; a note on the fit', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Calibration old links');
	await createRun(page.request, project.id, 'Older run');
	const newest = await createRun(page.request, project.id, 'Newest run');
	const summary = page.getByRole('heading', { level: 1, name: 'Summary', exact: true });

	// A bookmark of the hydrograph from before the move, with no run: Calibration, the newest run, its heading focused.
	await page.goto(`/projects/${project.id}`);
	await expect(summary).toBeVisible();
	await page.goto(`/projects/${project.id}?tab=runs#res-hydrograph`);
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=calibration#res-hydrograph$`));
	await expect(calTitle(page)).toBeVisible();
	await expect(results(page)).toHaveAttribute('data-run', newest);
	const hydro = page.locator('#res-hydrograph').getByRole('heading', { name: 'Hydrograph' });
	await expect(hydro).toBeFocused();
	await expect(hydro).toBeInViewport();
	// Back skips the old address.
	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
	await expect(summary).toBeVisible();

	// The same on a project with no run: How the shown run fits takes it, saying what it will show.
	const empty = await createProject(page.request, 'Calibration old links no run');
	await page.goto(`/projects/${empty.id}`);
	await expect(summary).toBeVisible();
	await page.goto(`/projects/${empty.id}?tab=runs#res-calibration`);
	await expect(page).toHaveURL(new RegExp(`/projects/${empty.id}\\?tab=calibration#res-calibration$`));
	await expect(page.locator('#cal-fit').getByRole('heading', { level: 2, name: 'How the shown run fits' })).toBeFocused();
	await expect(page.getByTestId('calibration-no-run')).toBeVisible();

	// A note on Fit the parameters, from the Project page's recent notes: Calibration's panel, focused; Back returns.
	expect((await page.request.post(`${API_URL}/projects/${project.id}/notes`, { data: { body: 'Refit after the 2022 floods', visibility: 'team', settingKey: 'fit' } })).status()).toBe(201);
	await page.goto(`/projects/${project.id}?tab=project`);
	const recent = page.getByRole('region', { name: 'Recent notes' });
	const link = recent.getByRole('link', { name: 'Calibration: Fit the parameters' });
	await expect(link).toHaveAttribute('href', '?tab=calibration#set-fit');
	await link.click();
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=calibration#set-fit$`));
	// Under the page's part headings (h2), the panels are h3 on Calibration.
	const fitHeading = page.locator('#set-fit').getByRole('heading', { level: 3 }).first();
	await expect(fitHeading).toHaveText(/^Fit the parameters/);
	await expect(fitHeading).toBeFocused();
	await expect(fitHeading).toBeInViewport();
	await page.goBack();
	await expect(page.getByRole('heading', { level: 1, name: 'Project', exact: true })).toBeVisible();
});

test('a viewer reads the fit of the published run and of another, with no fit controls and no run to start', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Calibration viewer journey');
	const baseline = await createRun(page.request, project.id, 'Baseline');
	const trial = await createRun(page.request, project.id, 'Trial');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId: baseline } })).status()).toBe(201);
	const viewer = await signIn('Calibration journey viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 1440, height: 960 });

	await v.goto(`/projects/${project.id}`);
	await sections(v).getByRole('link', { name: 'Calibration', exact: true }).click();
	await expect(calTitle(v)).toBeFocused();
	// The published baseline by default, its fit read in full.
	await expect(results(v)).toHaveAttribute('data-run', baseline);
	await expect(calibrationRunPicker(v).locator('option:checked')).toHaveText(/^Baseline · /);
	const cal = v.locator('#res-calibration');
	await expect(cal.getByRole('heading', { name: 'Calibration against observed flow' })).toBeVisible();
	await expect(cal).toContainText('Observations');
	await expect(v.locator('#res-hydrograph').getByRole('heading', { name: 'Hydrograph' })).toBeVisible();
	// Another run, picked.
	await calibrationRunPicker(v).selectOption(trial);
	await expect(v).toHaveURL(new RegExp(`\\?tab=calibration&run=${trial}$`));
	await expect(results(v)).toHaveAttribute('data-run', trial);
	await expect(cal.getByRole('heading', { name: 'Calibration against observed flow' })).toBeVisible();

	// No fit controls: the fields read-only, nothing to apply, no jump to the fit, no run to start, no save bar.
	await expect(x1Field(v)).not.toBeEditable();
	await expect(v.locator('#cal-setup').getByRole('button', { name: /^Apply to form/ })).toHaveCount(0);
	await expect(sectionHeader(v).getByRole('link', { name: 'Fit the parameters', exact: true })).toHaveCount(0);
	await expect(sectionHeader(v).getByTestId('header-run')).toHaveCount(0);
	await expect(sectionHeader(v).getByRole('button', { name: 'Add data' })).toHaveCount(0);
	await expect(anySaveBar(v)).toHaveCount(0);
});
