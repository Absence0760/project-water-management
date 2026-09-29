import type { APIRequestContext, Page } from '@playwright/test';
import { addMember, createProject, createRun, nominateRun, putModel, putSeries, register, sampleModel, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { openRowMenu, outcomesReady, row } from '../support/projects.ts';
import { answerConfirm } from '../support/confirm.ts';

/** A real mouse click at the middle of `target` (whatever element is on top there gets it). */
async function clickAt(page: Page, target: ReturnType<Page['locator']>) {
	const box = (await target.boundingBox())!;
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function createThroughDialog(page: Page, name: string, description = '') {
	await page.getByRole('button', { name: 'New project' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'New project' });
	await dialog.getByLabel('Name').fill(name);
	if (description) await dialog.getByLabel(/Description/).fill(description);
	await dialog.getByRole('button', { name: 'Create' }).click();
	// Creating opens the new project's workspace.
	await expect(page.getByTestId('project-name').filter({ hasText: name })).toBeVisible();
	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' }).click();
	await expect(row(page, name)).toBeVisible();
}

test('several projects for one place: create, copy, delete', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	await expect(page.getByText('You have no projects yet.')).toBeVisible();

	await createThroughDialog(page, 'Example Valley — baseline', 'Current dams and crops');
	await createThroughDialog(page, 'Example Valley — dam raise');
	await createThroughDialog(page, 'Example Valley — drought');
	await expect(page.getByRole('row')).toHaveCount(4); // header + 3

	// Copy A (with a model, so the copy is meaningful) as D.
	// The name opens the project.
	const href = await row(page, 'Example Valley — baseline').getByRole('link', { name: 'Example Valley — baseline', exact: true }).getAttribute('href');
	const idA = href!.split('/').pop()!;
	const model = sampleModel();
	await putModel(page.request, idA, model);

	await openRowMenu(page, 'Example Valley — baseline');
	await row(page, 'Example Valley — baseline').getByRole('button', { name: 'Copy Example Valley — baseline' }).click();
	const dialog = page.getByRole('dialog', { name: 'Copy project' });
	await expect(dialog.getByLabel('Name of the copy')).toHaveValue('Example Valley — baseline (copy)');
	await dialog.getByLabel('Name of the copy').fill('Example Valley — new orchard');
	await dialog.getByRole('button', { name: 'Copy' }).click();
	await expect(dialog).toBeHidden();
	await expect(row(page, 'Example Valley — new orchard')).toBeVisible();
	await expect(page.getByRole('row')).toHaveCount(5);

	// The copy carries A's model but is its own project.
	await row(page, 'Example Valley — new orchard').getByRole('link', { name: 'Example Valley — new orchard', exact: true }).click();
	await expect(page.getByTestId('project-name').filter({ hasText: 'Example Valley — new orchard' })).toBeVisible();
	await expect(page).not.toHaveURL(new RegExp(idA));
	// The model's facts are on the Project page (issue #17).
	await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Project', exact: true }).click();
	const stat = (term: string) => page.getByRole('term').filter({ hasText: term }).locator('xpath=following-sibling::dd');
	await expect(stat('Outflow gauge')).toHaveText('Outflow gauge');
	await expect(stat('Hydrological units')).toHaveText(/^2\s*\+ 1 gauge$/);
	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' }).click();

	// Delete one (confirm dialog accepted).
	await openRowMenu(page, 'Example Valley — drought');
	await row(page, 'Example Valley — drought').getByRole('button', { name: 'Delete Example Valley — drought' }).click();
	await answerConfirm(page, true, 'Delete project “Example Valley — drought”?');
	await expect(row(page, 'Example Valley — drought')).toHaveCount(0);
	await expect(page.getByRole('row')).toHaveCount(4);

	// Still gone after a reload (really deleted, not just hidden).
	await page.reload();
	await expect(row(page, 'Example Valley — baseline')).toBeVisible();
	await expect(row(page, 'Example Valley — drought')).toHaveCount(0);
});

// A click anywhere on a row opens the project; the row's own buttons still do their own thing.
test('clicking anywhere on a project row opens it, and its buttons still work', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.context().request, 'Example Ridge');
	await page.goto('/');
	const r = row(page, 'Example Ridge');
	await openRowMenu(page, 'Example Ridge');
	await r.getByRole('button', { name: 'Copy Example Ridge' }).click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page).toHaveURL(/\/$/);
	// Click where a user would, on a plain cell away from the name: the
	// stretched name link lies over it (Playwright's own click refuses a
	// covered element, so click the screen point).
	await expect(r.locator('td.c-units')).toHaveText('Not published');
	await clickAt(page, r.locator('td.c-units'));
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
	await expect(page.getByTestId('project-name').filter({ hasText: 'Example Ridge' })).toBeVisible();
	// On a phone the row folds into the name cell; tapping its meta line opens it too.
	await page.setViewportSize({ width: 390, height: 800 });
	await page.goto('/');
	await clickAt(page, row(page, 'Example Ridge').locator('.meta-who'));
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
});

