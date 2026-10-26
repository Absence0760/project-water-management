// A #fragment typed in the address bar while a workspace page is already open (issue #586 finding R2-D):
// only the hash changes, so nothing mounts again, and the landing used to run on load only. Settings,
// Runs & results, Data and Project now land on the panel and focus its heading on each such change, a
// lazy panel too (nav/anchorLanding.ts), and a moved panel's old anchor goes on to its new page
// (nav/anchorMoves.ts). The loads are pinned in settings-layout-pins.spec.ts and runs-layout-pins.spec.ts.
// Synthetic data only.
import type { Page } from '@playwright/test';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openCalibration, openSettings } from '../support/settings.ts';

/** The heading a panel's anchor names: the element itself, or the first h2–h4 inside it. */
const anchoredHeading = (page: Page, id: string) => page.locator(`:is(h2, h3, h4)#${id}, #${id} :is(h2, h3, h4)`).first();

/** Type `hash` into the address bar: a same-document navigation, as the browser makes it. */
async function typeHash(page: Page, hash: string) {
	const url = new URL(page.url());
	url.hash = hash;
	await page.goto(url.href);
}

async function expectLanded(page: Page, id: string, heading: string | RegExp) {
	const h = anchoredHeading(page, id);
	await expect(h, id).toHaveText(heading, { useInnerText: true });
	await expect(h, id).toBeInViewport();
	await expect(h, id).toBeFocused();
}

test('a #fragment typed while Model settings, Calibration, Runs & results, Data or Project is open lands on its panel, focused', async ({ page, owner }) => {
	void owner;
	test.setTimeout(110_000); // five pages, two fragments each
	await page.setViewportSize({ width: 1280, height: 800 });
	const project = await seedRunnableProject(page.request, 'Hash change landing');
	const runId = await createRun(page.request, project.id, 'Landing');

	// Model settings: the last panel, then the first.
	await openSettings(page, project.id);
	await typeHash(page, '#set-auto');
	await expectLanded(page, 'set-auto', 'Automatic runs');
	await typeHash(page, '#set-period');
	await expectLanded(page, 'set-period', 'Simulation period');

	// Calibration: a lazy card of Flow calibration (waited for, as on load), then a settings panel (issue #586 round 3).
	await openCalibration(page, project.id);
	await typeHash(page, '#set-evaporation');
	await expectLanded(page, 'set-evaporation', 'Evaporation from the map');
	await typeHash(page, '#set-wr2012');
	await expectLanded(page, 'set-wr2012', 'WR2012 check');

	// Runs & results, with its run drawn: a panel near the end, then one that moved to Hydrological units, which
	// goes on there for the same run.
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);
	await expect(page.locator('#res-summary')).toBeVisible();
	await typeHash(page, '#res-notes');
	await expectLanded(page, 'res-notes', 'Run notes');
	await typeHash(page, '#res-curtailment');
	await expect(page).toHaveURL(new RegExp(`\\?tab=supply&run=${runId}#res-curtailment$`));
	await expectLanded(page, 'res-curtailment', 'Curtailment targets');

	// Data: Data feeds, a chunk of its own, then back up to the series list.
	await page.goto(`/projects/${project.id}?tab=series`);
	await expect(page.locator('#data-series')).toBeVisible();
	await typeHash(page, '#data-feeds');
	await expectLanded(page, 'data-feeds', 'Data feeds');
	await typeHash(page, '#data-series');
	await expectLanded(page, 'data-series', 'Input time series');

	// Project: the lazy API keys (an owner's), then the members list.
	await page.goto(`/projects/${project.id}?tab=project`);
	await expect(page.locator('#details-h')).toBeVisible();
	await typeHash(page, '#project-api-keys');
	await expectLanded(page, 'project-api-keys', 'API keys');
	await typeHash(page, '#members-h');
	await expectLanded(page, 'members-h', /^Members/);
});

/** Click a link on the page to `href`, as an in-page link with another query is followed (SvelteKit pushes it). */
async function followLink(page: Page, href: string) {
	await page.evaluate((to) => {
		const a = document.createElement('a');
		a.href = to;
		a.textContent = 'Test link';
		a.dataset.testid = 'query-hash-link';
		document.querySelector('main')!.prepend(a);
	}, href);
	await page.getByTestId('query-hash-link').click();
}

test('a link that changes the query as well as the #fragment lands on its panel, focused', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	const project = await seedRunnableProject(page.request, 'Query and hash landing');
	const first = await createRun(page.request, project.id, 'First');
	const second = await createRun(page.request, project.id, 'Second');

	// Settings: nothing mounts again, and no hashchange fires.
	await openSettings(page, project.id);
	await followLink(page, `/projects/${project.id}?tab=settings&view=all#set-auto`);
	await expect(page).toHaveURL(/view=all#set-auto$/);
	await expectLanded(page, 'set-auto', 'Automatic runs');

	// Runs & results: another run's panel, drawn for that run.
	await page.goto(`/projects/${project.id}?tab=runs&run=${first}`);
	await expect(page.locator('#res-summary')).toBeVisible();
	await followLink(page, `/projects/${project.id}?tab=runs&run=${second}#res-notes`);
	await expect(page).toHaveURL(new RegExp(`run=${second}#res-notes$`));
	await expectLanded(page, 'res-notes', 'Run notes');
});
