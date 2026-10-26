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

/**
 * What followRetry sees in its scope after a change: whether the reader has
 * taken the focus elsewhere, a new Try again (`[data-retry]`, none drawn
 * when it was pressed) is drawn, the pressed one is still on the page, and a loading
 * line (`[data-loading]`) is drawn.
 */
export interface RetryView {
	moved: boolean;
	again: boolean;
	pressedOn: boolean;
	loading: boolean;
}
/** stop: leave the focus; again / landing: focus the new Try again / the heading and stop; loading: focus the loading line and watch on; wait: watch on. */
export type RetryStep = 'stop' | 'again' | 'wait' | 'loading' | 'landing';

/** The step for a view (pure; followRetry's decision, unit-tested). */
export function retryStep(v: RetryView): RetryStep {
	if (v.moved) return 'stop';
	if (v.again) return 'again';
	if (v.pressedOn) return 'wait';
	if (v.loading) return 'loading';
	return 'landing';
}

/**
 * A hand-built Try again's focus, the way LoadState places it (WCAG 2.4.3,
 * issue #586 R4-I): call it from the button's click, before the retry
 * starts. Try again swaps its alert for a loading line, and the focus fell
 * to <body>. This watches `scope` (by default the parent of the alert round
 * the button, which must stay on the page through the retry) and puts the
 * focus on the loading line (`[data-loading]`) while the retry loads, on the
 * new Try again (`[data-retry]`) when it failed again, and on the panel's
 * heading (retryLanding) once it has loaded. It lets go as soon as the reader
 * moves the focus themselves. `landing` names the element to land from when
 * it isn't the scope (retryLanding: the heading of the region round it), for
 * a Try again outside the panel it refreshes; or, as a function, finds what
 * to focus once loaded (a page's <h1>, drawn only then), the scope's landing
 * when it finds nothing.
 */
export function followRetry(
	pressed: HTMLElement,
	{ scope, landing }: { scope?: Element | null; landing?: Element | null | (() => HTMLElement | null | undefined) } = {}
): void {
	const root = scope ?? pressed.closest('[role="alert"], .alert')?.parentElement ?? pressed.parentElement;
	if (!root) return;
	const doc = root.ownerDocument;
	let placed: HTMLElement | null = null;
	// Another panel's Try again already drawn in the scope isn't this retry's.
	const before = new Set(root.querySelectorAll('[data-retry]'));
	const observer = new MutationObserver(step);
	const stop = () => observer.disconnect();
	function step() {
		if (!root!.isConnected) return stop();
		const active = doc.activeElement;
		const moved = !!active && active !== doc.body && active !== pressed && active !== placed && !active.contains(root!);
		const again = [...root!.querySelectorAll<HTMLElement>('[data-retry]')].find((b) => !before.has(b)) ?? null;
		const loading = root!.querySelector<HTMLElement>('[data-loading]');
		const next = retryStep({ moved, again: !!again, pressedOn: pressed.isConnected, loading: !!loading });
		if (next === 'stop') return stop();
		if (next === 'again') {
			stop();
			return again!.focus();
		}
		if (next === 'loading') {
			if (loading !== placed) {
				if (!loading!.hasAttribute('tabindex')) loading!.tabIndex = -1;
				placed = loading;
				loading!.focus();
			}
			return;
		}
		if (next === 'landing') {
			stop();
			const found = typeof landing === 'function' ? landing() : null;
			if (found) return /^H[1-4]$/.test(found.tagName) ? focusHeading(found) : found.focus();
			retryLanding((typeof landing === 'function' ? null : landing) ?? root!)?.focus();
		}
	}
	observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-loading', 'data-retry'] });
}