test('cancelling the delete confirmation keeps the project', async ({ page, owner }) => {
	void owner;
	await createProject(page.request, 'Keep me');
	await page.goto('/');
	await openRowMenu(page, 'Keep me');
	await row(page, 'Keep me').getByRole('button', { name: 'Delete Keep me' }).click();
	await answerConfirm(page, false, 'Delete project “Keep me”?');
	await page.reload();
	await expect(row(page, 'Keep me')).toBeVisible();
});

// Issue #43: a project with a nominated evidence run keeps it. The refusal is
// explained in a dialog that names the run and links to it, not a raw error.
test('deleting a project with a nominated evidence run is refused, and the dialog explains why', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Licence evidence');
	const runId = await createRun(page.request, project.id, 'Calibrated GR4J');
	await nominateRun(page.request, project.id, runId, 'Calibrated against the logger record.');
	await page.goto('/');

	await openRowMenu(page, 'Licence evidence');
	await row(page, 'Licence evidence').getByRole('button', { name: 'Delete Licence evidence' }).click();
	await answerConfirm(page, true);
	const dialog = page.getByRole('dialog', { name: "This project can't be deleted" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId('evidence-kept')).toHaveText(
		'“Calibrated GR4J” is the nominated evidence run of “Licence evidence”. A project that has nominated evidence keeps it, with its nomination history, for good, so the evidence can still be read and reproduced.'
	);
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(dialog.getByRole('link', { name: 'Open the evidence run' })).toHaveAttribute('href', `/projects/${project.id}?tab=runs&run=${runId}`);

	// Copy project hands over to the copy dialog, for a fresh start without the evidence.
	await dialog.getByRole('button', { name: 'Copy project' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('dialog', { name: 'Copy project' }).getByLabel('Name of the copy')).toHaveValue('Licence evidence (copy)');
	await page.keyboard.press('Escape');

	// Still there after a reload.
	await page.reload();
	await expect(row(page, 'Licence evidence')).toBeVisible();
});

test('the list shows the role the user has on each project', async ({ page, owner, playwright }) => {
	await createProject(page.request, 'My own catchment');

	const other = await playwright.request.newContext();
	await register(other, 'Colleague');
	const shared = await createProject(other, 'Colleague catchment');
	const readOnly = await createProject(other, 'Colleague reference');
	await addMember(other, shared.id, owner.email, 'editor');
	await addMember(other, readOnly.id, owner.email, 'viewer');
	await other.dispose();

	await page.goto('/');
	const role = (name: string) => row(page, name).getByTestId('project-role');
	await expect(role('My own catchment')).toHaveText('owner');
	await expect(role('Colleague catchment')).toHaveText('editor');
	await expect(role('Colleague reference')).toHaveText('viewer');

	// Own projects are grouped under Personal, the colleague's under Shared with me.
	const group = (name: string) => page.getByRole('region', { name });
	await expect(group('Personal').getByRole('rowheader', { name: 'My own catchment' })).toBeVisible();
	await expect(group('Shared with me').getByRole('row')).toHaveCount(3); // header + 2

	// Only owners get Delete in the ⋯ menu; anyone may copy.
	await openRowMenu(page, 'My own catchment');
	await expect(row(page, 'My own catchment').getByRole('button', { name: /^Delete/ })).toBeVisible();
	await openRowMenu(page, 'Colleague catchment');
	await expect(row(page, 'My own catchment').getByRole('button', { name: /^Delete/ })).toHaveCount(0); // one menu at a time
	await expect(row(page, 'Colleague catchment').getByRole('button', { name: /^Delete/ })).toHaveCount(0);
	await openRowMenu(page, 'Colleague reference');
	await expect(row(page, 'Colleague reference').getByRole('button', { name: /^Delete/ })).toHaveCount(0);
	await expect(row(page, 'Colleague reference').getByRole('button', { name: 'Copy Colleague reference' })).toBeVisible();
});

test('the list shows data freshness and the last run, with an Add data shortcut for editors', async ({ page, owner, signIn }) => {
	void owner;
	const empty = await createProject(page.request, 'Freshness — empty');
	const stale = await createProject(page.request, 'Freshness — stale');
	await putModel(page.request, stale.id, sampleModel());
	const days = 30;
	const series = (kind: string, unit: string) => ({ kind, unit, startDate: '2020-10-01', values: Array(days).fill(1) });
	await putSeries(page.request, stale.id, series('rain_catchment_mm', 'mm'));
	await putSeries(page.request, stale.id, series('flow_observed_m3s', 'm3/s'));
	await updateSettings(page.request, stale.id, { apanMm: Array(12).fill(150) }); // GR4J refuses to run without it
	await createRun(page.request, stale.id, 'baseline');

	await page.goto('/');
	const emptyRow = row(page, 'Freshness — empty');
	await expect(emptyRow).toContainText('no rain yet');
	const staleRow = row(page, 'Freshness — stale');
	await expect(staleRow.locator('td.c-data').getByTitle('Recorded rain runs to 2020-10-30')).toHaveText(/^rain \d+ years old$/);
	// The last run and its age, the date under it.
	await expect(staleRow.locator('td.c-run')).toHaveText(/^\s*today\s+\d{4}-\d{2}-\d{2}\s*$/);
	await expect(emptyRow.locator('td.c-run')).toHaveText('Not run yet');

	// "Add data" opens the workspace with the upload dialog requested.
	const add = emptyRow.getByRole('link', { name: 'Add data to Freshness — empty' });
	await expect(add).toHaveAttribute('href', `/projects/${empty.id}?add=data`);

	// Viewers can't upload, so they don't get the shortcut.
	const viewer = await signIn('Freshness viewer');
	await addMember(page.request, stale.id, viewer.user.email, 'viewer');
	await viewer.page.goto('/');
	const vRow = row(viewer.page, 'Freshness — stale');
	await expect(vRow).toContainText(/rain \d+ years old/);
	await expect(vRow.getByRole('link', { name: /^Add data/ })).toHaveCount(0);
});

test.describe('data age under a skewed time zone', () => {
	// Overrides the suite's pinned UTC on purpose (project rule 7): at 12:30 UTC
	// on 6 Feb it is already 02:30 on 7 Feb in UTC+14, so a UTC "today" would
	// be a day behind the viewer's calendar.
	test.use({ timezoneId: 'Pacific/Kiritimati' });

	test('the project list and the workspace header count the same local days', async ({ page, owner }) => {
		void owner;
		const p = await createProject(page.request, 'Skewed clock');
		// 120 days from 2021-10-01: the data runs to 2022-01-28.
		await putSeries(page.request, p.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: Array(120).fill(1) });
		await page.clock.setFixedTime(new Date('2022-02-06T12:30:00Z'));

		await page.goto('/');
		// The row carries the badge twice (wide and narrow layouts); one is shown.
		const badge = row(page, 'Skewed clock').getByTitle('Recorded rain runs to 2022-01-28').filter({ visible: true });
		await expect(badge).toHaveText('rain 10 days old');

		await page.goto(`/projects/${p.id}`);
		// Stale (> 7 days), so a hidden "(older than 7 days)" follows.
		await expect(page.locator('summary').filter({ hasText: 'Rain up to' })).toHaveText(
			'Rain up to 28 Jan 2022 · 10 days ago (older than 7 days)'
		);
	});
});

