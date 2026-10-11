// Runs & results → the Record group and the things to check (issue #521, section 10): Run notes, Evidence and
// Reproduction are panels of their own, each with its action where it is seen (Save notes in its action row,
// Withdraw and Check reproduction in the panel's head, Publish and Edit notice in Publication's head); a run
// that can never be evidence or be published offers none of those actions, only the reason; and the
// warnings wall folds to its first 3 items. Synthetic data.
import type { Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, nominateRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, layoutSettled, resizeTo } from '../support/reflow.ts';

/** A nominated, published baseline and a scenario run on it. */
async function seed(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	const base = await createRun(page.request, project.id, 'Calibrated baseline');
	await nominateRun(page.request, project.id, base, 'Calibrated against the weir record');
	const pub = await page.request.post(`${API_URL}/projects/${project.id}/publication`, {
		data: { runId: base, restriction: { level: 'advisory', pct: 10, notice: { en: 'Irrigate at night only.' } }, nextExpectedOn: null }
	});
	expect(pub.status()).toBe(201);
	const upper = (project.model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper farm')!.id;
	const made = await page.request.post(`${API_URL}/projects/${project.id}/scenarios`, {
		data: { name: 'Upper farm dam raise', baseRunId: base, ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 300_000 }] }
	});
	expect(made.status()).toBe(201);
	const sid = ((await made.json()) as { scenario: { id: string } }).scenario.id;
	const ran = await page.request.post(`${API_URL}/projects/${project.id}/scenarios/${sid}/runs`, { data: {} });
	expect(ran.status()).toBe(201);
	const scenarioRun = ((await ran.json()) as { run: { id: string } }).run.id;
	return { id: project.id, base, scenarioRun };
}

const evidence = (page: Page) => page.locator('#res-evidence');
const reproduce = (page: Page) => page.locator('#res-reproduce');
const publication = (page: Page) => page.locator('#res-publication');
const box = async (l: Locator) => (await l.boundingBox())!;

/** A button in its panel's head: on the same row as the panel's heading. */
async function expectInHead(panel: Locator, heading: RegExp, button: Locator) {
	const h = await box(panel.getByRole('heading', { name: heading }));
	const b = await box(button);
	expect(Math.abs(b.y + b.height / 2 - (h.y + h.height / 2))).toBeLessThan(12);
	expect(b.x).toBeGreaterThan(h.x + h.width);
}

test('at 1440×900 each Record panel’s action is on screen with the panel, in its head or its action row', async ({ page, owner }) => {
	void owner;
	const p = await seed(page, 'Record layout');
	await page.setViewportSize({ width: 1440, height: 900 });

	await page.goto(`/projects/${p.id}?tab=runs&run=${p.base}#res-notes`);
	const notes = page.locator('#res-notes');
	await expect(notes).toBeInViewport();
	await layoutSettled(page);
	await expect(notes.getByRole('button', { name: 'Save notes' })).toBeInViewport({ ratio: 1 });
	// The team's Notes button: its accessible name starts with what it shows (WCAG 2.5.3).
	const teamNotes = notes.locator('.notes-btn');
	await expect(teamNotes).toHaveText('Notes');
	await expect(teamNotes).toHaveAccessibleName('Notes on this run');

	for (const [panel, heading, name] of [
		[evidence(page), /^Evidence$/, 'Withdraw the nomination…'],
		[reproduce(page), /^Reproduction$/, 'Check reproduction'],
		// "Publication Published": the badge is in the heading.
		[publication(page), /^Publication Published$/, 'Edit notice']
	] as const) {
		await panel.evaluate((el) => el.scrollIntoView({ block: 'start' }));
		await layoutSettled(page);
		const button = panel.getByRole('button', { name, exact: true });
		await expect(button).toBeInViewport({ ratio: 1 });
		await expectInHead(panel, heading, button);
	}
	// Evidence on a run of the model keeps its history.
	await expect(evidence(page).getByRole('list', { name: 'Nomination history, newest first' }).getByRole('listitem')).toHaveCount(1);

	// The withdraw form opens in place with the focus in its field, and Cancel hands the focus back.
	await evidence(page).getByRole('button', { name: 'Withdraw the nomination…' }).click();
	await expect(evidence(page).getByLabel(/^Why the nomination is withdrawn/)).toBeFocused();
	await evidence(page).getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(evidence(page).getByRole('button', { name: 'Withdraw the nomination…' })).toBeFocused();
	// Edit notice opens its form with the focus on the level.
	await publication(page).getByRole('button', { name: 'Edit notice' }).click();
	await expect(publication(page).getByRole('form', { name: 'Edit the notice' }).getByLabel('Level', { exact: true })).toBeFocused();
	await expectNoViolations(page, { include: '#res-notes, #res-evidence, #res-reproduce, #res-publication' });
});

