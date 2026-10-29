// A unit's drawer → "Actual ET from satellite" (issue #623; docs/ui.md § Farm
// drawer, docs/model.md §2.10o). Upper farm has a parcel on the map and
// dekads of WaPOR actual ET loaded the way the worker loads them
// (e2e/support/db.ts plantEtObservations): the fold's line says how many were
// compared with the run and which way the model leans, as the API worked it
// out; opened, it gives the summary, the season, the dekads newest first with
// why one wasn't compared, a CSV with the credit on its first line, and the
// credit. With SSEBop's dekads too, a WaPOR | SSEBop switch shows each on
// its own. Lower farm has none, the usual case (the fetch is off by default,
// as in e2e, and no parcel is linked to it), and says why. On a phone nothing
// scrolls sideways. Invented data only.
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { plantEtObservations } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { expectFoldOnOneRow, expectFoldsNamed } from '../support/settings.ts';

const panel = (page: Page) => page.getByTestId('et-observed');

/** The run is 1 Oct 2021 – 28 Jan 2022 (seedRunnableProject): five whole dekads, a cloudy one, and one the run ends inside. */
const DEKADS = [
	{ dekad: '2021-10-01', etaMmDay: 3.2, validShare: 1 },
	{ dekad: '2021-10-11', etaMmDay: 3.6, validShare: 0.97 },
	{ dekad: '2021-10-21', etaMmDay: 4.1, validShare: 1 },
	{ dekad: '2021-11-01', etaMmDay: 4.4, validShare: 0.9 },
	{ dekad: '2021-11-11', etaMmDay: 4.8, validShare: 0.4 },
	{ dekad: '2021-12-01', etaMmDay: 5.6, validShare: 1 },
	{ dekad: '2022-01-21', etaMmDay: 6.0, validShare: 1 }
];

/** `n` dekads in a row from 1 Jan 2021 (most of them before the run): a long record. */
const manyDekads = (n: number) =>
	Array.from({ length: n }, (_, i) => {
		const month = Math.floor(i / 3);
		const d = new Date(Date.UTC(2021, month, [1, 11, 21][i % 3]!));
		return { dekad: d.toISOString().slice(0, 10), etaMmDay: 2 + (i % 5), validShare: 1 };
	});

