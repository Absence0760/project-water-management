// The compact chart pattern (docs/design/ui-playbook.md § 3, "Label every
// chart"; charts/Sparkline.svelte): a sparkline names its quantity and span,
// shows its first and last x label, marks its peak (or low) with the value,
// reads out the point under the pointer (and, from the keyboard, the point a
// slider over the line steps to) and carries the numbers in its accessible
// name. Its two uses: the Crops list's crop factors (the caption
// once, over the column) and the Dams cards' storage. Synthetic data only.
import type { Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, putModel, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const ORCHARD = 'Orchard: Crop factor by month, Oct–Sep. max 0.80 in Dec; Oct 0.60, Nov 0.70, Dec 0.80, Jan 0.80, Feb 0.80, Mar 0.70, Apr 0.60, May 0.50, Jun 0.40, Jul 0.40, Aug 0.50, Sep 0.60.';

const ticks = (spark: Locator) => spark.locator('.ticks > span');
const read = (spark: Locator) => spark.getByTestId('sparkline-read');

/** Moves the pointer over the plot at a fraction of its width, halfway down. */
async function pointAt(page: Page, spark: Locator, fx: number) {
	const box = (await spark.locator('.plot').boundingBox())!;
	await page.mouse.move(box.x + box.width * fx, box.y + box.height / 2);
}

test('a crop row: the column’s caption, Oct and Sep at the ends, the highest factor marked, a read-out on hover and from the keyboard', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Crop sparkline');
	await page.goto(`/projects/${project.id}?tab=crops`);

	const caption = page.getByTestId('crop-spark-caption').locator('.c-spark');
	await expect(caption).toHaveText('Crop factor by month, Oct–Sep');
	const orchard = page.getByTestId('crop-row').filter({ hasText: 'Orchard' });
	const spark = orchard.getByTestId('sparkline');
	await expect(spark.getByRole('img', { name: ORCHARD, exact: true })).toBeVisible();
	// The caption sits over the sparklines' column.
	const [c, s] = [(await caption.boundingBox())!, (await spark.boundingBox())!];
	expect(Math.abs(c.x - s.x)).toBeLessThanOrEqual(1);
	expect(Math.abs(c.width - s.width)).toBeLessThanOrEqual(1);

	await expect(ticks(spark)).toHaveText(['Oct', 'max 0.80', 'Sep']);
	// The dot marks the first highest factor, Dec (index 2 of 12), on the line.
	const plot = (await spark.locator('.plot').boundingBox())!;
	const dot = (await spark.locator('.dot').boundingBox())!;
	expect(Math.abs(dot.x + dot.width / 2 - plot.x - (plot.width * 2) / 11)).toBeLessThanOrEqual(1);

	// Pointing reads out the nearest month; leaving goes back to the mark.
	await pointAt(page, spark, 9 / 11);
	await expect(read(spark)).toHaveText('Jul 0.40');
	const moved = (await spark.locator('.dot').boundingBox())!;
	expect(Math.abs(moved.x + moved.width / 2 - plot.x - (plot.width * 9) / 11)).toBeLessThanOrEqual(1);
	await page.mouse.move(0, 0);
	await expect(read(spark)).toHaveText('max 0.80');

	// The keyboard reads it out too: a slider over the line, starting at the mark; the keys step it and the dot.
	const slider = spark.getByRole('slider', { name: 'Orchard: Crop factor by month, Oct–Sep, read-out', exact: true });
	await expect(slider).toHaveAttribute('tabindex', '0');
	await slider.focus();
	await expect(read(spark)).toHaveText('Dec 0.80');
	await expect(slider).toHaveAttribute('aria-valuetext', 'Dec 0.80');
	await page.keyboard.press('ArrowRight');
	await expect(read(spark)).toHaveText('Jan 0.80');
	await expect(slider).toHaveAttribute('aria-valuenow', '3');
	await page.keyboard.press('End');
	await expect(read(spark)).toHaveText('Sep 0.60');
	await page.keyboard.press('Home');
	await expect(read(spark)).toHaveText('Oct 0.60');
	await page.keyboard.press('ArrowLeft'); // stops at the end
	await expect(slider).toHaveAttribute('aria-valuetext', 'Oct 0.60');
	const first = (await spark.locator('.dot').boundingBox())!;
	expect(Math.abs(first.x + first.width / 2 - plot.x)).toBeLessThanOrEqual(1);
	// Leaving it goes back to the mark.
	await slider.blur();
	await expect(read(spark)).toHaveText('max 0.80');
});

