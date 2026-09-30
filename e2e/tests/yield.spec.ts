// Firm yield and storage–yield curves (WP-3.6, docs/ui.md § Yield): on the
// Network tab's one-node view an editor queues a storage–yield curve for a
// dam, the background worker runs it (one tick that queues nothing of its
// own, so it never runs another spec's feed), and the panel shows the curve
// and its table, passing axe (WCAG 2.2 AA). A queued firm yield can be
// cancelled. A viewer sees the results with no run buttons. A job queued
// elsewhere (another tab, before a reload) is picked up and followed to the end.
// The panel's in-browser preview (the preview worker, WP-1.17) shows the firm
// yield at once, not stored, and agrees with the job's stored result.
import type { Page } from '@playwright/test';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { holdYieldJobRunning, releaseYieldJob } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';
import { openNodeForm } from '../support/network.ts';

async function openUpperFarm(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	return page.getByRole('region', { name: 'Yield of Upper farm' });
}

test('an editor runs a storage–yield curve for a dam, cancels a queued yield, and a viewer reads the result', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Yield');
	await createRun(page.request, project.id, 'Base');

	const panel = await openUpperFarm(page, project.id);
	await expect(panel.getByTestId('yield-empty')).toHaveText('No yield worked out for this dam on this run yet.');
	await expect(panel.getByText(/^Historical: these numbers replay/)).toBeVisible();

	// A queued firm yield, cancelled before any worker picks it up.
	await panel.getByRole('button', { name: 'Work out the yield' }).click();
	await expect(panel.getByTestId('yield-status')).toHaveText('Queued: waiting for the background worker.');
	await panel.getByRole('button', { name: 'Cancel' }).click();
	await expect(panel.getByTestId('yield-status')).toHaveText('Cancelled.');

	// The curve, run by the worker.
	await panel.getByLabel('Draft pattern').selectOption('demand');
	await panel.getByRole('button', { name: 'Storage–yield curve' }).click();
	await expect(panel.getByTestId('yield-status')).toHaveText('Queued: waiting for the background worker.');
	await runJobsTick({ schedule: false });
	const table = panel.getByTestId('yield-curve-table');
	await expect(table.getByRole('row')).toHaveCount(12); // the header and 11 capacities
	await expect(table.getByRole('rowheader').first()).toHaveText('0');
	await expect(table.getByRole('rowheader').nth(5)).toHaveText('150\u202f000 (this dam)');
	await expect(table.getByRole('rowheader').last()).toHaveText('300\u202f000');
	await expect(panel.getByRole('heading', { name: 'Storage–yield curve' })).toBeVisible();
	await expect(panel.getByText(/firm yield, this hydrological unit's demand shape, at 11 capacities/)).toBeVisible();
	await expect(panel.getByTestId('yield-status')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="yield-panel"]' });

	// A viewer: the same result, no buttons.
	const viewer = await signIn('Yield viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const theirs = await openUpperFarm(viewer.page, project.id);
	await expect(theirs.getByTestId('yield-curve-table').getByRole('row')).toHaveCount(12);
	await expect(theirs.getByRole('button', { name: 'Work out the yield' })).toHaveCount(0);
	await expect(theirs.getByRole('button', { name: 'Storage–yield curve' })).toHaveCount(0);
});

test('the panel follows a yield job it did not queue: running after a reload, then its result', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Yield elsewhere');
	const runId = await createRun(page.request, project.id, 'Base');
	const damId = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	// Queued as another tab would, then held mid-calculation.
	const res = await page.request.post(`${API_URL}/projects/${project.id}/yield`, { data: { nodeId: damId, runId, kind: 'firm' } });
	expect(res.status()).toBe(202);
	const { jobId } = (await res.json()) as { jobId: string };
	await holdYieldJobRunning(jobId, 40);

	await openUpperFarm(page, project.id);
	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	const panel = page.getByRole('region', { name: 'Yield of Upper farm' });
	await expect(panel.getByTestId('yield-status')).toHaveText('Running: 40 % done.');
	await expect(panel.getByRole('progressbar', { name: 'Yield calculation progress' })).toHaveAttribute('value', '40');
	await expect(panel.getByRole('button', { name: 'Work out the yield' })).toBeDisabled();
	await expect(panel.getByRole('button', { name: 'Cancel' })).toBeVisible();

	// The worker finishes it; the panel, still following it, shows the result.
	await releaseYieldJob(jobId);
	await runJobsTick({ schedule: false });
	await expect(panel.getByTestId('yield-firm')).toBeVisible();
	await expect(panel.getByTestId('yield-status')).toHaveCount(0);
	await expect(panel.getByRole('button', { name: 'Work out the yield' })).toBeEnabled();
});

test('the in-browser preview shows the firm yield at once, follows the pattern, and matches the stored job', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Yield preview');
	await createRun(page.request, project.id, 'Base');

	const panel = await openUpperFarm(page, project.id);
	const preview = panel.getByTestId('yield-preview');
	await expect(preview).toHaveAttribute('data-state', 'done');
	await expect(preview.getByRole('heading', { name: 'Preview Not stored' })).toBeVisible();
	const value = preview.getByTestId('yield-preview-value');
	await expect(value).toContainText('historical firm yield, constant draft');
	// Nothing stored by it.
	await expect(panel.getByTestId('yield-empty')).toBeVisible();
	const previewed = (await value.locator('strong').textContent())!;
	expect(previewed).toMatch(/ m³\/day$/);

	// The job, on the same run, pattern and assurance, stores the same number.
	await panel.getByRole('button', { name: 'Work out the yield' }).click();
	await expect(panel.getByTestId('yield-status')).toHaveText('Queued: waiting for the background worker.');
	await runJobsTick({ schedule: false });
	await expect(panel.getByTestId('yield-firm').locator('dd strong')).toHaveText(previewed);

	// Another pattern: a new preview for it.
	await panel.getByLabel('Draft pattern').selectOption('demand');
	await expect(value).toContainText("historical firm yield, this hydrological unit's demand shape");
	await expect(preview).toHaveAttribute('data-state', 'done');
	await expectNoViolations(page, { include: '[data-testid="yield-panel"]' });

	// A viewer previews too (nothing is stored), with no run buttons.
	const viewer = await signIn('Yield preview viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const theirs = await openUpperFarm(viewer.page, project.id);
	await expect(theirs.getByTestId('yield-preview')).toHaveAttribute('data-state', 'done');
	await expect(theirs.getByTestId('yield-preview-value').locator('strong')).toHaveText(previewed);
	await expect(theirs.getByRole('button', { name: 'Work out the yield' })).toHaveCount(0);
});

test("under a scenario the preview applies the scenario's ops, as the stored job does", async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Yield preview scenario');
	const runId = await createRun(page.request, project.id, 'Base');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	const res = await page.request.post(`${API_URL}/projects/${project.id}/scenarios`, {
		data: { name: 'Upper dam +20 %', baseRunId: runId, ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 180_000 }] }
	});
	expect(res.status()).toBe(201);
	const { scenario } = (await res.json()) as { scenario: { id: string } };

	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenario.id}`);
	await page.getByLabel('Dam', { exact: true }).selectOption({ label: 'Upper farm' });
	const panel = page.getByRole('region', { name: 'Yield of Upper farm' });
	const preview = panel.getByTestId('yield-preview');
	await expect(preview).toHaveAttribute('data-state', 'done');
	const previewed = (await preview.getByTestId('yield-preview-value').locator('strong').textContent())!;

	await panel.getByRole('button', { name: 'Work out the yield' }).click();
	await expect(panel.getByTestId('yield-status')).toHaveText('Queued: waiting for the background worker.');
	await runJobsTick({ schedule: false });
	// The stored result is on the raised dam, and the preview's number is its number.
	await expect(panel.getByTestId('yield-firm')).toContainText('180 000 m³');
	await expect(panel.getByTestId('yield-firm').locator('dd strong')).toHaveText(previewed);
});