// ---- Outcomes, Needs attention, filters and scale (issue #17) --------------

interface Outcome {
	id: string;
	ewr: { status: 'green' | 'amber' | 'red' | 'unknown'; daysNotMet30: number | null; days30: number | null };
}
const LABEL = { red: 'Red', amber: 'Amber', green: 'Green' } as const;
/** What the pill says for a known status: the portfolio's words. */
const pillText = (o: Outcome) =>
	o.ewr.status === 'unknown'
		? null
		: o.ewr.daysNotMet30
			? `${LABEL[o.ewr.status]}: EWR not met ${o.ewr.daysNotMet30} of ${o.ewr.days30} days`
			: `${LABEL[o.ewr.status]}: EWR met all ${o.ewr.days30} days`;

async function publish(request: APIRequestContext, projectId: string) {
	const runId = await createRun(request, projectId, 'Baseline');
	const res = await request.post(`${API_URL}/projects/${projectId}/publication`, { data: { runId } });
	expect(res.status(), await res.text()).toBe(201);
}
const team = async (request: APIRequestContext, name: string) =>
	(await (await request.post(`${API_URL}/teams`, { data: { name } })).json()).team as { id: string };
const toTeam = async (request: APIRequestContext, id: string, teamId: string) =>
	expect((await request.patch(`${API_URL}/projects/${id}`, { data: { teamId } })).status()).toBe(200);