test('the crop list at phone width: the caption still over the column, every row’s ticks on one line', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Crop sparklines phone');
	const m = project.model;
	// Thirty crops with long names and a factor above 1.0 on every third, so some rows carry the flag and others don't.
	m.crops = Array.from({ length: 30 }, (_, i) => ({
		id: crypto.randomUUID(),
		name: `Crop ${i + 1} ${i % 4 === 0 ? 'late-season citrus on the lower terraces' : ''}`.trim(),
		cropFactor: Array.from({ length: 12 }, (_, k) => (i % 3 === 0 && k === 3 ? 1.1 : 0.3 + ((k + i) % 6) / 10))
	}));
	m.cropAreas = m.crops.map((c, i) => ({ nodeId: m.nodes[1 + (i % 2)]!.id as string, cropId: c.id, areaM2: 10_000 * (31 - i) }));
	await putModel(page.request, project.id, m);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${project.id}?tab=crops`);
	await expect(page.getByTestId('crop-row')).toHaveCount(30);
	await page.getByRole('button', { name: 'Show all 30 crops' }).click();

	const caption = (await page.getByTestId('crop-spark-caption').locator('.c-spark').boundingBox())!;
	const sparks = page.getByTestId('crop-row').getByTestId('sparkline');
	await expect(sparks).toHaveCount(30);
	const boxes = await sparks.evaluateAll((els) =>
		els.map((el) => {
			const r = el.getBoundingClientRect();
			const t = el.querySelector('.ticks')!.getBoundingClientRect();
			const read = el.querySelector('.read')!;
			return { x: r.x, w: r.width, ticksH: t.height, fontPx: parseFloat(getComputedStyle(el.querySelector('.ticks')!).fontSize), cut: read.scrollWidth > read.clientWidth };
		})
	);
	for (const b of boxes) {
		expect(Math.abs(b.x - caption.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(b.w - caption.width)).toBeLessThanOrEqual(1);
		expect(b.ticksH).toBeLessThanOrEqual(b.fontPx * 1.3); // one line
		expect(b.cut).toBe(false); // "max 1.10" whole
	}
	const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
	expect(scroll).toBeLessThanOrEqual(inner);
	await expectNoViolations(page);
});

test('a dam card: its caption, the window’s first and last day, the low the Dam levels table gives, a read-out; a click picks the dam', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Dam sparklines');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=dams`);

	const cards = page.getByRole('list', { name: 'Dams' }).getByRole('listitem');
	await expect(cards).toHaveCount(2);
	const table = page.getByRole('region', { name: 'Dam levels' });
	for (const name of ['Upper farm', 'Lower farm']) {
		const card = cards.filter({ has: page.getByText(name, { exact: true }) });
		const spark = card.getByTestId('sparkline');
		await expect(spark.locator('figcaption')).toHaveText("% full over the run's last year");
		await expect(spark.getByRole('img', { name: new RegExp(`^${name}: % full over the run's last year\\. 1 Oct 2021 to 28 Jan 2022: \\d+% at the start, \\d+% at the end; low \\d+% on \\d+ \\w+ 202[12], high \\d+% on \\d+ \\w+ 202[12]\\.$`) })).toBeVisible();
		// The low is the table's "Lowest in its last year", to the day.
		const lowest = (await table.getByRole('row', { name: new RegExp(`^${name}`) }).locator('td').nth(1).innerText()).replace(/\s+/g, ' ').trim();
		await expect(ticks(spark)).toHaveText(['1 Oct 2021', `low ${lowest}`, '28 Jan 2022']);
		// The card's % full is where the line ends.
		const end = (await card.locator('.level .v').innerText()).trim();
		await pointAt(page, spark, 0.999);
		await expect(read(spark)).toHaveText(`28 Jan 2022 ${end}`);
		// The keyboard reaches the same day: End on the slider.
		await page.mouse.move(0, 0);
		const slider = spark.getByRole('slider', { name: `${name}: % full over the run's last year, read-out`, exact: true });
		await slider.focus();
		// It starts at the low: "15% · 19 Dec 2021" read out as "19 Dec 2021 15%".
		const [lowPct, lowDay] = lowest.split(' · ');
		await expect(read(spark)).toHaveText(`${lowDay} ${lowPct}`);
		await page.keyboard.press('End');
		await expect(slider).toHaveAttribute('aria-valuetext', `28 Jan 2022 ${end}`);
		await expect(read(spark)).toHaveText(`28 Jan 2022 ${end}`);
		await slider.blur();
	}

	// The line is above the card's stretched link, yet a click on it still picks the dam.
	const lower = cards.filter({ has: page.getByText('Lower farm', { exact: true }) });
	await lower.getByTestId('sparkline').locator('.plot').click();
	await expect(page).toHaveURL(/[?&]dam=/);
	// A click doesn't focus the slider: the pointer's read-out stays the pointer's.
	await expect(lower.getByRole('slider')).not.toBeFocused();
	await expect(page.getByRole('heading', { name: 'Storage: Lower farm' })).toBeVisible();
});

test('dam cards on a phone: the low takes its own line rather than being cut off; no violations', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dam sparklines phone');
	await createRun(page.request, project.id, 'Baseline');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${project.id}?tab=dams`);
	const sparks = page.getByRole('list', { name: 'Dams' }).getByTestId('sparkline');
	await expect(sparks).toHaveCount(2);
	for (const spark of await sparks.all()) {
		await expect(read(spark)).toHaveText(/^low \d+% · \d+ \w+ 202[12]$/);
		expect(await read(spark).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		const fig = (await spark.boundingBox())!;
		for (const end of await spark.locator('.end').all()) {
			const b = (await end.boundingBox())!;
			expect(b.x + b.width).toBeLessThanOrEqual(fig.x + fig.width + 0.5);
		}
	}
	await expectNoViolations(page);
});
