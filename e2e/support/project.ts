// The Project page (?tab=project, issue #17, docs/ui.md § Project): the model's
// facts, the project's details, import record and notes, and who can open it,
// moved from below the Summary's first screen.
import { expect, type Page } from '@playwright/test';

/** Opens the Project page (with a fragment, e.g. `#members-h`) and waits for its title and the members list. */
export async function openProject(page: Page, projectId: string, hash = '') {
	await page.goto(`/projects/${projectId}?tab=project${hash}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Project', exact: true })).toBeVisible();
	await expect(membersPanel(page).getByRole('rowheader').first()).toBeVisible();
}

/** The Members panel ("Shared directly with" in a team project). */
export const membersPanel = (page: Page) => page.getByRole('region', { name: /^(Members|Shared directly with)$/ });

/** One of the model's headline facts, by its label. */
export const fact = (page: Page, term: string) =>
	page.locator('dl.stats > div').filter({ has: page.getByRole('term').filter({ hasText: term }) }).getByRole('definition');
