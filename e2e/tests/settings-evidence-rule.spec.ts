// Settings › Evidence (issue #71, docs/design/evidence-report.md ER3 and G4):
// an editor declares the uncertainty rule an evidence report's cited ensemble
// must follow, before any band is seen. Off by default; switching it on fills
// the ensemble's defaults; it saves whole, the history records who declared
// it, a viewer reads it but can't change it, and withdrawing it saves null.
import { addMember, createProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const DEFAULT_RULE_TEXT =
	'skill score KGE′, lowest skill kept 0.5, worst wr2012 flag kept query, largest low-flow bias kept ±50 %, members 300, bounds typical, pan coefficient shift ±0.1';

async function savedRule(page: import('@playwright/test').Page, projectId: string): Promise<unknown> {
	const res = await page.request.get(`${API_URL}/projects/${projectId}`);
	expect(res.status()).toBe(200);
	const body = (await res.json()) as { project: { settings: { evidenceUncertaintyRule?: unknown } } };
	return body.project.settings.evidenceUncertaintyRule;
}

test('an editor declares the rule from the defaults, saves it whole, and a viewer reads it; withdrawing it saves null', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Evidence rule');
	await page.goto(`/projects/${project.id}?tab=settings`);

	const section = page.getByRole('region', { name: /^Evidence/ });
	const declare = section.getByLabel('Declare an uncertainty rule for evidence');
	await expect(declare).not.toBeChecked();
	await expect(section.getByText('With no rule declared, an evidence report cites no ensemble.')).toBeVisible();
	await expect(section.getByLabel('Members')).toHaveCount(0);

	// On: the form fills with the ensemble's defaults.
	await declare.check();
	await expect(section.getByLabel('Members')).toHaveValue('300');
	await expect(section.getByLabel('Bounds')).toHaveValue('typical');
	await expect(section.getByLabel('Pan-coefficient shift (±)')).toHaveValue('0.1');
	await expect(section.getByLabel('Skill score')).toHaveValue('kgePrime');
	await expect(section.getByLabel('Lowest skill kept')).toHaveValue('0.5');
	await expect(section.getByLabel('Worst WR2012 flag kept')).toHaveValue('query');
	await expect(section.getByLabel('Largest low-flow bias kept (± %)')).toHaveValue('50');
	await expect(section.getByTestId('evidence-rule-text')).toHaveText(`The rule: ${DEFAULT_RULE_TEXT}`);

	// Change a few: a stricter skill, no low-flow check, 200 members.
	await section.getByLabel('Members').fill('200');
	await section.getByLabel('Lowest skill kept').fill('0.6');
	await section.getByLabel('Worst WR2012 flag kept').selectOption({ label: 'No check' });
	await section.getByLabel('Largest low-flow bias kept (± %)').fill('');
	await section.getByLabel('Largest low-flow bias kept (± %)').blur();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

	const expected = { members: 200, bounds: 'typical', panOffset: 0.1, thresholds: { objective: 'kgePrime', minSkill: 0.6, wr2012MaxLevel: 'unusable', maxLowFlowBiasPct: null } };
	expect(await savedRule(page, project.id)).toEqual(expected);
	const text =
		'The rule: skill score KGE′, lowest skill kept 0.6, worst wr2012 flag kept no check, largest low-flow bias kept no check, members 200, bounds typical, pan coefficient shift ±0.1';

	await page.reload();
	await expect(declare).toBeChecked();
	await expect(section.getByLabel('Members')).toHaveValue('200');
	await expect(section.getByTestId('evidence-rule-text')).toHaveText(text);
	// The history says who declared it.
	await expect(section.getByTestId('field-history')).toContainText('Changed 1×');

	// A viewer reads the rule but can't change it.
	const viewer = await signIn('Evidence viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=settings`);
	const seen = viewer.page.getByRole('region', { name: /^Evidence/ });
	await expect(seen.getByTestId('evidence-rule-text')).toHaveText(text);
	await expect(seen.getByLabel('Declare an uncertainty rule for evidence')).toBeDisabled();
	await expect(seen.getByLabel('Worst WR2012 flag kept')).toBeDisabled();
	await expect(seen.getByLabel('Members')).toHaveAttribute('readonly', '');
	await expect(viewer.page.getByRole('button', { name: 'Save settings' })).toHaveCount(0);

	// Withdrawn: the save sends null, and the section says no ensemble is cited.
	await declare.uncheck();
	await expect(section.getByText('With no rule declared, an evidence report cites no ensemble.')).toBeVisible();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	expect(await savedRule(page, project.id)).toBeNull();
	await page.reload();
	await expect(declare).not.toBeChecked();
});
