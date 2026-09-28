// The header's Add data dialog (docs/ui.md § Header: data freshness and "Add
// data"): finding it, and dropping a CSV on the page the way a browser does.
import type { Page } from '@playwright/test';

export const addDataDialog = (page: Page) => page.getByRole('dialog', { name: 'Add data' });

/** A CSV file for setInputFiles. */
export const csv = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });

/**
 * Drags a CSV over the project page and drops it, as a file dragged from the
 * desktop does: dragenter, dragover, then drop on the page's main element,
 * each carrying the file in its DataTransfer.
 */
export async function dropCsv(page: Page, name: string, text: string) {
	await page.locator('main.page').evaluate(
		(main, { name, text }) => {
			const dt = new DataTransfer();
			dt.items.add(new File([text], name, { type: 'text/csv' }));
			for (const type of ['dragenter', 'dragover', 'drop'])
				main.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
		},
		{ name, text }
	);
}
