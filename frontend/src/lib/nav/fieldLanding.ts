// Landing on one field of a page (issue #611): the Warnings page's fixes link
// to the exact setting, `?tab=settings&field=st-acc`, not just its panel. The
// workspace page calls landOnField for the `field` parameter: it waits for the
// element (a tab and its sections are lazy chunks), opens every closed
// <details> around it (a fold), scrolls it to the middle of the window, puts
// the focus on it or the first control inside, and marks it
// `data-field-landed` for a few seconds (app.css draws an outline), so the
// reader sees which field the warning meant. Not a #fragment: a panel's
// landing holds the scroll on its heading, which would pull the page away.

/** A field id the parameter may name: what the app's ids look like, nothing else. */
export const FIELD_ID = /^[a-z][a-z0-9-]{0,63}$/;
/** How long to wait for the field to be drawn. */
export const FIELD_WAIT_MS = 8000;
/** How long the outline shows. */
export const FIELD_MARK_MS = 4000;

const FOCUSABLE = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Land on the element `id` once it is drawn; returns a function that stops waiting. */
export function landOnField(id: string, root: Document = document): () => void {
	if (!FIELD_ID.test(id)) return () => {};
	let done = false;
	let observer: MutationObserver | null = null;
	let markTimer: ReturnType<typeof setTimeout> | null = null;
	const stop = () => {
		done = true;
		observer?.disconnect();
		clearTimeout(deadline);
	};
	const land = (el: HTMLElement) => {
		stop();
		for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) (d as HTMLDetailsElement).open = true;
		requestAnimationFrame(() => {
			el.scrollIntoView({ block: 'center' });
			const target = el.matches(FOCUSABLE) ? el : (el.querySelector<HTMLElement>(FOCUSABLE) ?? el);
			if (target === el && !el.matches(FOCUSABLE)) el.tabIndex = -1;
			target.focus({ preventScroll: true });
			el.setAttribute('data-field-landed', '');
			markTimer = setTimeout(() => el.removeAttribute('data-field-landed'), FIELD_MARK_MS);
		});
	};
	const deadline = setTimeout(stop, FIELD_WAIT_MS);
	const found = root.getElementById(id);
	if (found) land(found);
	else {
		observer = new MutationObserver(() => {
			const el = root.getElementById(id);
			if (el && !done) land(el);
		});
		observer.observe(root.body, { childList: true, subtree: true });
	}
	return () => {
		stop();
		if (markTimer) clearTimeout(markTimer);
	};
}
