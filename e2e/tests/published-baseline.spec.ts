// The published baseline across the workspace (WP-2.3, docs/ui.md § Overview,
// § Runs; docs/run-comparison.md): the Overview card, a viewer opening the
// Runs tab on the published run (an editor on the newest), and the compare
// page pre-selecting and offering the published run as the baseline (A).
//
// One test per surface, each with its own catchment. As one test it made a
// dozen full page loads in one 30 s budget: about 15 s on a quiet laptop, and
// past 30 s when every page load took 2–3 s on a loaded one (issue #41).
import type { APIRequestContext } from '@playwright/test';
import { API_URL } from '../support/env.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

/** Three runs, oldest first (Baseline, Middle, Newest), with Baseline published with an advisory notice. */
async function publishedBaseline(request: APIRequestContext, projectId: string) {
	const baseline = await createRun(request, projectId, 'Baseline');
	const middle = await createRun(request, projectId, 'Middle');
	const newest = await createRun(request, projectId, 'Newest');
	const pub = await request.post(`${API_URL}/projects/${projectId}/publication`, {
		data: { runId: baseline, restriction: { level: 'advisory', pct: 15, notice: { en: 'Irrigate at night only.' } }, nextExpectedOn: '2022-03-01' }
	});
	expect(pub.status()).toBe(201);
	return { baseline, middle, newest };
}

test('the Overview card: empty until a run is published, then the run, who, the notice and the way to edit it; read-only for a viewer', async ({ page, owner, signIn }) => {
	const project = await seedRunnableProject(page.request, 'Published baseline card');
	const viewer = await signIn('Baseline card viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');

	// Nothing published yet: the card's empty state.
	await page.goto(`/projects/${project.id}`);
	const card = page.getByRole('region', { name: 'Published baseline' });
	await expect(card).toContainText('No run is published yet. Stakeholders and farmers see nothing until you publish one (Runs tab).');

	const { baseline } = await publishedBaseline(page.request, project.id);

	// The owner's card: the run, who, the notice, the next update, and the way to the notice editor.
	await page.reload();
	await expect(card.getByRole('link', { name: 'Baseline' })).toBeVisible();
	await expect(card).toContainText(`by ${owner.displayName}`);
	await expect(card).toContainText('Advisory · 15 %');
	await expect(card).toContainText('Irrigate at night only.');
	await expect(card).toContainText('1 Mar 2022');
	await card.getByRole('link', { name: 'Change the notice or publish another run' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]run=${baseline}`));
	await expect(page.getByRole('region', { name: /^Publication/ }).getByRole('button', { name: 'Edit notice' })).toBeVisible();

	// The viewer's card is read-only.
	const v = viewer.page;
	await v.goto(`/projects/${project.id}`);
	const vCard = v.getByRole('region', { name: 'Published baseline' });
	await expect(vCard.getByRole('link', { name: 'Baseline' })).toBeVisible();
	await expect(vCard).toContainText('Advisory · 15 %');
	await expect(vCard.getByRole('link', { name: 'Change the notice or publish another run' })).toHaveCount(0);
});

test('the Runs tab opens on the newest run for an editor and on the published run for a viewer, and ?run= still wins', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Published baseline');
	const viewer = await signIn('Baseline viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const { baseline, middle, newest } = await publishedBaseline(page.request, project.id);

	// An editor keeps today's default on the Runs tab: the newest run.
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page).toHaveURL(new RegExp(`[?&]run=${newest}`));
	await expect(page.getByRole('heading', { level: 2, name: 'Newest' })).toBeVisible();

	// The viewer's Runs tab opens on the published run.
	const v = viewer.page;
	await v.goto(`/projects/${project.id}?tab=runs`);
	await expect(v).toHaveURL(new RegExp(`[?&]run=${baseline}`));
	await expect(v.getByRole('heading', { level: 2, name: 'Baseline' })).toBeVisible();
	// The published run offers no comparison with itself.
	await expect(v.getByRole('link', { name: 'Compare with published' })).toHaveCount(0);
	// An explicit ?run= still wins.
	await v.goto(`/projects/${project.id}?tab=runs&run=${middle}`);
	await expect(v.getByRole('heading', { level: 2, name: 'Middle' })).toBeVisible();
	await expect(v).toHaveURL(new RegExp(`[?&]run=${middle}`));

	// The project list says when it was published.
	await v.goto('/');
	await expect(v.getByRole('row').filter({ has: v.getByRole('rowheader', { name: 'Published baseline' }) })).toContainText(/published \d/);
});

test('compare starts from the published run, offers it against an explicit pair, and the Runs tab links a run to it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Published baseline compare');
	const { baseline, middle, newest } = await publishedBaseline(page.request, project.id);

	// Opened on the project: A is the published run (not the previous one), B the newest.
	await page.goto(`/compare?project=${project.id}`);
	const runA = page.getByRole('group', { name: 'Baseline', exact: true }).getByRole('combobox', { name: 'Run' });
	const runB = page.getByRole('group', { name: 'What-if 1', exact: true }).getByRole('combobox', { name: 'Run' });
	await expect(runA).toHaveValue(baseline);
	await expect(runB).toHaveValue(newest);
	await expect(runA.locator('option', { hasText: /^Baseline · .+ · published$/ })).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Compare with published' })).toHaveCount(0);

	// An explicit pair wins; the page offers the published run as A, and taking it keeps B.
	await page.goto(`/compare?a=${project.id}:${middle}&b=${project.id}:${newest}`);
	await expect(runA).toHaveValue(middle);
	await page.getByRole('button', { name: 'Compare with published' }).click();
	await expect(runA).toHaveValue(baseline);
	await expect(runB).toHaveValue(newest);
	await expect(page.getByRole('button', { name: 'Compare with published' })).toHaveCount(0);

	// From the Runs tab: the shown run against the published one.
	await page.goto(`/projects/${project.id}?tab=runs&run=${middle}`);
	await page.getByRole('link', { name: 'Compare with published' }).click();
	await expect(runA).toHaveValue(baseline);
	await expect(runB).toHaveValue(middle);
});
