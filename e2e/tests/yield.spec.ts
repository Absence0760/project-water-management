// Firm yield and storage–yield curves (WP-3.6, docs/ui.md § Yield): on the
// Network tab's one-node view an editor queues a storage–yield curve for a
// dam, the background worker runs it (one tick that queues nothing of its
// own, so it never runs another spec's feed), and the panel shows the curve
// and its table, passing axe (WCAG 2.2 AA). A queued firm yield can be
// cancelled. A viewer sees the results with no run buttons. A job queued
// elsewhere (another tab, before a reload) is picked up and followed to the end.
// The panel's in-browser preview (the preview worker, WP-1.17) shows the firm
// yield at once, not stored, and agrees with the job's stored result.
// A proposed dam (the hydrologist's report, 2026-11-09): on a unit with no
// dam, no crops and nothing routed into a dam, the panel says why there is no
// yield, then sizes a dam with a curve to an entered capacity drafted to
// another unit's irrigation demand, and flags a stored result worked out
// before the scenario's latest changes.
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
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
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
	await runJobsTick({ projects: [project.id], schedule: false });
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
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	const panel = page.getByRole('region', { name: 'Yield of Upper farm' });
	await expect(panel.getByTestId('yield-status')).toHaveText('Running: 40 % done.');
	await expect(panel.getByRole('progressbar', { name: 'Yield calculation progress' })).toHaveAttribute('value', '40');
	await expect(panel.getByRole('button', { name: 'Work out the yield' })).toBeDisabled();
	await expect(panel.getByRole('button', { name: 'Cancel' })).toBeVisible();

	// The worker finishes it; the panel, still following it, shows the result.
	await releaseYieldJob(jobId);
	await runJobsTick({ projects: [project.id], schedule: false });
	await expect(panel.getByTestId('yield-firm')).toBeVisible();
	await expect(panel.getByTestId('yield-status')).toHaveCount(0);
	await expect(panel.getByRole('button', { name: 'Work out the yield' })).toBeEnabled();
});

