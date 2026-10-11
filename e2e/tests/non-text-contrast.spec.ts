// Non-text contrast and the dark theme (issue #521, round 4's dark-mode audit;
// docs/design/ui-playbook.md § 3 and § 5). axe checks text only, so a form
// control's outline and a chart's marks are held to 3:1 here by
// support/contrast.ts, in light and dark, on the screens where the audit found
// them under: the flow unit picker (Transfers, the node sheet) and the
// days-below-reserve bars' part years (River & reserve). Then the dark-only
// fixes, read from computed styles: the overlay tokens, a disabled main
// button, the map's controls, the help pictures; and a badge's case.
// Synthetic data only.
import { createProject, createRun, putModel, sampleModel, seedRunnableProject } from '../support/api.ts';
import { expectNonTextContrast, nonTextContrast } from '../support/contrast.ts';
import { expect, test } from '../support/fixtures.ts';
import { boundaryGeoJson, openMap, uploadThroughSheet } from '../support/map.ts';
import { openNodeForm } from '../support/network.ts';
import { openRiver, seedRiverProject } from '../support/river.ts';
import { openTransfers } from '../support/transfers.ts';

test('the guard reports a faint outline and a faded mark, and passes the fixed ones', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.goto('/login');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await page.evaluate(() => {
		const box = document.createElement('div');
		box.id = 'probe';
		box.style.background = '#1a1b1a';
		box.innerHTML =
			'<select aria-label="Faint" style="border:1px solid #333633;background:transparent"><option>a</option></select>' +
			'<select aria-label="Clear" style="border:1px solid #6b706b;background:transparent"><option>a</option></select>' +
			'<select aria-label="Off" disabled style="border:1px solid #333633;background:transparent"><option>a</option></select>' +
			'<svg role="img" aria-label="Bars" width="60" height="40"><rect class="faded" x="2" y="2" width="20" height="30" fill="#d95926" opacity="0.45"/>' +
			'<rect class="outlined" x="30" y="2" width="20" height="30" fill="#d95926" fill-opacity="0.3" stroke="#d95926" stroke-width="1.25"/></svg>';
		(document.querySelector('main') ?? document.body).append(box);
	});
	const found = await nonTextContrast(page, { within: '#probe' });
	expect(found.map((f) => `${f.kind} ${f.what.split(' ')[0]}`)).toEqual(['control select', 'mark rect.faded']);
	expect(found[0]!.what).toContain('"Faint"');
	expect(found[0]!.ratio).toBeLessThan(1.6);
	expect(found[1]!.ratio).toBeLessThan(2);
});

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} theme`, () => {
		test.use({ colorScheme });

		test('the flow unit pickers on Transfers and in the node sheet have a 3:1 outline', async ({ page, owner }) => {
			void owner;
			await page.setViewportSize({ width: 1440, height: 900 });
			const project = await createProject(page.request, `Contrast flow units ${colorScheme}`);
			await putModel(page.request, project.id, sampleModel());
			await openTransfers(page, project.id);
			await expect(page.getByLabel('Unit of transfer rates')).toBeVisible();
			await expectNonTextContrast(page, { within: 'main' });

			await page.goto(`/projects/${project.id}?tab=network`);
			const sheet = await openNodeForm(page, 'Upper farm');
			await expect(sheet.getByLabel('Unit of river to dam')).toBeVisible();
			await expectNonTextContrast(page, { within: 'dialog[open]' });
		});

		test('the days-below-reserve chart’s part years are outlined, at 3:1', async ({ page, owner }) => {
			void owner;
			await page.setViewportSize({ width: 1440, height: 900 });
			// 500 days from 1 Oct 2019: one whole water year and a part one.
			const id = await seedRiverProject(page.request, `Contrast reserve years ${colorScheme}`, 500);
			await createRun(page.request, id, 'Baseline');
			await openRiver(page, id);
			const years = page.getByRole('region', { name: 'Days below the reserve, each water year' });
			await expect(years.getByRole('img')).toBeVisible();
			const part = years.locator('rect[data-part]');
			await expect(part.first()).toBeAttached();
			await expect(part.first()).toHaveAttribute('stroke', /.+/);
			await expect(years.getByText(/Outlined bars, filled lightly, are part years/)).toBeVisible();
			await expectNonTextContrast(page, { within: '#res-reserve-years' });
		});
	});
}

test.describe('dark theme', () => {
	test.use({ colorScheme: 'dark' });

	test('a dialog stands off the page: a deeper backdrop, a stronger edge and shadow', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Contrast dialog');
		await page.goto(`/projects/${project.id}?tab=overview`);
		await page.getByRole('button', { name: 'Add data' }).first().click();
		const dialog = page.locator('dialog[open]');
		await expect(dialog).toBeVisible();
		const css = await dialog.evaluate((el) => {
			const root = getComputedStyle(document.documentElement);
			const probe = document.createElement('div');
			probe.style.color = root.getPropertyValue('--border-strong');
			document.body.append(probe);
			const strong = getComputedStyle(probe).color;
			probe.remove();
			return { border: getComputedStyle(el).borderTopColor, strong, shadow: getComputedStyle(el).boxShadow, backdrop: getComputedStyle(el, '::backdrop').backgroundColor };
		});
		expect(css.border).toBe(css.strong);
		expect(css.shadow).toContain('0.7');
		expect(css.backdrop).toBe('rgba(0, 0, 0, 0.6)');
	});

	test('a disabled main button is plainly off, not a faded accent', async ({ page, owner }) => {
		void owner;
		await page.goto('/account');
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		const css = await page.evaluate(() => {
			const b = document.createElement('button');
			b.className = 'btn btn-primary';
			b.disabled = true;
			b.textContent = 'Save';
			document.querySelector('main')!.append(b);
			const probe = document.createElement('div');
			probe.style.background = 'var(--surface-2)';
			document.body.append(probe);
			const out = { bg: getComputedStyle(b).backgroundColor, surface2: getComputedStyle(probe).backgroundColor, opacity: getComputedStyle(b).opacity };
			b.remove();
			probe.remove();
			return out;
		});
		expect(css.bg).toBe(css.surface2);
		expect(css.opacity).toBe('1');
	});

	test('the map’s zoom buttons take the app’s surface and focus ring', async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width: 1440, height: 900 });
		const project = await seedRunnableProject(page.request, 'Contrast map controls');
		await openMap(page, project.id);
		await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
		const group = page.locator('.maplibregl-ctrl-group').first();
		await expect(group).toBeVisible();
		const css = await group.evaluate((el) => {
			const probe = document.createElement('div');
			probe.style.background = 'var(--surface)';
			probe.style.color = 'var(--focus)';
			document.body.append(probe);
			const surface = getComputedStyle(probe).backgroundColor;
			const focus = getComputedStyle(probe).color;
			probe.remove();
			const icon = el.querySelector('.maplibregl-ctrl-icon')!;
			return { bg: getComputedStyle(el).backgroundColor, surface, focus, filter: getComputedStyle(icon).filter };
		});
		expect(css.bg).toBe(css.surface);
		expect(css.filter).toBe('invert(1)');
		await page.getByRole('button', { name: 'Zoom in' }).focus();
		await page.keyboard.press('Shift+Tab');
		await page.keyboard.press('Tab');
		const ring = await page.getByRole('button', { name: 'Zoom in' }).evaluate((el) => ({ outline: getComputedStyle(el).outlineColor, style: getComputedStyle(el).outlineStyle, shadow: getComputedStyle(el).boxShadow }));
		expect(ring).toEqual({ outline: css.focus, style: 'solid', shadow: 'none' });
	});

	test('the help pictures are dimmed and framed on the dark page', async ({ page, owner }) => {
		void owner;
		await page.goto('/help');
		const img = page.getByRole('img', { name: /An illustrated catchment/ });
		await expect(img).toBeVisible();
		expect(await img.evaluate((el) => getComputedStyle(el).filter)).toBe('brightness(0.82) contrast(1.05)');
	});
});

test('a badge starts with a capital and no other word is capitalised', async ({ page, owner }) => {
	void owner;
	await page.goto('/account');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	const css = await page.evaluate(() => {
		const b = document.createElement('span');
		b.className = 'badge';
		b.textContent = 'dam settings changed since the run';
		document.querySelector('main')!.append(b);
		const out = { whole: getComputedStyle(b).textTransform, first: getComputedStyle(b, '::first-letter').textTransform, radius: getComputedStyle(b).borderTopLeftRadius };
		b.remove();
		return out;
	});
	expect(css).toEqual({ whole: 'none', first: 'uppercase', radius: '9.8px' });
});
