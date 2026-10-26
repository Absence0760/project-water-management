// The Calibration page (?tab=calibration, issue #586): its own sidebar row, one title, the fit's line and its one jump
// in the header, and its two parts as the page's h2s: "Set up the fit" holds the settings panels (round 3: Flow
// calibration, Calibration record, Fit the parameters, WR2012 check), each an h3 under it, and "How the shown run
// fits" holds Model quality for the run picked (calibration-results.spec.ts). The side index lists the panels under
// the two parts, the second part's for the run shown. The part's states: no observed record, no run, the runs list
// failing, and a viewer (R3-D). Old ?tab=calibration#set- links to a panel still on Model settings go on there; the
// settings panels' anchors land here (settings-layout-pins.spec.ts pins each, and the save bar across the two pages).
// The a11y scans at 1440 and 390 are a11y.spec.ts's. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectAbove, expectNoSidewaysScroll } from '../support/reflow.ts';
import { LONG_LABEL } from '../support/runs.ts';
import { sectionHeader } from '../support/sectionHeader.ts';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const index = (page: Page) => page.getByRole('navigation', { name: 'Calibration sections' });
const title = (page: Page) => page.getByRole('heading', { level: 1, name: 'Calibration', exact: true });
const part = (page: Page, id: string) => page.locator(`#${id}`).getByRole('heading', { level: 2 });
const SETUP_PANELS = ['Flow calibration', 'Calibration record', 'Fit the parameters', 'WR2012 check'];
const NO_FIT = 'GR4J · no fit record: the parameters were set by hand or imported';

