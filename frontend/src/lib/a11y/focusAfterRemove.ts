// Focus after a delete takes its row away (WCAG 2.4.3 Focus Order). The row's
// delete button had the focus, and the confirm dialog hands it back to an
// element that is gone, so the focus fell to <body> and the next Tab started
// from the top of the page. Put it on the same control of the row now in the
// removed one's place (the next row, or the last when it was the last), or on
// a fallback (the list's heading, its add field) once the list is empty.
// docs/design/ui-playbook.md § "A delete puts the focus on what took the row's place".
import { tick } from 'svelte';

/** The index of the row that takes a removed row's place: the same index, else the last; null with none left. */
export function rowAfterRemove(removedAt: number, left: number): number | null {
	if (left <= 0) return null;
	return Math.min(Math.max(removedAt, 0), left - 1);
}

/**
 * After the removal has rendered, focus the `selector` control at the removed row's index (each row has
 * one), else `fallback`; a heading fallback gets tabindex -1 so it can hold the focus.
 */
export async function focusAfterRemove(removedAt: number, selector: string, fallback?: HTMLElement | string | null): Promise<void> {
	await tick();
	const controls = document.querySelectorAll<HTMLElement>(selector);
	const at = rowAfterRemove(removedAt, controls.length);
	const target = at !== null ? controls[at] : typeof fallback === 'string' ? document.getElementById(fallback) : fallback;
	if (!target) return;
	if (at === null && !target.matches('a[href], button, input, select, textarea, [tabindex]')) target.tabIndex = -1;
	target.focus();
}
