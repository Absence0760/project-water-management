// The known-defect flag (issue #103, docs/legal/known-defect-procedure.md,
// docs/ui.md § Runs): a run made by an engine with a known bug
// (docs/engine-errata.md) is tagged "May be affected" in the run list, and
// its header's badge opens its validation statement on the errata table,
// whether pressed or loaded as a link; a run on the current engine says
// nothing. No accessibility violation and no sideways scroll with the flag
// showing, wide or on a phone.
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { plantRunEngine } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';

test('a run from an engine with a known bug is flagged in the list and its header, whose badge opens the errata; a current run is not', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Known bug');
	const old = await createRun(page.request, project.id, 'Old engine');
	const current = await createRun(page.request, project.id, 'Current engine');
	// Engine 0.10.0 had ER-2, ER-4 and ER-5 among others (docs/engine-errata.md): the big case, many errata.
	await plantRunEngine(old, '0.10.0');
	// The API names them (from the engine's list, so a new erratum doesn't break this); ER-2 is one.
	const runs = (await (await page.request.get(`${API_URL}/projects/${project.id}/runs`)).json()).runs as { id: string; errata: string[] }[];
	const ids = runs.find((r) => r.id === old)!.errata;
	expect(ids).toContain('ER-2');
	expect(runs.find((r) => r.id === current)!.errata).toEqual([]);

	await page.goto(`/projects/${project.id}?tab=runs&run=${old}`);
	await expect(page.getByRole('heading', { level: 2, name: 'Old engine' })).toBeVisible();
	const list = page.getByRole('region', { name: 'Runs', exact: true });
	await expect(list.getByRole('listitem').filter({ hasText: 'Old engine' }).getByText('May be affected', { exact: true })).toBeVisible();
	await expect(list.getByRole('listitem').filter({ hasText: 'Current engine' }).getByText('May be affected', { exact: true })).toHaveCount(0);

	// The badge: a sentence (not the site badge's capitalised words), counting the errata.
	const badge = page.getByTestId('run-errata');
	await expect(badge).toHaveText(`May be affected by ${ids.length} known bugs`);
	await expect(badge).toHaveCSS('text-transform', 'none');
	// Pressing it opens the validation statement, shut until then, on the errata table.
	const panel = page.locator('#res-validation').getByRole('region', { name: 'Validation statement' });
	await expect(panel.getByRole('rowheader', { name: 'ER-2', exact: true })).toHaveCount(0);
	await badge.click();
	await expect(page).toHaveURL(/#res-validation$/);
	await expect(panel.getByRole('heading', { level: 4, name: 'Errata of engine 0.10.0' })).toBeVisible();
	await expect(panel.getByRole('rowheader', { name: 'ER-2', exact: true })).toBeVisible();
	await expectNoViolations(page);

	// Loaded as a link, it lands open too.
	await page.goto(`/projects/${project.id}?tab=runs&run=${old}#res-validation`);
	await expect(page.getByRole('heading', { level: 2, name: 'Old engine' })).toBeVisible();
	await expect(panel.getByRole('rowheader', { name: 'ER-2', exact: true })).toBeVisible();

	// A phone: the badge wraps as text within the header, nothing sideways.
	await resizeTo(page, { width: 390, height: 844 });
	await expect(page.getByTestId('run-errata')).toBeVisible();
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);

	await page.goto(`/projects/${project.id}?tab=runs&run=${current}`);
	await expect(page.getByRole('heading', { level: 2, name: 'Current engine' })).toBeVisible();
	await expect(page.getByTestId('run-errata')).toHaveCount(0);
});
