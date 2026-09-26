// "Check reproduction" (roadmap WP-3.1, docs/ui.md § Runs): a run re-run on
// the server from its stored inputs comes out identical on the same engine,
// and a viewer can check it too.
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('a run re-run from its stored inputs is identical, for an editor and a viewer', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Reproduce');
	const run = await createRun(page.request, project.id, 'Stored inputs');

	await page.goto(`/projects/${project.id}?tab=runs&run=${run}`);
	await expect(page.getByRole('heading', { level: 2, name: 'Stored inputs' })).toBeVisible();
	const panel = page.getByTestId('reproduce');
	await expect(panel.getByRole('heading', { name: 'Reproduction' })).toBeVisible();
	// A run made now stored its inputs, so the list doesn't tag it.
	const list = page.getByRole('region', { name: 'Runs', exact: true });
	await expect(list.getByText('Inputs not stored', { exact: true })).toHaveCount(0);

	await panel.getByRole('button', { name: 'Check reproduction' }).click();
	await expect(panel.getByTestId('reproduce-result')).toHaveText(
		/^Identical: re-run from its stored inputs, every result and daily output matches \(engine \d+\.\d+\.\d+\)\.$/
	);
	await expect(panel.getByRole('list', { name: 'Differences' })).toHaveCount(0);

	const viewer = await signIn('Reproduce viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=runs&run=${run}`);
	const seen = viewer.page.getByTestId('reproduce');
	await seen.getByRole('button', { name: 'Check reproduction' }).click();
	await expect(seen.getByTestId('reproduce-result')).toHaveText(/^Identical: /);
});