test('each row says how its catchment is doing, from the portfolio’s figures, and Needs attention flags the stale ones', async ({ page, owner }) => {
	void owner;
	const pub = await seedRunnableProject(page.request, 'Outcome published');
	await publish(page.request, pub.id);
	const draft = await seedRunnableProject(page.request, 'Outcome draft');
	await createRun(page.request, draft.id, 'Draft');
	await createProject(page.request, 'Outcome empty');
	const figures = (await (await page.request.get(`${API_URL}/projects/outcomes`)).json()).projects as Outcome[];
	const pubFig = figures.find((f) => f.id === pub.id)!;
	expect(pubFig.ewr.status).not.toBe('unknown');

	await page.goto('/');
	await outcomesReady(page);
	await expect(page.getByTestId('projects-context')).toHaveText(/^\s*3 catchments · EWR, last 30 days: .+$/);

	// Published: the status in words, where it comes from, units short and the lowest dam.
	const pr = row(page, 'Outcome published');
	await expect(pr.locator('td.c-ewr')).toContainText(pillText(pubFig)!);
	await expect(pr.locator('td.c-ewr')).toContainText('Published · to 28 Jan 2022');
	await expect(pr.locator('td.c-units')).toHaveText(/^\s*\d+ of \d+ hydrological units? short this week\s*$/);
	await expect(pr.locator('td.c-dam')).toHaveText(/ \d+ %\s*$/);
	await expect(pr.locator('td.c-run')).toContainText('published today');

	// Run, not published: the EWR from the run; unit figures wait for a publication.
	const dr = row(page, 'Outcome draft');
	await expect(dr.locator('td.c-ewr')).toContainText('Latest run · to 28 Jan 2022');
	await expect(dr.locator('td.c-units')).toHaveText('Not published');
	await expect(dr.locator('td.c-dam')).toHaveText('Not published');
	await expect(row(page, 'Outcome empty').locator('td.c-ewr')).toHaveText('Unknown: no run yet');

	// Both runs' figures end in 2022: stale, so both are flagged, with the reason in words.
	const strip = page.getByRole('region', { name: 'Needs attention' });
	await expect(strip.getByTestId('attention-count')).toHaveText('2 of 3');
	await expect(strip.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Outcome draft' }) }).first()).toContainText(/Figures [\d\u202f]+ days old/);
	await expect(strip.getByRole('link', { name: 'Outcome empty' })).toHaveCount(0);

	// "Sort the list by it" puts them first, in the URL; Back undoes it.
	await strip.getByRole('link', { name: 'Sort the list by it' }).click();
	await expect(page).toHaveURL(/[?&]sort=attention/);
	await expect(page.getByLabel('Sort')).toHaveValue('attention');
	await expect(page.getByRole('rowheader').last()).toHaveAccessibleName('Outcome empty');
	await page.goBack();
	await expect(page).not.toHaveURL(/sort=/);
	await expect(page.getByLabel('Sort')).toHaveValue('updated');
});

test('owner chips, search and sort live in the URL; old links still work', async ({ page, owner }) => {
	void owner;
	const t = await team(page.request, 'Chip Valley WUA');
	const inTeam = await createProject(page.request, 'Chip team catchment');
	await toTeam(page.request, inTeam.id, t.id);
	await createProject(page.request, 'Chip personal catchment');

	await page.goto('/');
	const chips = page.getByRole('navigation', { name: 'Filter by owner' });
	await expect(chips.getByRole('link', { name: /^All projects 2$/ })).toHaveAttribute('aria-current', 'true');
	await chips.getByRole('link', { name: /^Chip Valley WUA 1$/ }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]owner=team(%3A|:)${t.id}`));
	await expect(page.getByRole('rowheader')).toHaveCount(1);
	await expect(page.getByRole('rowheader', { name: 'Chip team catchment' })).toBeVisible();
	await page.goBack();
	await expect(page.getByRole('rowheader')).toHaveCount(2);

	// A column heading sorts (worst EWR first), and says so.
	await outcomesReady(page);
	const ewrHead = page.getByRole('columnheader', { name: /^EWR, last 30 days/ }).first();
	await ewrHead.getByRole('button').click();
	await expect(page).toHaveURL(/[?&]sort=status/);
	await expect(page.getByRole('columnheader', { name: /^EWR, last 30 days/ }).first()).toHaveAttribute('aria-sort', 'ascending');
	await page.reload();
	await expect(page.getByLabel('Sort')).toHaveValue('status');

	// Old links: ?sort=name and ?owner=personal from before the redesign.
	await page.goto('/?owner=personal&sort=name');
	await expect(chips.getByRole('link', { name: /^Personal 1$/ })).toHaveAttribute('aria-current', 'true');
	await expect(page.getByLabel('Sort')).toHaveValue('name');
	await expect(page.getByRole('rowheader')).toHaveCount(1);
	await expect(page.getByRole('rowheader', { name: 'Chip personal catchment' })).toBeVisible();
	await page.getByLabel('Search projects').fill('nothing like this');
	await expect(page.getByText('No projects in Personal match “nothing like this”.')).toBeVisible();
	await expect(page).toHaveURL(/[?&]q=nothing/);
});

test('the ⋯ menu works from the keyboard and gives focus back; a viewer gets Copy and no Add data', async ({ page, owner, signIn }) => {
	void owner;
	const p = await createProject(page.request, 'Menu catchment');
	await page.goto('/');
	const more = row(page, 'Menu catchment').getByRole('button', { name: 'More actions for Menu catchment' });
	await more.focus();
	await page.keyboard.press('Enter');
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await page.keyboard.press('Tab');
	await expect(row(page, 'Menu catchment').getByRole('button', { name: 'Copy Menu catchment' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(more).toBeFocused();
	// A click elsewhere closes it too.
	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await page.getByRole('heading', { level: 1, name: 'Projects' }).click();
	await expect(more).toHaveAttribute('aria-expanded', 'false');

	const viewer = await signIn('Menu viewer');
	await addMember(page.request, p.id, viewer.user.email, 'viewer');
	await viewer.page.goto('/');
	const vr = row(viewer.page, 'Menu catchment');
	await expect(vr.getByRole('link', { name: /^Add data/ })).toHaveCount(0);
	await openRowMenu(viewer.page, 'Menu catchment');
	await expect(vr.getByRole('button', { name: 'Copy Menu catchment' })).toBeVisible();
	await expect(vr.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
});

test.describe('fifty projects', () => {
	test.setTimeout(120_000);

	test('fit the window: the list scrolls inside its card, the page doesn’t; the phone stacks with no sideways scroll; no a11y violations', async ({ page, owner }) => {
		void owner;
		const t = await team(page.request, 'Big Valley Water Users Association');
		const pub = await seedRunnableProject(page.request, 'Big published catchment');
		await publish(page.request, pub.id);
		const made = await Promise.all(Array.from({ length: 49 }, (_, i) => createProject(page.request, `Big scoping catchment ${String(i + 1).padStart(2, '0')}`)));
		await Promise.all(made.filter((_, i) => i % 2).map((p) => toTeam(page.request, p.id, t.id)));

		for (const size of [
			{ width: 1440, height: 960 },
			{ width: 1280, height: 800 }
		]) {
			await page.setViewportSize(size);
			await page.goto('/');
			await outcomesReady(page);
			await expect(page.getByRole('rowheader')).toHaveCount(50);
			const m = await page.evaluate(() => {
				const groups = document.querySelector('.groups')!;
				const card = document.querySelector('.list-card')!.getBoundingClientRect();
				return { page: document.documentElement.scrollHeight - innerHeight, inner: groups.scrollHeight - groups.clientHeight, gap: innerHeight - card.bottom };
			});
			expect(m.page, `page scroll at ${size.width}`).toBeLessThanOrEqual(0);
			expect(m.inner, `list scrolls inside at ${size.width}`).toBeGreaterThan(0);
			// The card reaches the window's bottom, less the page's 1rem gutter.
			expect(m.gap).toBeGreaterThanOrEqual(0);
			expect(m.gap).toBeLessThanOrEqual(24);
			await expect(page.getByRole('region', { name: 'Needs attention' })).toBeInViewport();
		}
		await expectNoViolations(page);
		// With a menu open, too. Its row starts below the fold: opening it scrolls the list, and the
		// scroll event, a frame later, must not close the menu it just opened.
		await openRowMenu(page, 'Big published catchment');
		await expectNoViolations(page);
		// A real scroll moves the ⋯ away from the fixed menu, so the menu closes.
		const more = row(page, 'Big published catchment').getByRole('button', { name: 'More actions for Big published catchment', exact: true });
		await page.locator('.groups').evaluate((el) => el.scrollBy(0, 120));
		await expect(more).toHaveAttribute('aria-expanded', 'false');
		await openRowMenu(page, 'Big published catchment');
		await page.keyboard.press('Escape');

		await page.getByLabel('Search projects').fill('Big scoping catchment 49');
		await expect(page.getByRole('rowheader')).toHaveCount(1);
		await expect(page.getByRole('rowheader', { name: 'Big scoping catchment 49' })).toBeVisible();
		await expect(page.getByRole('status').filter({ hasText: /projects? shown/ })).toHaveText('1 project shown');
		// Cleared, the card fills the window again: measuring what sits below it from the document's height
		// counted the empty window under the one-row list and left the card at its 320 px floor.
		await page.getByLabel('Search projects').fill('');
		await expect(page.getByRole('rowheader')).toHaveCount(50);
		const gap = () => page.evaluate(() => innerHeight - document.querySelector('.list-card')!.getBoundingClientRect().bottom);
		await expect.poll(gap).toBeLessThanOrEqual(24);
		expect(await gap()).toBeGreaterThanOrEqual(0);
		expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		await outcomesReady(page);
		expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
		// The figures move under the name on a phone; the owner filter is a select.
		await expect(row(page, 'Big published catchment').locator('.meta-narrow').first()).toBeVisible();
		await expect(page.getByLabel('Show')).toBeVisible();
		await expectNoViolations(page);
	});
});
