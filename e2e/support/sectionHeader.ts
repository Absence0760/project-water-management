// The workspace's section header (frontend workspace/SectionHeader.svelte, docs/ui.md § Section header).
import { expect, type Locator, type Page } from '@playwright/test';

export const sectionHeader = (page: Page) => page.getByTestId('section-header');

/**
 * One of the tab's own controls in the section header (a link, button or picker by its name). On a phone they sit
 * in the More actions list (issue #521 round 5), which this opens first: the header is phone-sized below about
 * 700 px of window (its own width at most 640 px, there being no sidebar under 900 px).
 */
export async function headerControl(page: Page, role: 'link' | 'button' | 'combobox', name: string | RegExp): Promise<Locator> {
	await showHeaderControls(page);
	return sectionHeader(page).getByTestId('header-own').getByRole(role, { name, exact: typeof name === 'string' ? true : undefined });
}

/** Shows the tab's own controls: on a phone, opens the More actions list (a wide screen shows them already). */
export async function showHeaderControls(page: Page): Promise<void> {
	if ((page.viewportSize()?.width ?? 1280) >= 700) return;
	const more = sectionHeader(page).getByTestId('header-more');
	await expect(more).toBeVisible();
	if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
}
