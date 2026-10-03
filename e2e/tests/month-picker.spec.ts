// The month picker (common/MonthPicker.svelte), as Settings → WR2012 check's
// dry-season months shows it: every toggle at least 24 × 24 px (WCAG 2.5.8),
// the twelve wrapping to rows of six in a narrow column, and the All / None
// button named for its picker ("Dry-season months: all months").
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';

test('the dry-season month toggles are at least 24 px and the All button names its months', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Month picker');
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto(`/projects/${project.id}?tab=settings`);

	const section = page.getByRole('region', { name: /^WR2012 check/ });
	await section.getByLabel('Compare runs with WR2012 naturalised flow').check();
	await section.getByLabel('Choose the dry-season months').check();
	const picker = section.getByRole('group', { name: 'Dry-season months', exact: true });
	const toggles = picker.getByRole('checkbox');
	await expect(toggles).toHaveCount(12);

	const sizes = async () => {
		for (const box of await Promise.all((await toggles.all()).map((t) => t.boundingBox()))) {
			expect(box!.width).toBeGreaterThanOrEqual(24);
			expect(box!.height).toBeGreaterThanOrEqual(24);
		}
	};
	await sizes();

	// Named for what it selects, and for the picker it belongs to; the visible words are in the name.
	await picker.getByRole('button', { name: 'Dry-season months: all months' }).click();
	await expect(toggles.filter({ checked: true })).toHaveCount(12);
	await expect(picker.getByRole('button', { name: 'Dry-season months: no months' })).toHaveText('No months');
	await picker.getByRole('button', { name: 'Dry-season months: no months' }).click();
	await expect(toggles.filter({ checked: true })).toHaveCount(0);

	// A phone: two rows of six, still at least 24 px, nothing scrolls sideways.
	await resizeTo(page, { width: 360, height: 800 });
	await sizes();
	const oct = await picker.getByRole('checkbox', { name: 'Oct' }).boundingBox();
	const apr = await picker.getByRole('checkbox', { name: 'Apr' }).boundingBox();
	const mar = await picker.getByRole('checkbox', { name: 'Mar' }).boundingBox();
	expect(apr!.y).toBeGreaterThan(oct!.y);
	expect(mar!.y).toBe(oct!.y);
	await expectNoSidewaysScroll(page);
});