test('the in-browser preview shows the firm yield at once, follows the pattern, and matches the stored job', async ({ page, owner, signIn, fetchRoute }) => {
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
	await runJobsTick({ projects: [project.id], schedule: false });
	await expect(panel.getByTestId('yield-firm').locator('dd strong')).toHaveText(previewed);
	// The preview names its engine: here the backend's too, so no note.
	const worked = (await panel.getByTestId('yield-firm').getByText(/\(engine [\d.]+\)$/).textContent())!;
	const engine = /\(engine ([\d.]+)\)$/.exec(worked)![1];
	await expect(preview.getByTestId('yield-preview-engine')).toHaveText(`engine ${engine}`);
	await expect(preview.getByTestId('yield-engine-differs')).toHaveCount(0);

	// Another pattern: a new preview for it.
	await panel.getByLabel('Draft pattern').selectOption('demand');
	await expect(value).toContainText("historical firm yield, this hydrological unit's demand shape");
	await expect(preview).toHaveAttribute('data-state', 'done');
	await expectNoViolations(page, { include: '[data-testid="yield-panel"]' });

	// A viewer previews too (nothing is stored), with no run buttons.
	const viewer = await signIn('Yield preview viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	// As if the backend were released on another engine than this web build:
	// the stored result says so, and the preview notes the difference.
	await fetchRoute(
		viewer.page,
		(url) => url.pathname === `/projects/${project.id}/yield`,
		async (route) => {
			if (route.request().method() !== 'GET') return route.fallback();
			const response = await route.fetch();
			const body = (await response.json()) as { results: { engineVersion: string }[] };
			await route.fulfill({ response, json: { results: body.results.map((r) => ({ ...r, engineVersion: '0.9.0' })) } });
		}
	);
	const theirs = await openUpperFarm(viewer.page, project.id);
	await expect(theirs.getByTestId('yield-preview')).toHaveAttribute('data-state', 'done');
	await expect(theirs.getByTestId('yield-preview-value').locator('strong')).toHaveText(previewed);
	await expect(theirs.getByTestId('yield-firm')).toContainText('(engine 0.9.0)');
	await expect(theirs.getByTestId('yield-engine-differs')).toHaveText(
		`The stored yield below was worked out on engine 0.9.0 and this preview on engine ${engine}, so the two can differ by what changed between those versions.`
	);
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
	await runJobsTick({ projects: [project.id], schedule: false });
	// The stored result is on the raised dam, and the preview's number is its number.
	await expect(panel.getByTestId('yield-firm')).toContainText('180 000 m³');
	await expect(panel.getByTestId('yield-firm').locator('dd strong')).toHaveText(previewed);
});

test("a proposed dam: no dam and no inflow said plainly, then a sizing curve and a yield drafted to another unit's demand", async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Yield proposed dam');
	const runId = await createRun(page.request, project.id, 'Base');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	const crop = project.model.crops[0]!.id;
	// Upper farm as a unit with no dam yet: no crops, no capacity, nothing routed into a dam.
	const asProposed = [
		{ op: 'cropArea.set', nodeId: upper, cropId: crop, areaM2: 0 },
		{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 0 },
		{ op: 'node.set', nodeId: upper, field: 'pctRunoffToDam', value: 0 }
	];
	const res = await page.request.post(`${API_URL}/projects/${project.id}/scenarios`, { data: { name: 'Upper dam proposed', baseRunId: runId, ops: asProposed } });
	expect(res.status()).toBe(201);
	const { scenario } = (await res.json()) as { scenario: { id: string } };
	const setOps = async (ops: unknown[]) => expect((await page.request.patch(`${API_URL}/projects/${project.id}/scenarios/${scenario.id}`, { data: { ops } })).status()).toBe(200);
	const open = async (label = 'Upper farm (no dam)') => {
		await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenario.id}`);
		await page.getByLabel('Dam', { exact: true }).selectOption({ label });
		return page.getByRole('region', { name: 'Yield of Upper farm' });
	};

	let panel = await open();
	await expect(panel.getByTestId('yield-no-dam')).toContainText('Upper farm has no dam in this model (capacity 0 m³). In a scenario, add a change that sets its dam capacity, then work out the yield.');
	await expect(panel.getByTestId('yield-no-inflow')).toHaveText(
		/^Upper farm's dam receives no water in this model: Runoff to dam is 0 % and Upstream inflow to dam is 0 %\. In the scenario, set the share of its runoff \(and of the river above it\) that the dam catches\./
	);
	await expect(panel.getByRole('button', { name: 'Work out the yield' })).toHaveCount(0);
	await expect(panel.getByRole('button', { name: 'Storage–yield curve' })).toBeDisabled();
	await expect(panel.getByTestId('yield-preview')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="yield-panel"]' });
	// The link opens Add a change on that unit's field.
	await panel.getByRole('button', { name: 'Set its runoff to dam in this scenario' }).click();
	await expect(page.locator('#op-field')).toHaveValue('pctRunoffToDam');
	await expect(page.locator('#op-value')).toBeFocused();

	// Its runoff now goes to where the dam would be: a sizing curve, to an entered maximum, on Lower farm's demand shape.
	await setOps([...asProposed.slice(0, 2), { op: 'node.set', nodeId: upper, field: 'pctRunoffToDam', value: 1 }]);
	panel = await open();
	await expect(panel.getByTestId('yield-no-inflow')).toHaveCount(0);
	await expect(panel.getByTestId('yield-no-dam')).toBeVisible();
	const pattern = panel.getByLabel('Draft pattern');
	await expect(pattern.locator('option[value="demand"]')).toBeDisabled();
	await expect(pattern.locator('option[value="demand"]')).toHaveText(/\(it has none: no crops or demand objects\)$/);
	await pattern.selectOption({ label: "Lower farm's irrigation demand, by month" });
	const curve = panel.getByRole('button', { name: 'Storage–yield curve' });
	await expect(curve).toBeDisabled();
	await panel.getByLabel('Curve up to (m³)').fill('300 000');
	await curve.click();
	await expect(panel.getByTestId('yield-status')).toHaveText('Queued: waiting for the background worker.');
	await runJobsTick({ projects: [project.id], schedule: false });
	const table = panel.getByTestId('yield-curve-table');
	await expect(table.getByRole('row')).toHaveCount(12);
	await expect(table.getByRole('rowheader').last()).toHaveText('300\u202f000');
	await expect(table.getByText('(this dam)')).toHaveCount(0);
	await expect(panel.getByTestId('yield-curve-range')).toHaveText(
		"firm yield, Lower farm's irrigation demand shape, at 11 capacities from 0 to 300\u202f000 m³ (sizing a proposed dam: the unit has no dam in this model)."
	);
	await expectNoViolations(page, { include: '[data-testid="yield-panel"]' });

	// A capacity set in the scenario: the yield itself, on the same shape, above 0; the curve is now from earlier changes.
	await setOps([asProposed[0], { op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 120_000 }, { op: 'node.set', nodeId: upper, field: 'pctRunoffToDam', value: 1 }]);
	panel = await open('Upper farm');
	await expect(panel.getByTestId('yield-no-dam')).toHaveCount(0);
	await expect(panel.getByTestId('yield-curve-stale')).toHaveText("Worked out before the scenario's latest changes: work it out again.");
	await panel.getByLabel('Draft pattern').selectOption({ label: "Lower farm's irrigation demand, by month" });
	await expect(panel.getByTestId('yield-preview')).toHaveAttribute('data-state', 'done');
	await expect(panel.getByTestId('yield-preview-value')).toContainText("historical firm yield, Lower farm's irrigation demand shape");
	await panel.getByRole('button', { name: 'Work out the yield' }).click();
	await runJobsTick({ projects: [project.id], schedule: false });
	await expect(panel.getByTestId('yield-firm-pattern')).toHaveText("Lower farm's irrigation demand shape");
	await expect(panel.getByTestId('yield-firm')).toContainText('120\u202f000 m³');
	await expect(panel.getByTestId('yield-firm-stale')).toHaveCount(0);
	// The search starts the dam half full (engine 1.117.0), whatever its own initial storage.
	await expect(panel.getByTestId('yield-firm-start')).toHaveText('half full');
	expect(Number((await panel.getByTestId('yield-firm').locator('dd strong').textContent())!.replace(/[^\d.]/g, ''))).toBeGreaterThan(0);
});
