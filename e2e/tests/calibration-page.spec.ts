// The Calibration page (?tab=calibration, issue #586): its own sidebar row, one title, its two parts in the side
// index; "Set up the fit" holds the settings panels (round 3: Flow calibration, Calibration record, Fit the
// parameters, WR2012 check), and "How the shown run fits" links, until Model quality moves in, to its panels on
// Runs & results, keeping the run picked. Old ?tab=calibration#set- links to a panel still on Model settings go on
// there; the settings panels' anchors land here (settings-layout-pins.spec.ts pins each, and the save bar across
// the two pages). The a11y scans at 1440 and 390 are a11y.spec.ts's. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectAbove, expectNoSidewaysScroll } from '../support/reflow.ts';
import { sectionHeader } from '../support/sectionHeader.ts';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const index = (page: Page) => page.getByRole('navigation', { name: 'Calibration sections' });
const title = (page: Page) => page.getByRole('heading', { level: 1, name: 'Calibration', exact: true });
const part = (page: Page, id: string) => page.locator(`#${id}`).getByRole('heading', { level: 2 });

test.describe('1440×960', () => {
	test.use({ viewport: { width: 1440, height: 960 } });

	test('one title, the fit in the header, its two parts in the side index, the settings panels here and links to the rest', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration page');
		await createRun(page.request, p.id, 'Older run');
		const newest = await createRun(page.request, p.id, 'Newest run');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(title(page)).toBeVisible();
		// One page title: no heading of the page's own repeats it.
		await expect(page.getByRole('heading', { name: 'Calibration', exact: true })).toHaveCount(1);
		// The header says where the parameters came from, and goes to Fit the parameters (Settings' until round 3).
		await expect(sectionHeader(page).getByTestId('fit-summary')).toHaveText(/^GR4J/);
		await expect(sectionHeader(page).getByRole('link', { name: 'Fit the parameters', exact: true })).toHaveAttribute('href', '#set-fit');
		await expect(sidebar(page).getByRole('link', { name: 'Calibration', exact: true })).toHaveAttribute('aria-current', 'page');

		// The side index (a rail at 1440) lists the two parts, each by its heading; a click focuses the heading.
		await expect(page.locator('nav.rail-nav[aria-label="Calibration sections"]')).toBeVisible();
		await expect(index(page).getByRole('link')).toHaveText(['Set up the fit', 'How the shown run fits']);
		await index(page).getByRole('link', { name: 'How the shown run fits' }).click();
		await expect(page).toHaveURL(/\?tab=calibration#cal-fit$/);
		await expect(part(page, 'cal-fit')).toBeFocused();

		// Set up the fit: the four settings panels, by their headings, in order.
		const setup = page.locator('#cal-setup');
		await expect(setup.getByRole('heading', { level: 2 })).toHaveText(['Set up the fit', 'Flow calibration', 'Calibration record', 'Fit the parameters', 'WR2012 check'], { useInnerText: true });
		// How the shown run fits: the newest run by default, its Model quality panels on Runs & results.
		await expect(page.getByTestId('calibration-run')).toContainText('for Newest run (ran ');
		const fit = page.locator('#cal-fit');
		await expect(fit.getByRole('link')).toHaveText(['Hydrograph', 'Flow-duration curve', 'Calibration against observed flow', 'EWR test: model against observed flow']);
		// Without a pick the links carry no run: Runs & results shows its own default.
		await expect(fit.getByRole('link', { name: 'Hydrograph' })).toHaveAttribute('href', '?tab=runs#res-hydrograph');

		// The header's link lands on Fit the parameters here, focused.
		await sectionHeader(page).getByRole('link', { name: 'Fit the parameters', exact: true }).click();
		await expect(page).toHaveURL(/\?tab=calibration#set-fit$/);
		const fitHeading = page.locator('#set-fit').getByRole('heading', { level: 2 }).first();
		await expect(fitHeading).toBeInViewport();
		await expect(fitHeading).toBeFocused();

		await fit.getByRole('link', { name: 'Flow-duration curve' }).click();
		// Runs & results opens on its default, the newest run, and writes it into the URL in place (RunsTab).
		await expect(page).toHaveURL(new RegExp(`\\?tab=runs&run=${newest}#res-fdc$`));
		const fdc = page.locator('#res-fdc').locator('h2, h3').first();
		await expect(fdc).toBeInViewport();
		await expect(fdc).toBeFocused();
	});

	test('the run picked on Runs & results: the sidebar link carries it, the page names it, and its links keep it', async ({ page, owner }) => {
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
		await expect(page.getByTestId('calibration-run')).toContainText('for Older run (ran ');
		const hydro = page.locator('#cal-fit').getByRole('link', { name: 'Hydrograph' });
		await expect(hydro).toHaveAttribute('href', `?tab=runs&run=${older}#res-hydrograph`);
		await hydro.click();
		await expect(page).toHaveURL(new RegExp(`\\?tab=runs&run=${older}#res-hydrograph$`));
		await expect(page.getByRole('heading', { level: 2, name: 'Older run' })).toBeVisible();
		const h = page.locator('#res-hydrograph').locator('h2, h3').first();
		await expect(h).toBeInViewport();
		await expect(h).toBeFocused();
	});

	test('a loaded #cal- link lands on its part; an old #set-feeds link goes on through Settings to Data', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration links');
		await createRun(page.request, p.id, 'Baseline');
		await page.goto(`/projects/${p.id}?tab=overview`);
		await page.goto(`/projects/${p.id}?tab=calibration#cal-fit`);
		await expect(part(page, 'cal-fit')).toBeFocused();
		await expect(part(page, 'cal-fit')).toBeInViewport();

		await page.goto('about:blank');
		await page.goto(`/projects/${p.id}?tab=calibration#set-feeds`);
		await expect(page).toHaveURL(/\?tab=series#data-feeds$/);
		await expect(page.locator('#data-feeds').locator('h2, h3').first()).toBeFocused();
	});

	test('no run yet: the second part says so and links to Runs & results', async ({ page, owner }) => {
		void owner;
		const p = await createProject(page.request, 'Calibration no run');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(title(page)).toBeVisible();
		const none = page.getByTestId('calibration-no-run');
		await expect(none).toHaveText('No run yet. Once the model has run, its fit is on Runs & results, under Model quality.');
		await expect(none.getByRole('link', { name: 'Runs & results' })).toHaveAttribute('href', '?tab=runs');
		await expect(page.locator('#cal-fit').getByRole('listitem')).toHaveCount(0);
		// The settings panels don't need a run.
		await expect(page.locator('#cal-setup #set-fit')).toBeVisible();
		await expectNoViolations(page);
	});

	test('a viewer: the row without the model inputs, the settings panels read-only with no fit controls', async ({ page, owner, signIn }) => {
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
		await expect(v.getByTestId('calibration-run')).toContainText('for Baseline');
		await expect(sectionHeader(v).getByRole('button', { name: 'Add data' })).toHaveCount(0);
		// The panels show, every field read-only, with no jump to a fit they can't keep: as on Settings before, a viewer
		// may try Fit automatically in the browser but never apply it (fit-panel-layout.spec.ts).
		const setup = v.locator('#cal-setup');
		await expect(setup.getByRole('heading', { level: 2, name: 'Fit the parameters' })).toBeVisible();
		await expect(setup.getByLabel(/^Production store capacity X1/)).not.toBeEditable();
		await expect(setup.getByRole('button', { name: /^Apply to form/ })).toHaveCount(0);
		await expect(setup.getByTestId('flow-fit-link')).toHaveCount(0);
		await expect(sectionHeader(v).getByRole('link', { name: 'Fit the parameters', exact: true })).toHaveCount(0);
	});
});

test.describe('1280×800', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('the index is the bar above the parts, which stack: the settings panels need the width', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration 1280');
		await createRun(page.request, p.id, 'Baseline');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(title(page)).toBeVisible();
		await expect(index(page).getByRole('link')).toHaveText(['Set up the fit', 'How the shown run fits']);
		await expect(page.locator('nav.rail-nav')).toHaveCount(0);
		await expectAbove(page.locator('#cal-setup'), page.locator('#cal-fit'));
		await expectNoSidewaysScroll(page);
	});
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the parts stack, nothing scrolls sideways, and Sections names the page', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration phone');
		await createRun(page.request, p.id, 'Baseline');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(title(page)).toBeVisible();
		await expect(page.getByRole('button', { name: /^Project sections: Calibration/ })).toBeVisible();
		await expectAbove(page.locator('#cal-setup'), page.locator('#cal-fit'));
		await expectNoSidewaysScroll(page);
	});
});
