// § 6 of the evidence report, the applicant's demand objects and where their
// numbers come from (report format evidence-9, issue #259; docs/ui.md §
// Evidence report, docs/evidence-pack.md): an application adds two demand
// objects on the applicant's farm, one from meter records with its note and
// one with no source recorded, and the report lists both with their sizing,
// source and demand, says what share of their demand is metered, flags on
// page 1 that most of it isn't, and asks for the missing source. Synthetic
// catchment.
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, nominateRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

test('the applicant’s demand objects print in § 6 with their sources, and page 1 flags the unmetered share', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Evidence demand objects');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	const baseline = await createRun(page.request, project.id, 'Baseline');
	await nominateRun(page.request, project.id, baseline, 'Baseline for the demand objects test');
	const upper = (project.model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper farm')!.id;
	const object = (name: string, over: Record<string, unknown>) => ({
		id: crypto.randomUUID(),
		nodeId: upper,
		name,
		category: 'domestic',
		sizing: 'monthly',
		monthlyM3Day: new Array(12).fill(30),
		count: null,
		litresPerUnitDay: null,
		lossPct: 0,
		monthlyFactor: null,
		returnPct: 0,
		priority: 'first',
		destination: 'internal',
		enabled: true,
		...over
	});
	const made = await page.request.post(`${API_URL}/projects/${project.id}/scenarios`, {
		data: {
			name: 'Upper farm housing',
			baseRunId: baseline,
			ops: [
				{ op: 'demandObject.add', demandObject: object('Staff housing', { source: 'meter', note: 'Meter M-12, 2024–25 readings' }) },
				{ op: 'demandObject.add', demandObject: object('Labour village', { sizing: 'perUnit', monthlyM3Day: null, count: 300, litresPerUnitDay: 230 }) }
			],
			ownedNodeIds: [upper]
		}
	});
	expect(made.status()).toBe(201);
	const scenarioId = ((await made.json()) as { scenario: { id: string } }).scenario.id;
	const ran = await page.request.post(`${API_URL}/projects/${project.id}/scenarios/${scenarioId}/runs`, { data: {} });
	expect(ran.status()).toBe(201);
	const runId = ((await ran.json()) as { run: { id: string } }).run.id;

	await page.goto(`/projects/${project.id}/report?run=${runId}&evidence`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	const section = page.locator('#ev-demandObjects');
	await expect(section.getByRole('heading', { level: 2, name: '6. The applicant’s demand objects' })).toBeVisible();
	// 30 m³/day metered against 300 × 230 l = 69 m³/day not recorded.
	await expect(section.getByTestId('evidence-demand-sources')).toContainText('Of their demand, 30% is from meter records and 70% not recorded.');
	const table = section.getByTestId('evidence-demand-objects');
	const housing = table.getByRole('row', { name: /Staff housing/ });
	await expect(housing.getByRole('cell')).toHaveText(['Upper farm', 'Added', '30 m³/day every month', /^Meter records\s*Meter M-12, 2024–25 readings$/, '–', '30.0', /%$/]);
	const village = table.getByRole('row', { name: /Labour village/ });
	await expect(village).toContainText('300 × 230 l a day');
	await expect(village).toContainText('not recorded');
	await expect(village).toContainText('69.0');

	// Page 1: the caution, never the notes (G13); the missing source is a question for the assessor, in the preview bar's checks.
	await expect(page.getByTestId('evidence-flags')).toContainText('Most of the applicant’s demand objects’ demand isn’t from meter records: 30 % is, and 70 % has no source recorded (§ 6).');
	await expect(page.locator('#ev-summary')).not.toContainText('Meter M-12');
	await expect(page.locator('ul.questions')).toContainText('1 of the applicant’s demand objects has no source recorded (§ 6)');
	await expectNoViolations(page);
});
