// Compare runs as board A4 lays it out (issue #17): a baseline and up to two
// what-ifs, a card per run saying what changed, an outcomes table with each
// what-if's change from the baseline, plain-language takeaways, the days
// below the reserve each water year, and the full two-run comparison below
// for the what-if picked. Old two-run links keep working; the second what-if
// is the optional `c` parameter. The extras (issue #17): a dam storage row,
// Export impact report (the what-if's printable report with an impact
// section, `report?run=…&against=…`) and + New what-if (the Scenarios
// dialog on the baseline, `new=1&base=…`), both in the section header.
import type { Page } from '@playwright/test';
import { addMember } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { runCard, runSelect, sectionHeader, seedWhatIfs, whatChanged } from '../support/compare.ts';
import { expect, test } from '../support/fixtures.ts';

const outcomes = (page: Page) => page.getByRole('table', { name: /^Headline outcomes of the baseline and each what-if/ });
/** Export impact report with two what-ifs: a menu (a `<details>`), one item per what-if. */
const exportMenu = (page: Page) => page.locator('summary', { hasText: 'Export impact report' });
const reserveChart = (page: Page) => page.getByRole('img', { name: /^Days below the reserve per water year\./ });

test('three runs side by side: cards, outcomes with deltas, takeaways, the yearly chart, and adding and removing what-if 2', async ({ page, owner }) => {
	void owner;
	const p = await seedWhatIfs(page.request, 'What-if valley');
	const ref = (run: string) => `${p.id}%3A${run}`;

	// An old two-run link opens the same pair, with room for a second what-if.
	await page.goto(`/projects/${p.id}?tab=compare&a=${p.id}:${p.baseline}&b=${p.id}:${p.whatIf1}`);
	// One page title: the section header's h1, with the view's context line in it.
	await expect(page.getByRole('heading', { level: 1, name: 'Compare runs' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Compare runs' })).toHaveCount(1);
	await expect(sectionHeader(page).getByTestId('compare-context')).toBeVisible();
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
	await expect(runCard(page, 'What-if 2').getByTestId('what-if-change')).toContainText('Upper farm: dam capacity 150\u202f000 m³ → 300\u202f000 m³');
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
	// Dam storage at the end of each run (issue #55's run-summary figures), as a share of each run's own capacity.
	const dams = table.getByRole('row', { name: /^Dam storage, end of run/ });
	await expect(dams.getByRole('rowheader')).toHaveText('Dam storage, end of run, % of capacity');
	await expect(dams.getByRole('cell').first()).toHaveText(/^\d+\.\d%$/);
	await expect(dams.getByRole('cell').nth(2)).toContainText(/^\d+\.\d%/);
	const rowNames = await table.getByRole('rowheader').allTextContents();
	expect(rowNames.findIndex((t) => t.startsWith('Dam storage'))).toBe(rowNames.findIndex((t) => t.startsWith('Mean outflow')) - 1);

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
	await expect(whatChanged(page).getByText('Upper farm: dam capacity 150\u202f000 m³ → 300\u202f000 m³')).toBeVisible();
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
	// The page has no section header: its actions sit beside its own title.
	await expect(exportMenu(page)).toBeVisible();
	await expect(page.getByRole('link', { name: '+ New what-if' })).toHaveAttribute('href', `/projects/${p.id}?tab=scenarios&new=1&base=${p.whatIf1}`);
	await expect(outcomes(page).getByRole('columnheader')).toHaveText(['Outcome', 'Baseline', 'What-if 1', 'What-if 2']);

	// Picking another run for what-if 2 stays on the page.
	await runSelect(page, 'What-if 2').selectOption(p.whatIf1);
	await expect(page).toHaveURL(new RegExp(`&c=${p.id}%3A${p.whatIf1}$`));
	// The same run as the baseline: no material change, said so.
	await expect(page.getByTestId('takeaways')).toContainText('What-if 2 makes no material change to these outcomes.');
});

test("Export impact report opens each what-if's report with its impact against the baseline, from the same numbers", async ({ page, owner }) => {
	void owner;
	const p = await seedWhatIfs(page.request, 'Impact report valley');
	const ref = (run: string) => `${p.id}%3A${run}`;

	// One what-if: a plain link in the section header.
	await page.goto(`/projects/${p.id}?tab=compare&a=${p.id}:${p.baseline}&b=${p.id}:${p.whatIf1}`);
	await expect(outcomes(page)).toBeVisible();
	await expect(sectionHeader(page).getByRole('link', { name: 'Export impact report' })).toHaveAttribute(
		'href',
		`/projects/${p.id}/report?run=${p.whatIf1}&against=${ref(p.baseline)}`
	);

	// Two what-ifs: a menu naming each; Escape closes it with focus back on its button.
	await page.goto(`/projects/${p.id}?tab=compare&a=${p.id}:${p.baseline}&b=${p.id}:${p.whatIf1}&c=${p.id}:${p.whatIf2}`);
	const days = outcomes(page).getByRole('row', { name: /^Days below the reserve, average year/ });
	await expect(days.getByRole('cell')).toHaveCount(3);
	const onScreen = (await days.getByRole('cell').nth(2).locator('.val').textContent())!.trim();
	await exportMenu(page).click();
	const items = sectionHeader(page).getByRole('group', { name: 'Impact report of' }).getByRole('link');
	await expect(items).toHaveText(['What-if 1: More orchard', 'What-if 2: More orchard and a bigger dam']);
	await page.keyboard.press('Escape');
	await expect(items.first()).toBeHidden();
	await expect(exportMenu(page)).toBeFocused();
	await exportMenu(page).click();
	await items.nth(1).click();

	// The what-if's report, an impact report: the impact first, from the comparison the page showed.
	await expect(page).toHaveURL(new RegExp(`/projects/${p.id}/report\\?run=${p.whatIf2}&against=${ref(p.baseline)}$`));
	await expect(page.locator('main[data-report-ready]')).toBeVisible();
	await expect(page.locator('.cover .eyebrow')).toHaveText('Impact report');
	const impact = page.getByRole('region', { name: '1. Impact against the baseline' });
	const table = impact.getByRole('table', { name: 'Headline outcomes of the baseline and this run, with the change' });
	await expect(table.getByRole('columnheader')).toHaveText(['Outcome', 'Baseline', 'This run', 'Change']);
	await expect(table.getByRole('row', { name: /^Days below the reserve, average year/ }).getByRole('cell').nth(1)).toHaveText(onScreen);
	await expect(table.getByRole('rowheader', { name: /^Dam storage, end of run/ })).toBeVisible();
	await expect(impact.getByTestId('impact-takeaways')).toContainText(/“More orchard and a bigger dam” costs the reserve \d+ more days a year\./);
	await expect(impact.getByText('Upper farm: dam capacity 150\u202f000 m³ → 300\u202f000 m³')).toBeVisible();
	// The licence-impact board opens the section; two complete water years are too few for any class (impact-board.spec.ts has a long record).
	for (const id of ['dry', 'normal', 'wet']) await expect(impact.getByTestId(`board-verdict-${id}`)).toHaveAttribute('data-verdict', 'notEnoughYears');
	// The server PDF prints this impact report too (server-report.spec.ts renders one).
	await expect(page.getByRole('button', { name: 'Generate PDF' })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Email me the PDF' })).toBeEnabled();
	await expect(page.getByRole('link', { name: '← Back to the comparison' })).toHaveAttribute(
		'href',
		`/projects/${p.id}?tab=compare&a=${ref(p.baseline)}&b=${ref(p.whatIf2)}`
	);

	// Back returns to all three runs.
	await page.goBack();
	await expect(runSelect(page, 'What-if 2')).toHaveValue(p.whatIf2);

	// A baseline that can't be read: the report still loads, and the section says why.
	await page.goto(`/projects/${p.id}/report?run=${p.whatIf1}&against=${p.id}:${crypto.randomUUID()}`);
	await expect(page.locator('main[data-report-ready]')).toBeVisible();
	await expect(page.getByRole('region', { name: '1. Impact against the baseline' }).getByRole('status')).toHaveText(
		"This run couldn't be compared with the baseline: The baseline doesn't exist any more, or its project isn't shared with you."
	);
	// No server PDF of it: the API would refuse that baseline too. The browser's print stays.
	await expect(page.getByRole('button', { name: 'Generate PDF' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
});

test('+ New what-if opens the Scenarios dialog on the baseline, and Back returns to the comparison; a viewer has no New what-if', async ({
	page,
	owner,
	signIn
}) => {
	void owner;
	const p = await seedWhatIfs(page.request, 'New what-if valley');
	// The baseline is not the latest run, so the dialog's default (the latest) would be wrong.
	const compareUrl = `/projects/${p.id}?tab=compare&a=${p.id}:${p.whatIf1}&b=${p.id}:${p.whatIf2}`;
	await page.goto(compareUrl);
	await expect(outcomes(page)).toBeVisible();
	await sectionHeader(page).getByRole('link', { name: '+ New what-if' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=scenarios&new=1&base=${p.whatIf1}$`));
	const dialog = page.getByRole('dialog', { name: 'New scenario' });
	await expect(dialog.getByLabel('Base run')).toHaveValue(p.whatIf1);
	await expect(dialog.getByLabel('Name')).toBeFocused();

	// Cancel drops both params in place; Back then leaves for the comparison.
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(page).toHaveURL(/\?tab=scenarios$/);
	await page.goBack();
	await expect(runSelect(page, 'Baseline')).toHaveValue(p.whatIf1);

	// Creating one opens it, with neither param left behind.
	await sectionHeader(page).getByRole('link', { name: '+ New what-if' }).click();
	await dialog.getByLabel('Name').fill('Upper dam +20 %');
	await dialog.getByRole('button', { name: 'Create scenario' }).click();
	await expect(page).toHaveURL(/\?tab=scenarios&scenario=[0-9a-f-]+$/);
	await expect(page.getByRole('heading', { level: 2, name: /Upper dam \+20 %/ })).toBeVisible();

	// A viewer can export the impact report but not start a what-if.
	const viewer = await signIn('New what-if viewer');
	await addMember(page.request, p.id, viewer.user.email, 'viewer');
	await viewer.page.goto(compareUrl);
	await expect(outcomes(viewer.page)).toBeVisible();
	await expect(sectionHeader(viewer.page).getByRole('link', { name: 'Export impact report' })).toBeVisible();
	await expect(sectionHeader(viewer.page).getByRole('link', { name: '+ New what-if' })).toHaveCount(0);
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
		// The export menu open, and the impact report it leads to.
		await exportMenu(page).click();
		await expectNoViolations(page);
		await page.goto(`/projects/${p.id}/report?run=${p.whatIf2}&against=${p.id}:${p.baseline}`);
		await expect(page.locator('main[data-report-ready]')).toBeVisible();
		await expectNoViolations(page);
	});
}