test('a scenario run offers nothing that doesn’t apply to it: no withdraw, no other run’s history, no publish or notice edit, only why', async ({ page, owner }) => {
	void owner;
	const p = await seed(page, 'Record scenario run');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${p.id}?tab=runs&run=${p.scenarioRun}#res-evidence`);
	await expect(evidence(page)).toBeInViewport();

	await expect(evidence(page).getByTestId('evidence-kind')).toContainText('A scenario run is its scenario’s changes on a base run');
	await expect(evidence(page).getByRole('button')).toHaveCount(0);
	await expect(evidence(page).getByRole('heading', { name: 'Nomination history' })).toHaveCount(0);
	await expect(evidence(page).getByRole('textbox')).toHaveCount(0);
	await expect(publication(page).getByTestId('publish-blocker')).toContainText('This is a scenario run');
	await expect(publication(page).getByTestId('publish-blocker')).toContainText('The notice is edited from a run of the model.');
	for (const name of ['Publish this run', 'Edit notice']) await expect(publication(page).getByRole('button', { name, exact: true })).toHaveCount(0);
	// The reproduction still applies to a scenario run.
	await expect(reproduce(page).getByRole('button', { name: 'Check reproduction' })).toBeVisible();

	// The reason links to the evidence run, where the withdraw and the history are.
	await evidence(page).getByRole('link', { name: 'Open the evidence run' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]run=${p.base}#res-evidence$`));
	await expect(evidence(page).getByRole('button', { name: 'Withdraw the nomination…' })).toBeVisible();
	await expect(evidence(page).getByRole('list', { name: 'Nomination history, newest first' })).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`[?&]run=${p.scenarioRun}`));
	await expect(evidence(page).getByTestId('evidence-kind')).toBeVisible();
});

// Synthetic warnings added to the run's summary: the engine raises 1–2 on this small catchment, and the fold is
// about a long list (the Showcase raises 8–9).
const EXTRA = Array.from({ length: 9 }, (_, i) => `Synthetic warning ${i + 1}: the record at gauge ${i + 1} has a gap the model fills.`);

test('the things to check fold to their first 3 with “Show all N”, open and fold back, and the results reach the first screen', async ({ page, owner, fetchRoute }) => {
	void owner;
	const p = await seed(page, 'Record warnings');
	await fetchRoute(page, new RegExp(`/projects/${p.id}/runs/[^/?]+(?:\\?.*)?$`), async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		const res = await route.fetch();
		const body = await res.json();
		if (body?.run?.summary) body.run.summary.warnings = [...(body.run.summary.warnings ?? []), ...EXTRA];
		await route.fulfill({ response: res, json: body });
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${p.id}?tab=runs&run=${p.base}`);
	const wall = page.getByTestId('warnings-check');
	await expect(wall).toBeVisible();
	const total = Number((await wall.locator('strong').textContent())!.match(/^(\d+) things/)![1]);
	expect(total).toBeGreaterThan(3);
	await expect(wall.getByRole('listitem')).toHaveCount(3);
	const toggle = wall.getByRole('button', { name: `Show all ${total} things to check` });
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	// With the wall folded, the headline cards start on the first screen.
	await layoutSettled(page);
	await expect(page.getByText('Mean natural flow', { exact: false }).first()).toBeInViewport();

	await toggle.click();
	await expect(wall.getByRole('listitem')).toHaveCount(total);
	const back = wall.getByRole('button', { name: 'Show only the first 3 things to check' });
	await expect(back).toHaveAttribute('aria-expanded', 'true');
	await expect(back).toBeFocused();
	await back.click();
	await expect(wall.getByRole('listitem')).toHaveCount(3);
	await expectNoViolations(page, { include: '[data-testid="warnings-check"]' });
});

test('the Record panels and the things to check stack on a phone with no sideways scroll, and pass axe', async ({ page, owner }) => {
	void owner;
	const p = await seed(page, 'Record phone');
	for (const run of [p.base, p.scenarioRun]) {
		await page.goto(`/projects/${p.id}?tab=runs&run=${run}#res-evidence`);
		await expect(evidence(page)).toBeInViewport();
		for (const width of [320, 390]) {
			await resizeTo(page, { width, height: 844 });
			await expectNoSidewaysScroll(page);
		}
		await expectNoViolations(page, { include: '#res-notes, #res-evidence, #res-reproduce, #res-publication' });
	}
});
