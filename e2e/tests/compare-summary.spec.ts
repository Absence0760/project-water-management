// Compare runs as board A4 lays it out (issue #17): a baseline and up to two
// what-ifs, a card per run saying what changed, an outcomes table with each
// what-if's change from the baseline, plain-language takeaways, the days
// below the reserve each water year, and the full two-run comparison below
// for the what-if picked. Old two-run links keep working; the second what-if
// is the optional `c` parameter.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { runCard, runSelect, seedWhatIfs, whatChanged } from '../support/compare.ts';
import { expect, test } from '../support/fixtures.ts';

const outcomes = (page: Page) => page.getByRole('table', { name: /^Headline outcomes of the baseline and each what-if/ });
const reserveChart = (page: Page) => page.getByRole('img', { name: /^Days below the reserve per water year\./ });

test('three runs side by side: cards, outcomes with deltas, takeaways, the yearly chart, and adding and removing what-if 2', async ({ page, owner }) => {
	void owner;
	const p = await seedWhatIfs(page.request, 'What-if valley');
	const ref = (run: string) => `${p.id}%3A${run}`;

	// An old two-run link opens the same pair, with room for a second what-if.
	await page.goto(`/projects/${p.id}?tab=compare&a=${p.id}:${p.baseline}&b=${p.id}:${p.whatIf1}`);
	// One title: the section header's; the view gives it its context line and draws no heading of its own.
	await expect(page.getByTestId('section-header').getByRole('heading', { level: 1, name: 'Compare runs' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Compare runs' })).toHaveCount(1);
	await expect(page.getByTestId('section-header').getByTestId('compare-context')).toBeVisible();
	await expect(runSelect(page, 'Baseline')).toHaveValue(p.baseline);
	await expect(runSelect(page, 'What-if 1')).toHaveValue(p.whatIf1);
	await expect(runCard(page, 'What-if 1').getByTestId('what-if-change')).toHaveText('Upper farm: "Orchard" area 20 ha → 40 ha');
	await expect(page.getByTestId('compare-context')).toHaveText(/^Baseline “Baseline” against one what-if · same period, 2021–2024 · engine \S+$/);
	await expect(outcomes(page).getByRole('columnheader')).toHaveText(['Outcome', 'Baseline', 'What-if 1']);

	// Add what-if 2: the newest run that is neither side, in the URL after a and b; focus lands on its run select.
	await page.getByRole('button', { name: '+ Add a second what-if' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=compare&a=${ref(p.baseline)}&b=${ref(p.whatIf1)}&c=${ref(p.whatIf2)}$`));
	await expect(runSelect(page, 'What-if 2')).toHaveValue(p.whatIf2);
	await expect(runSelect(page, 'What-if 2')).toBeFocused();
	await expect(runCard(page, 'What-if 2').getByText('More orchard and a bigger dam', { exact: true })).toBeVisible();
	await expect(runCard(page, 'What-if 2').getByTestId('what-if-change')).toContainText('Upper farm: dam capacity 150,000 m³ → 300,000 m³');
	await expect(page.getByTestId('compare-context')).toHaveText(/^Baseline “Baseline” against 2 what-ifs · /);

	// The outcomes table: a column per run, each what-if cell its value and its change.
	const table = outcomes(page);
	await expect(table.getByRole('columnheader')).toHaveText(['Outcome', 'Baseline', 'What-if 1', 'What-if 2']);
	const days = table.getByRole('row', { name: /^Days below the reserve, average year/ });
	await expect(days.getByRole('cell')).toHaveCount(3);
	// More orchard irrigates more, so the river is below its reserve on more days: a worse change, said in words.
	await expect(days.getByRole('cell').nth(1)).toContainText(/up \d+, worse/);
	await expect(table.getByRole('rowheader', { name: /^Reserve met/ })).toBeVisible();
	await expect(table.getByRole('rowheader', { name: /^Irrigation supplied/ })).toBeVisible();
	await expect(table.getByRole('rowheader', { name: /^Mean outflow/ })).toBeVisible();

	// Takeaways in plain words, from the same numbers.
	const takeaways = page.getByTestId('takeaways');
	await expect(takeaways.locator('.lead')).toHaveText(/^What-if [12] costs the reserve \d+ more days a year\.$/);
	await expect(takeaways).toContainText(/What-if 2 costs the reserve \d+ more days a year/);

	// Days below the reserve per water year: the three runs over three water years (the last one part of a year).
	await expect(reserveChart(page)).toHaveAccessibleName(
		/Baseline: \d+ days below in 3 water years; What-if 1: \d+ days below in 3 water years; What-if 2: \d+ days below in 3 water years\.$/
	);
	const years = page.getByRole('region', { name: 'Days below the reserve, each year' });
	await years.getByText('Show as a table').click();
	const yearTable = years.getByRole('table', { name: 'Days below the reserve per water year' });
	await expect(yearTable.getByRole('columnheader')).toHaveText(['Water year', 'Baseline', 'What-if 1', 'What-if 2']);
	await expect(yearTable.getByRole('rowheader')).toHaveText(['2021/22', '2022/23', '2023/24 · part year']);

	// The full comparison, baseline against what-if 1 by default, switches to what-if 2.
	await expect(page.getByText('Baseline (run A) against What-if 1 (run B): every figure below is B − A.')).toBeVisible();
	await expect(whatChanged(page).getByText('Upper farm: "Orchard" area 20 ha → 40 ha')).toBeVisible();
	await page.getByRole('radio', { name: 'Baseline vs What-if 2' }).check();
	await expect(page.getByText('Baseline (run A) against What-if 2 (run B): every figure below is B − A.')).toBeVisible();
	await expect(whatChanged(page).getByText('Upper farm: dam capacity 150,000 m³ → 300,000 m³')).toBeVisible();
	await expect(page.getByRole('heading', { level: 2, name: 'Headline results' })).toBeVisible();

	// A card's "all N changes" opens that what-if's full list.
	await page.getByRole('radio', { name: 'Baseline vs What-if 1' }).check();
	await runCard(page, 'What-if 2').getByRole('button', { name: 'all 2 changes' }).click();
	await expect(page.getByRole('radio', { name: 'Baseline vs What-if 2' })).toBeChecked();
	await expect(whatChanged(page).getByRole('listitem')).toHaveCount(2);

	// A reload keeps all three.
	await page.reload();
	await expect(runSelect(page, 'What-if 2')).toHaveValue(p.whatIf2);

	// Remove what-if 2: back to the pair, focus on the add button; Back brings it back.
	await runCard(page, 'What-if 2').getByRole('button', { name: 'Remove what-if 2' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=compare&a=${ref(p.baseline)}&b=${ref(p.whatIf1)}$`));
	await expect(page.getByRole('button', { name: '+ Add a second what-if' })).toBeFocused();
	await expect(outcomes(page).getByRole('columnheader')).toHaveText(['Outcome', 'Baseline', 'What-if 1']);
	await expect(page.getByRole('radio', { name: 'Baseline vs What-if 2' })).toHaveCount(0);
	await page.goBack();
	await expect(runSelect(page, 'What-if 2')).toHaveValue(p.whatIf2);
});

test('the standalone page opens ?project= on its default pair, takes a second what-if, and keeps it in the URL', async ({ page, owner }) => {
	void owner;
	const p = await seedWhatIfs(page.request, 'Standalone what-ifs');
	await page.goto(`/compare?project=${p.id}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Compare runs' })).toBeVisible();
	// No published run: the latest against the one before (picker.ts defaultPair).
	await expect(runSelect(page, 'Baseline')).toHaveValue(p.whatIf1);
	await expect(runSelect(page, 'What-if 1')).toHaveValue(p.whatIf2);
	await expect(page.getByRole('link', { name: 'Back to runs' })).toHaveAttribute('href', `/projects/${p.id}?tab=runs`);

	await page.getByRole('button', { name: '+ Add a second what-if' }).click();
	await expect(page).toHaveURL(new RegExp(`/compare\\?a=${p.id}%3A${p.whatIf1}&b=${p.id}%3A${p.whatIf2}&c=${p.id}%3A${p.baseline}$`));
	await expect(outcomes(page).getByRole('columnheader')).toHaveText(['Outcome', 'Baseline', 'What-if 1', 'What-if 2']);

	// Picking another run for what-if 2 stays on the page.
	await runSelect(page, 'What-if 2').selectOption(p.whatIf1);
	await expect(page).toHaveURL(new RegExp(`&c=${p.id}%3A${p.whatIf1}$`));
	// The same run as the baseline: no material change, said so.
	await expect(page.getByTestId('takeaways')).toContainText('What-if 2 makes no material change to these outcomes.');
});

for (const [label, size] of [
	['desktop', { width: 1440, height: 960 }],
	['phone', { width: 390, height: 844 }]
] as const) {
	test(`the three-run summary has no a11y violations (${label})`, async ({ page, owner }) => {
		void owner;
		const p = await seedWhatIfs(page.request, `A11y what-ifs ${label}`);
		await page.setViewportSize(size);
		await page.goto(`/projects/${p.id}?tab=compare&a=${p.id}:${p.baseline}&b=${p.id}:${p.whatIf1}&c=${p.id}:${p.whatIf2}`);
		await expect(reserveChart(page)).toBeVisible();
		await page.getByRole('region', { name: 'Days below the reserve, each year' }).getByText('Show as a table').click();
		await expect(page.getByRole('heading', { level: 2, name: 'Headline results' })).toBeVisible();
		await expectNoViolations(page);
	});
}