test.describe('1440×960', () => {
	test.use({ viewport: { width: 1440, height: 960 } });

	test('one title, the fit once in the header, the parts as h2s over their panels, and the index listing both parts’ panels', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration page');
		await createRun(page.request, p.id, 'Older run');
		await createRun(page.request, p.id, 'Newest run');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(title(page)).toBeVisible();
		// One page title: no heading of the page's own repeats it.
		await expect(page.getByRole('heading', { name: 'Calibration', exact: true })).toHaveCount(1);
		await expect(sidebar(page).getByRole('link', { name: 'Calibration', exact: true })).toHaveAttribute('aria-current', 'page');

		// The header says where the parameters came from, and goes to Fit the parameters. Neither is repeated below it
		// (C19): the panel's line is its rules', and the GR4J card has no second jump.
		await expect(sectionHeader(page).getByTestId('fit-summary')).toHaveText(NO_FIT);
		await expect(sectionHeader(page).getByRole('link', { name: 'Fit the parameters', exact: true })).toHaveAttribute('href', '#set-fit');
		await expect(page.locator('.cal-page').getByText(NO_FIT, { exact: true })).toHaveCount(0);
		await expect(page.getByTestId('summary-fit')).toHaveText('Calibration rules revision 1 · draft, not signed off');
		await expect(page.locator('#cal-setup').getByRole('link', { name: 'Fit the parameters', exact: true })).toHaveCount(0);

		// The outline: the two parts are the page's h2s, the settings panels h3s under the first, Model quality's panels
		// h3s under the second; the lead the page had while its parts were links is gone, the save note an editor's.
		await expect(page.locator('.cal-page').getByRole('heading', { level: 2 })).toHaveText(['Set up the fit', 'How the shown run fits']);
		await expect(page.locator('#cal-setup').getByRole('heading', { level: 3 })).toHaveText(SETUP_PANELS, { useInnerText: true });
		await expect(page.locator('#cal-setup').getByRole('heading', { level: 4, name: 'GR4J parameters' })).toBeVisible();
		await expect(page.locator('#res-hydrograph').getByRole('heading', { level: 3, name: 'Hydrograph' })).toBeVisible();
		await expect(page.locator('#res-calibration').getByRole('heading', { level: 4, name: /^Where the parameters came from/ })).toBeVisible();
		await expect(page.getByTestId('calibration-setup-note')).toHaveText('These settings save with Model settings’, from the one save bar.');
		const partSize = await part(page, 'cal-setup').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
		const panelSize = await page.locator('#set-flow h3').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
		expect(partSize, 'a part’s heading is larger than its panels’').toBeGreaterThan(panelSize);

		// The side index (a rail at 1440): each part's name over its panels, the second part's for the run shown, with
		// lines for Calibration against observed flow's sub-headings. Every line names its heading word for word.
		await expect(page.locator('nav.rail-nav[aria-label="Calibration sections"]')).toBeVisible();
		await expect(index(page).locator('.rail-h')).toHaveText(['Set up the fit', 'How the shown run fits']);
		const links = index(page).getByRole('list').nth(1).getByRole('link');
		await expect(index(page).getByRole('list').first().getByRole('link')).toHaveText(SETUP_PANELS);
		await expect(links.first()).toHaveText('Hydrograph');
		await expect(links).toContainText(['Hydrograph', 'Flow-duration curve', 'Calibration against observed flow', 'Where the parameters came from', 'EWR test: model against observed flow']);
		// The sub-headings' lines sit indented under their panel's, so they don't read as panels.
		const textX = (name: string) => index(page).getByRole('link', { name, exact: true }).evaluate((e) => e.getBoundingClientRect().x + parseFloat(getComputedStyle(e).paddingLeft));
		expect(await textX('Where the parameters came from')).toBeGreaterThan((await textX('Calibration against observed flow')) + 8);
		// A click lands on the heading, focused.
		await index(page).getByRole('link', { name: 'Where the parameters came from' }).click();
		await expect(page).toHaveURL(/\?tab=calibration#res-fit-provenance$/);
		await expect(page.locator('#res-fit-provenance')).toBeFocused();
		await index(page).getByRole('link', { name: 'Hydrograph' }).click();
		await expect(page.locator('#res-hydrograph').getByRole('heading', { name: 'Hydrograph' })).toBeFocused();

		// The header's link lands on Fit the parameters here, focused.
		await sectionHeader(page).getByRole('link', { name: 'Fit the parameters', exact: true }).click();
		await expect(page).toHaveURL(/\?tab=calibration#set-fit$/);
		const fitHeading = page.locator('#set-fit').getByRole('heading', { level: 3 }).first();
		await expect(fitHeading).toBeInViewport();
		await expect(fitHeading).toBeFocused();
		await page.goBack();
		await expect(title(page)).toBeVisible();
	});

	test('the run line: the picker and Open in Runs & results on one row, the run’s details on one line under it, with long labels', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration run line');
		await createRun(page.request, p.id, 'Baseline');
		await createRun(page.request, p.id, `${LONG_LABEL} with the drought restriction on`);
		await page.goto(`/projects/${p.id}?tab=calibration#cal-fit`);
		const picker = page.locator('#cal-fit').getByRole('combobox', { name: 'Run', exact: true });
		const open = page.locator('#cal-fit').getByRole('link', { name: 'Open in Runs & results' });
		await expect(picker).toBeVisible();
		const [pick, go] = [(await picker.boundingBox())!, (await open.boundingBox())!];
		expect(Math.abs(pick.y + pick.height / 2 - (go.y + go.height / 2)), 'Open in Runs & results beside the picker').toBeLessThan(6);
		// The details: one line, engine included, the whole name not repeated where the select shows it.
		const line = page.getByTestId('calibration-run').locator('.run-line');
		await expect(line).toContainText(/ · engine \d+\.\d+\.\d+$/);
		expect((await line.boundingBox())!.height, 'the run’s details on one line').toBeLessThan(24);
		await expect(line.locator('.whole-name')).toBeHidden();
	});

	test('the run picked on Runs & results: the sidebar link carries it, and the page shows it', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration run pick');
		const older = await createRun(page.request, p.id, 'Older run');
		await createRun(page.request, p.id, 'Newest run');
		// Pick the older run on Runs & results.
		await page.goto(`/projects/${p.id}?tab=runs&run=${older}`);
		await expect(page.getByRole('heading', { level: 2, name: 'Older run' })).toBeVisible();
		const row = sidebar(page).getByRole('link', { name: 'Calibration', exact: true });
		await expect(row).toHaveAttribute('href', `?tab=calibration&run=${older}`);
		await row.click();
		await expect(title(page)).toBeFocused();
		await expect(page.locator('#cal-fit').getByRole('combobox', { name: 'Run', exact: true }).locator('option:checked')).toHaveText(/^Older run · /);
		await expect(page.getByTestId('calibration-results')).toHaveAttribute('data-run', older);
		// And back: Open in Runs & results keeps it.
		await page.locator('#cal-fit').getByRole('link', { name: 'Open in Runs & results' }).click();
		await expect(page).toHaveURL(new RegExp(`\\?tab=runs&run=${older}$`));
		await expect(page.getByRole('heading', { level: 2, name: 'Older run' })).toBeVisible();
	});

	test('loaded links: #cal-fit lands on its part, #res-fit-provenance on its sub-heading; an old #set-feeds goes on to Data', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration links');
		await createRun(page.request, p.id, 'Baseline');
		await page.goto(`/projects/${p.id}?tab=overview`);
		await page.goto(`/projects/${p.id}?tab=calibration#cal-fit`);
		await expect(part(page, 'cal-fit')).toBeFocused();
		await expect(part(page, 'cal-fit')).toBeInViewport();

		await page.goto(`/projects/${p.id}?tab=overview`);
		await page.goto(`/projects/${p.id}?tab=calibration#res-fit-provenance`);
		await expect(page.locator('#res-fit-provenance')).toBeFocused();
		await expect(page.locator('#res-fit-provenance')).toBeInViewport();

		await page.goto('about:blank');
		await page.goto(`/projects/${p.id}?tab=calibration#set-feeds`);
		await expect(page).toHaveURL(/\?tab=series#data-feeds$/);
		await expect(page.locator('#data-feeds').locator('h2, h3').first()).toBeFocused();
	});

	test('no observed record and no run: the part’s one empty state says to add a record on Data, and the index still reaches it', async ({ page, owner }) => {
		void owner;
		const p = await createProject(page.request, 'Calibration no record');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(title(page)).toBeVisible();
		const none = page.getByTestId('calibration-no-run');
		await expect(none).toContainText('No observed flow record yet. A fit compares a run’s flows with a record measured at a gauge: add one on Data, then run the model.');
		await expect(none.getByRole('link', { name: 'Data' })).toHaveAttribute('href', '?tab=series');
		// Run model is the header's, as on Runs & results: no second one here.
		await expect(none.getByRole('link')).toHaveCount(1);
		await expect(none.getByRole('button')).toHaveCount(0);
		await expect(page.locator('#cal-fit').getByRole('combobox')).toHaveCount(0);
		// The index: the settings panels, then one line to the part, with no heading over it.
		await expect(index(page).getByRole('link')).toHaveText([...SETUP_PANELS, 'How the shown run fits']);
		await index(page).getByRole('link', { name: 'How the shown run fits' }).click();
		await expect(part(page, 'cal-fit')).toBeFocused();
		// The settings panels don't need a run.
		await expect(page.locator('#cal-setup #set-fit')).toBeVisible();
		await expectNoViolations(page);
	});

	test('a record but no run: the empty state says to run the model', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration no run');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(page.getByTestId('calibration-no-run')).toContainText('No run yet. Run the model to see how its flows fit the observed record.');
		await expect(sectionHeader(page).getByRole('button', { name: /^Run model/ })).toBeVisible();
	});

	test('the runs list fails: the part says so with Try again, which brings the run back', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration list fails');
		const run = await createRun(page.request, p.id, 'Baseline');
		let fail = true;
		await page.route(
			(url) => url.pathname.endsWith(`/projects/${p.id}/runs`),
			(route) => (fail && route.request().method() === 'GET' ? route.fulfill({ status: 500, json: { error: 'Internal error' } }) : route.fallback())
		);
		await page.goto(`/projects/${p.id}?tab=calibration`);
		const alert = page.locator('#cal-fit').getByRole('alert');
		await expect(alert).toContainText('Couldn’t load the runs');
		await expect(page.getByTestId('calibration-no-run')).toHaveCount(0);
		fail = false;
		await alert.getByRole('button', { name: 'Try again' }).click();
		await expect(page.getByTestId('calibration-results')).toHaveAttribute('data-run', run);
	});

	test('a viewer: the results without fit controls, the settings panels read-only, no save note', async ({ page, owner, signIn }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration viewer');
		await createRun(page.request, p.id, 'Baseline');
		const viewer = await signIn('Calibration viewer');
		await addMember(page.request, p.id, viewer.user.email, 'viewer');
		const v = viewer.page;
		await v.setViewportSize({ width: 1440, height: 960 });
		await v.goto(`/projects/${p.id}`);
		await expect(v.getByLabel('Show model inputs')).not.toBeChecked();
		await sidebar(v).getByRole('link', { name: 'Calibration', exact: true }).click();
		await expect(title(v)).toBeFocused();
		// One run: named, with no picker to choose from, and its results.
		await expect(v.getByTestId('calibration-run')).toContainText('Run Baseline');
		await expect(v.locator('#cal-fit').getByRole('combobox')).toHaveCount(0);
		await expect(v.locator('#res-hydrograph').getByRole('heading', { name: 'Hydrograph' })).toBeVisible();
		await expect(sectionHeader(v).getByRole('button', { name: 'Add data' })).toHaveCount(0);
		// The panels show, every field read-only, with no jump to a fit they can't keep: as on Settings before, a viewer
		// may try Fit automatically in the browser but never apply it (fit-panel-layout.spec.ts).
		const setup = v.locator('#cal-setup');
		await expect(setup.getByRole('heading', { level: 3, name: 'Fit the parameters' })).toBeVisible();
		await expect(setup.getByLabel(/^Production store capacity X1/)).not.toBeEditable();
		await expect(setup.getByRole('button', { name: /^Apply to form/ })).toHaveCount(0);
		await expect(setup.getByRole('link', { name: 'Fit the parameters', exact: true })).toHaveCount(0);
		await expect(sectionHeader(v).getByRole('link', { name: 'Fit the parameters', exact: true })).toHaveCount(0);
		await expect(v.getByTestId('calibration-setup-note')).toHaveCount(0);
	});
});

