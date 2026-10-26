// Where LoadState's Try again hands the focus once a retry has loaded
// (LoadState.svelte): the heading of the panel round it, the state that
// replaced the focused control (ui-playbook § Focus). Tried in order: the
// heading that names the nearest labelled region (aria-labelledby, often a
// span inside the heading), the first heading of the nearest section, and the
// first control in what the state rendered. A heading gets tabindex -1, so it
// takes the focus without joining the Tab order.
import { anchorHeading, focusHeading } from '#lib/help/anchor.js';

const CONTROL = 'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The element to focus after a retry from `from` (LoadState's parent) has loaded, or null. */
export function retryTarget(from: Element): HTMLElement | null {
	const labelled = from.closest('[aria-labelledby]');
	const label = labelled && from.ownerDocument.getElementById(labelled.getAttribute('aria-labelledby')!.split(/\s+/)[0]);
	const named = label?.closest<HTMLElement>('h1, h2, h3, h4');
	if (named) return named;
	const section = from.closest('section, [role="region"], dialog');
	const heading = section && anchorHeading(section);
	if (heading) return heading;
	return from.querySelector<HTMLElement>(CONTROL);
}

/** retryTarget, made focusable when it is a heading; null when there is nothing to focus. */
export function retryLanding(from: Element): { focus: () => void } | null {
	if (!from.isConnected) return null;
	const target = retryTarget(from);
	if (!target) return null;
	return { focus: () => (/^H[1-4]$/.test(target.tagName) ? focusHeading(target) : target.focus()) };
}