async function seed(page: Page, name: string, dekads = DEKADS) {
	const project = await seedRunnableProject(page.request, name);
	const idOf = (n: string) => String(project.model.nodes.find((x) => x.name === n)!.id);
	await createRun(page.request, project.id, 'Baseline');
	const made = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'farm_parcel', name: 'Orchard block', nodeId: idOf('Upper farm'), geometry: { type: 'Polygon', coordinates: [box(21.31, -33.69, 0.01)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	await plantEtObservations(idOf('Upper farm'), dekads);
	return { projectId: project.id, upper: idOf('Upper farm'), lower: idOf('Lower farm') };
}

async function openDrawer(page: Page, projectId: string, nodeId: string, unit: string) {
	await page.goto(`/projects/${projectId}?tab=crops&farm=${nodeId}`);
	await expect(page.getByRole('dialog', { name: `${unit}: planted areas` })).toBeVisible();
	await expect(panel(page)).toHaveAttribute('data-ready', 'true');
}

test('the drawer compares the unit’s satellite actual ET with the run, dekad by dekad, and credits FAO WaPOR', async ({ page, owner }) => {
	void owner;
	const { projectId, upper } = await seed(page, 'Actual ET from satellite');
	const api = (await (await page.request.get(`${API_URL}/projects/${projectId}/nodes/${upper}/et-observed`)).json()) as {
		sources: { summary: { compared: number; etBiasPct: number; irrigationBiasPct: number } }[];
	};
	const s = api.sources[0]!.summary;
	expect(s.compared).toBe(5);
	const sign = (b: number) => `${b > 0 ? '+' : b < 0 ? '−' : ''}${Math.abs(Math.round(b))}%`;

	await openDrawer(page, projectId, upper, 'Upper farm');
	await expect(panel(page)).toHaveAccessibleName('Upper farm: actual ET from satellite');
	await expect(panel(page).locator('details.fold > summary')).toContainText('Actual ET from satellite:');
	await expect(panel(page).getByTestId('et-observed-line')).toHaveText(`5 dekads compared · crop ET ${sign(s.etBiasPct)} · irrigation ${sign(s.irrigationBiasPct)}`);

	// At 1280 the closed fold keeps its name, line and action on one row, as every fold does.
	await page.setViewportSize({ width: 1280, height: 800 });
	await expectFoldOnOneRow(panel(page).locator('details.fold'));
	expect(await expectFoldsNamed(panel(page))).toBe(1);

	await panel(page).locator('details.fold > summary').click();
	await expect(panel(page).getByTestId('et-observed-run')).toHaveText(/^Compared with the newest run, “Baseline” \(\d{1,2} \w{3} \d{4}\)\.$/);
	await expect(panel(page).getByTestId('et-observed-dirty')).toHaveCount(0);
	await expect(panel(page).getByTestId('et-observed-summary')).toContainText(/^Over 5 dekads: The model’s crop ET (is \d+% (above|below)|matches) the satellite’s\./);
	const seasons = panel(page).getByTestId('et-observed-seasons').locator('tbody tr');
	await expect(seasons).toHaveCount(1);
	await expect(seasons.first().locator('th')).toHaveText('Oct 2021 – Mar 2022');
	await expect(seasons.first().locator('td').first()).toHaveText('5 of 7');

	await panel(page).getByText('The 7 WaPOR dekads, newest first').click();
	const rows = panel(page).getByTestId('et-observed-dekads').locator('tbody tr');
	// Seven fold nothing away (six shown, and one more isn't worth a button).
	await expect(rows).toHaveCount(7);
	await expect(rows.nth(0).locator('th')).toHaveText('21–31 Jan 2022');
	await expect(rows.nth(0)).toContainText('Not compared: the run covers only part of it');
	await expect(rows.nth(2).locator('th')).toHaveText('11–20 Nov 2021');
	await expect(rows.nth(2)).toContainText('Not compared: partly seen (cloud or a gap)');
	await expect(rows.nth(6).locator('th')).toHaveText('1–10 Oct 2021');
	await expect(panel(page).getByTestId('et-observed-credit')).toHaveText('Actual ET (WaPOR): FAO WaPOR v3, CC BY 4.0.');

	const [download] = await Promise.all([page.waitForEvent('download'), panel(page).getByTestId('et-observed-csv').click()]);
	expect(download.suggestedFilename()).toBe('Upper-farm-actual-et.csv');
	const text = (await readFile((await download.path())!, 'utf8')).replace(/^﻿/, '');
	const lines = text.split('\r\n');
	expect(lines[0]).toBe('# Upper farm: actual ET FAO WaPOR v3, CC BY 4.0 · compared with run "Baseline" · volumes on the run\'s planted area');
	expect(lines[1]!.startsWith('source,dekad,end,days,eta_mm_day')).toBe(true);
	expect(lines.filter((l) => l.startsWith('wapor,'))).toHaveLength(7);

	const fit = await panel(page).evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
	expect(fit.scroll, `the open box scrolls sideways: ${fit.scroll} px in ${fit.client}`).toBeLessThanOrEqual(fit.client);
	await expectNoViolations(page, { include: '[data-testid="et-observed"]' });
});

test('a long record shows its newest six dekads, and Show all opens the rest in place', async ({ page, owner }) => {
	void owner;
	const { projectId, upper } = await seed(page, 'Actual ET long record', manyDekads(40));
	await openDrawer(page, projectId, upper, 'Upper farm');
	await panel(page).locator('details.fold > summary').click();
	await panel(page).getByText('The 40 WaPOR dekads, newest first').click();
	const rows = panel(page).getByTestId('et-observed-dekads').locator('tbody tr');
	await expect(rows).toHaveCount(6);
	// Newest first: the 40th dekad from 1 Jan 2021 is 1–10 Feb 2022.
	await expect(rows.first().locator('th')).toHaveText('1–10 Feb 2022');
	const more = panel(page).getByRole('button', { name: 'Show all 40 dekads' });
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(more).toHaveAttribute('aria-controls', (await panel(page).getByTestId('et-observed-dekads').getAttribute('id'))!);
	await more.click();
	await expect(rows).toHaveCount(40);
	await expect(rows.last().locator('th')).toHaveText('1–10 Jan 2021');
	const back = panel(page).getByRole('button', { name: 'Show the newest 6 dekads' });
	await expect(back).toHaveAttribute('aria-expanded', 'true');
	await back.click();
	await expect(rows).toHaveCount(6);
});

test('a viewer reads the comparison and downloads it', async ({ page, owner, signIn }) => {
	void owner;
	const { projectId, upper } = await seed(page, 'Actual ET viewer');
	const viewer = await signIn('Actual ET viewer');
	await addMember(page.request, projectId, viewer.user.email, 'viewer');
	const vp = viewer.page;
	await openDrawer(vp, projectId, upper, 'Upper farm');
	await expect(panel(vp).locator('details.fold > summary .fold-change')).toHaveText('Show');
	await expect(panel(vp).getByTestId('et-observed-line')).toHaveText(/^5 dekads compared · crop ET /);
	await panel(vp).locator('details.fold > summary').click();
	const [download] = await Promise.all([vp.waitForEvent('download'), panel(vp).getByTestId('et-observed-csv').click()]);
	expect(download.suggestedFilename()).toBe('Upper-farm-actual-et.csv');
});

test('the switch shows SSEBop’s dekads on their own, and the CSV holds both sources', async ({ page, owner }) => {
	void owner;
	const { projectId, upper } = await seed(page, 'Actual ET two sources');
	await plantEtObservations(upper, DEKADS.slice(0, 3), 180_000, 'ssebop');
	await openDrawer(page, projectId, upper, 'Upper farm');
	await expect(panel(page).getByTestId('et-observed-line')).toHaveText(/^5 dekads compared · /);
	await panel(page).locator('details.fold > summary').click();
	const sw = panel(page).getByRole('group', { name: 'Source' });
	const wapor = sw.getByRole('button', { name: 'WaPOR (7 dekads)' });
	const ssebop = sw.getByRole('button', { name: 'SSEBop (3 dekads)' });
	await expect(wapor).toHaveAttribute('aria-pressed', 'true');
	await expect(ssebop).toHaveAttribute('aria-pressed', 'false');
	await ssebop.click();
	await expect(ssebop).toHaveAttribute('aria-pressed', 'true');
	await expect(wapor).toHaveAttribute('aria-pressed', 'false');
	// Three clear dekads inside the run: all compared, the line and the tables SSEBop's.
	await expect(panel(page).getByTestId('et-observed-line')).toHaveText(/^3 dekads compared · /);
	await panel(page).getByText('The 3 SSEBop dekads, newest first').click();
	await expect(panel(page).getByTestId('et-observed-dekads').locator('tbody tr')).toHaveCount(3);
	await expect(panel(page).getByTestId('et-observed-credit')).toHaveText(['Actual ET (WaPOR): FAO WaPOR v3, CC BY 4.0.', 'Actual ET (SSEBop): USGS FEWS NET SSEBop v6, CC0.']);
	const [download] = await Promise.all([page.waitForEvent('download'), panel(page).getByTestId('et-observed-csv').click()]);
	const lines = (await readFile((await download.path())!, 'utf8')).split('\r\n');
	expect(lines.filter((l) => l.startsWith('wapor,'))).toHaveLength(7);
	expect(lines.filter((l) => l.startsWith('ssebop,'))).toHaveLength(3);
	await wapor.click();
	await expect(panel(page).getByTestId('et-observed-line')).toHaveText(/^5 dekads compared · /);
	await expectNoViolations(page, { include: '[data-testid="et-observed"]' });
});

test('a unit with no observations says why: the usual case, the check being off and no parcel linked', async ({ page, owner }) => {
	void owner;
	const { projectId, lower } = await seed(page, 'Actual ET none yet');
	await openDrawer(page, projectId, lower, 'Lower farm');
	await expect(panel(page).getByTestId('et-observed-line')).toHaveText('off on this site');
	await panel(page).locator('details.fold > summary').click();
	await expect(panel(page).getByTestId('et-observed-empty')).toContainText(
		'The satellite check of actual ET is off on this site (it is off by default), and no farm parcels are linked to Lower farm on the Map.'
	);
	await expect(panel(page).getByTestId('et-observed-empty').getByRole('link', { name: 'Open the Map' })).toHaveAttribute('href', new RegExp(`node=${lower}`));
	await expect(panel(page).getByTestId('et-observed-credit')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="et-observed"]' });
});

test.describe('on a phone, in the dark theme', () => {
	test.use({ colorScheme: 'dark', viewport: { width: 390, height: 844 } });

	test('the open box and its tables fit the width and pass axe', async ({ page, owner }) => {
		void owner;
		const { projectId, upper } = await seed(page, 'Actual ET phone');
		await openDrawer(page, projectId, upper, 'Upper farm');
		await panel(page).locator('details.fold > summary').click();
		await panel(page).getByText('The 7 WaPOR dekads, newest first').click();
		await expect(panel(page).getByTestId('et-observed-dekads')).toBeVisible();
		await expectNoSidewaysScroll(page);
		for (const w of await panel(page).locator('.table-wrap').all()) {
			const fit = await w.evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
			expect(fit.scroll, `a table scrolls sideways: ${fit.scroll} px in ${fit.client}`).toBeLessThanOrEqual(fit.client);
		}
		await expectNoViolations(page, { include: '[data-testid="et-observed"]' });
	});
});
