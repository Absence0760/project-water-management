// Run comparison's per-node daily series overlay (issue #8,
// docs/run-comparison.md § Daily series): pick a node matched across the two
// runs and one of its series, chart A against B with B − A underneath, and
// explain a node only one run has. Axe-scanned in both themes.
import type { Page } from '@playwright/test';
import { copyProject, createRun, putModel, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

const overlay = (page: Page) => page.getByRole('region', { name: 'Daily series' });

/** Run A on the sample model; run B after a bigger Upper dam, a renamed Lower farm and a new farm. */
async function seedPair(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	const runA = await createRun(page.request, project.id, 'Baseline');
	const [gauge, upper, lower] = project.model.nodes as { id: string }[];
	const model = structuredClone(project.model);
	model.nodes[1] = { ...model.nodes[1], damCapacityM3: 400_000 };
	model.nodes[2] = { ...model.nodes[2], name: 'Lower farm east' };
	model.nodes.push({ ...model.nodes[2], id: crypto.randomUUID(), name: 'New farm', sortOrder: 4, damCapacityM3: 0 });
	await putModel(page.request, project.id, model);
	const runB = await createRun(page.request, project.id, 'Bigger dam');
	return { project, runA, runB, gauge: gauge!.id, upper: upper!.id, lower: lower!.id };
}

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} theme`, () => {
		test.use({ colorScheme });

		test("overlays a node's outflow for two runs, with the difference, and names a node only one run has", async ({ page, owner }) => {
			void owner;
			const { project, runA, runB } = await seedPair(page, `Overlay ${colorScheme}`);
			await page.goto(`/compare?a=${project.id}:${runA}&b=${project.id}:${runB}`);
			const panel = overlay(page);

			// Opens on the catchment's simulated outflow.
			const node = panel.getByLabel('Node');
			const series = panel.getByLabel('Series');
			await expect(node).toHaveValue('catchment');
			await expect(series).toHaveValue('simulated_outflow');
			await expect(panel.getByRole('img', { name: /^Catchment \(outflow gauge\) · Simulated outflow · run A vs run B: line chart of A · Baseline, B · Bigger dam, in m³\/s, \d+ \w+ \d{4} to \d+ \w+ \d{4}$/ })).toBeVisible();

			// Nodes are matched by id and listed in network order; the rename is named.
			await expect(node.getByRole('option')).toHaveText([
				'Catchment (outflow gauge)',
				'Outflow gauge',
				'Upper farm',
				'Lower farm east (was Lower farm)'
			]);

			// The farm's outflow: the series kind follows to the node that has it.
			await node.selectOption({ label: 'Upper farm' });
			await expect(series).toHaveValue('outflow');
			await expect(panel.getByRole('img', { name: /^Upper farm · Outflow · run A vs run B: line chart/ }).locator('canvas')).toBeVisible();
			await expect(panel.getByRole('img', { name: /^Upper farm · Outflow · difference B − A: line chart of B − A, in m³\/s, \d+ \w+ \d{4} to \d+ \w+ \d{4}$/ }).locator('canvas')).toBeVisible();
			const summary = panel.getByTestId('overlay-summary');
			await expect(summary).toHaveText(
				/^Over the \d+ days both runs have: mean A [\d.\u202f]+, mean B [\d.\u202f]+, B − A [−+]?[\d.\u202f]+ m³\/s\. B is higher on \d+ days? and lower on \d+ days?; the largest change is [−+][\d.\u202f]+ m³\/s on \d{4}-\d\d-\d\d\.$/
			);

			// The flow-unit switch rescales the overlay and its read-out.
			await panel.getByRole('button', { name: 'm³/day', exact: true }).click();
			await expect(summary).toContainText(' m³/day.');
			await expect(panel.getByRole('img', { name: /^Upper farm · Outflow · run A vs run B/ })).toBeVisible();

			// A non-flow series has no unit switch.
			await series.selectOption('dam_storage');
			await expect(summary).toContainText(' m³.');
			await expect(panel.getByRole('button', { name: 'm³/day', exact: true })).toHaveCount(0);

			// The farm added for run B can't be overlaid, and says so.
			await expect(panel.getByTestId('overlay-unmatched')).toHaveText('Only in run B, so nothing to overlay: New farm.');

			await expectNoViolations(page);
		});
	});
}

test('matches nodes across a project copy by name', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Overlay original');
	const runA = await createRun(page.request, project.id, 'Original');
	const copy = await copyProject(page.request, project.id, 'Overlay copy');
	const runB = await createRun(page.request, copy, 'Copy');
	await page.goto(`/compare?a=${project.id}:${runA}&b=${copy}:${runB}`);
	const panel = overlay(page);
	await expect(panel.getByLabel('Node').getByRole('option')).toHaveText(['Catchment (outflow gauge)', 'Outflow gauge', 'Upper farm', 'Lower farm']);
	await panel.getByLabel('Node').selectOption({ label: 'Lower farm' });
	await expect(panel.getByRole('img', { name: /^Lower farm · Outflow · run A vs run B: line chart of A · Original \(Overlay original\), B · Copy \(Overlay copy\), in m³\/s, \d+ \w+ \d{4} to \d+ \w+ \d{4}$/ })).toBeVisible();
	// Same inputs, same results: B − A is zero on every day.
	await expect(panel.getByTestId('overlay-summary')).toHaveText(
		/^Over the \d+ days both runs have: mean A [\d.\u202f]+, mean B [\d.\u202f]+, B − A 0 m³\/s\. The two runs are identical on every one of those days\.$/
	);
	await expect(panel.getByTestId('overlay-unmatched')).toHaveCount(0);
});
