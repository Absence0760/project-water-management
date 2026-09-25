// Pinned runs (015_run_pinned, docs/ui.md § Pinned runs): an editor pins a
// baseline from the Runs list; it survives 20 newer runs while an unpinned run
// of the same age is trimmed, it can't be deleted until unpinned, the compare
// picker marks it, the pin ceiling is refused with the server's message, and a
// viewer sees the pin but can't change it.
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

test('a pinned baseline survives the 20-run cap; an editor pins and unpins it, a viewer only sees it', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Pinned runs');
	await createRun(page.request, project.id, 'Baseline');
	await createRun(page.request, project.id, 'Scratch');

	await page.goto(`/projects/${project.id}?tab=runs`);
	const list = page.getByRole('region', { name: 'Runs', exact: true });
	const row = (label: string) => list.getByRole('listitem').filter({ has: page.getByRole('button', { name: new RegExp(`^${label}`) }) });
	const pinBaseline = row('Baseline').getByRole('button', { name: /^Pin run Baseline/ });
	await expect(pinBaseline).toHaveAttribute('aria-pressed', 'false');
	await expect(row('Baseline').getByRole('button', { name: /^Delete run/ })).toBeVisible();

	await pinBaseline.click();
	await expect(pinBaseline).toHaveAttribute('aria-pressed', 'true');
	await expect(row('Baseline').getByText('Pinned', { exact: true })).toBeVisible();
	// Pinned runs can't be deleted until unpinned.
	await expect(row('Baseline').getByRole('button', { name: /^Delete run/ })).toHaveCount(0);

	// RUNS_KEPT_PER_PROJECT is 20 (backend/.env.development): 20 newer runs push out Scratch, not the pinned Baseline.
	// Sent together: the full local suite shares one API process, and 20 runs awaited one by one each
	// queue behind the other workers' heavy runs (this setup alone reached the 30 s timeout). Scratch was
	// made first, so it stays the oldest unpinned run whatever order these finish in; `newer` keeps label order.
	const newer = await Promise.all(Array.from({ length: 20 }, (_, i) => createRun(page.request, project.id, `Newer ${String(i + 1).padStart(2, '0')}`)));
	await page.reload();
	await expect(row('Newer 20')).toBeVisible();
	await expect(row('Baseline').getByText('Pinned', { exact: true })).toBeVisible();
	await expect(row('Scratch')).toHaveCount(0);
	await expect(list.getByRole('listitem')).toHaveCount(21);

	// The compare picker marks it (read only).
	await page.goto(`/compare?project=${project.id}`);
	await expect(page.getByRole('combobox', { name: 'Run' }).first().locator('option', { hasText: /^Baseline · .+ · pinned$/ })).toHaveCount(1);
	await expect(page.getByRole('combobox', { name: 'Run' }).first().locator('option', { hasText: /pinned$/ })).toHaveCount(1);

	// At the ceiling of 10 pinned runs, one more is refused with the server's reason.
	for (const id of newer.slice(0, 9)) {
		const res = await page.request.patch(`${API_URL}/projects/${project.id}/runs/${id}`, { data: { pinned: true } });
		expect(res.status()).toBe(200);
	}
	await page.goto(`/projects/${project.id}?tab=runs`);
	await row('Newer 20').getByRole('button', { name: /^Pin run Newer 20/ }).click();
	await expect(page.getByRole('alert')).toHaveText('this project already has 10 pinned runs, the most it can keep; unpin one first');
	await expect(row('Newer 20').getByRole('button', { name: /^Pin run Newer 20/ })).toHaveAttribute('aria-pressed', 'false');

	// A viewer sees the pin but has no toggle.
	const viewer = await signIn('Pinned viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=runs`);
	const seen = viewer.page.getByRole('region', { name: 'Runs', exact: true });
	await expect(seen.getByRole('listitem').filter({ hasText: /^Baseline/ }).getByText('Pinned', { exact: true })).toBeVisible();
	await expect(seen.getByRole('button', { name: /^Pin run/ })).toHaveCount(0);

	// Unpinned, it can be deleted again.
	await row('Baseline').getByRole('button', { name: /^Pin run Baseline/ }).click();
	await expect(row('Baseline').getByRole('button', { name: /^Pin run Baseline/ })).toHaveAttribute('aria-pressed', 'false');
	await expect(row('Baseline').getByText('Pinned', { exact: true })).toHaveCount(0);
	await expect(row('Baseline').getByRole('button', { name: /^Delete run/ })).toBeVisible();
});