test.describe('1280×800', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('the index is the bar above the parts, which stack: the settings panels and the charts need the page’s width', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration 1280');
		await createRun(page.request, p.id, 'Baseline');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(title(page)).toBeVisible();
		await expect(index(page).getByRole('link', { name: 'Flow calibration' })).toBeVisible();
		await expect(page.locator('nav.rail-nav')).toHaveCount(0);
		await expectAbove(page.locator('#cal-setup'), page.locator('#cal-fit'));
		const body = (await page.locator('.cal-page').boundingBox())!;
		expect((await page.locator('#cal-fit').boundingBox())!.width).toBeGreaterThan(body.width - 2);
		await expectNoSidewaysScroll(page);
	});
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the parts stack, nothing scrolls sideways, and a long run label cut in the select is whole on the line under it', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration phone');
		await createRun(page.request, p.id, 'Baseline');
		const label = `${LONG_LABEL} with the drought restriction on`;
		await createRun(page.request, p.id, label);
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(title(page)).toBeVisible();
		await expect(page.getByRole('button', { name: /^Project sections: Calibration/ })).toBeVisible();
		await expectAbove(page.locator('#cal-setup'), page.locator('#cal-fit'));
		const name = page.getByTestId('calibration-run').locator('.whole-name');
		await expect(name).toBeVisible();
		await expect(name).toContainText(label);
		const picker = page.locator('#cal-fit').getByRole('combobox', { name: 'Run', exact: true });
		expect((await picker.boundingBox())!.x + (await picker.boundingBox())!.width).toBeLessThanOrEqual(390);
		await expectNoSidewaysScroll(page);
	});
});
