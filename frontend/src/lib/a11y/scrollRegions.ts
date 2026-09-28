// Keyboard access to sideways-scrolling boxes (WCAG 2.1.1; axe
// "scrollable-region-focusable"). A wide table or drawing in an
// `overflow-x: auto` box can only be scrolled with a mouse or touch unless the
// box itself takes focus. So every `.table-wrap` (app.css) and every element
// marked `data-scroll-region` becomes a focusable, named group while (and only
// while) its content overflows: on a wide screen nothing changes, on a phone
// Tab reaches it and the arrow keys scroll it.
//
// One watcher for the whole app (started by the root layout), so the dozen
// table wrappers don't each need wiring. A box names itself with
// `data-scroll-label`; otherwise the name comes from its table's caption or
// the labelled section it sits in.

const SELECTOR = '.table-wrap, [data-scroll-region]';
/** Marks attributes we set, so we only ever undo our own. */
const MANAGED = 'data-scroll-managed';

/** The accessible name for a scroll box, from the page around it. */
export function scrollRegionLabel(el: HTMLElement): string {
	const own = el.dataset.scrollLabel?.trim();
	if (own) return own;
	const caption = el.querySelector('caption')?.textContent?.trim();
	if (caption) return caption;
	const section = el.closest<HTMLElement>('[aria-labelledby], [aria-label]');
	if (section) {
		const ids = section.getAttribute('aria-labelledby');
		const text = ids
			? ids
					.split(/\s+/)
					.map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
					.join(' ')
					.trim()
			: (section.getAttribute('aria-label')?.trim() ?? '');
		if (text) return text;
	}
	return 'Scrollable table';
}

const overflows = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;

function update(el: HTMLElement) {
	const managed = el.hasAttribute(MANAGED);
	if (overflows(el)) {
		// Leave boxes that already have their own role or tab stop alone.
		if (!managed && (el.hasAttribute('tabindex') || el.hasAttribute('role'))) return;
		el.setAttribute(MANAGED, '');
		el.tabIndex = 0;
		el.setAttribute('role', 'group');
		el.setAttribute('aria-label', scrollRegionLabel(el));
	} else if (managed) {
		el.removeAttribute(MANAGED);
		el.removeAttribute('tabindex');
		el.removeAttribute('role');
		el.removeAttribute('aria-label');
	}
}

/** Watches `root` for scroll boxes (now and as they're added). Returns a stop function. */
export function watchScrollRegions(root: HTMLElement): () => void {
	const seen = new WeakSet<Element>();
	// Content changing size (data loading, a tab switching layout) as well as
	// the viewport: observe each box and its first child.
	const sizes = new ResizeObserver((entries) => {
		for (const e of entries) {
			const box = (e.target as HTMLElement).closest<HTMLElement>(SELECTOR);
			if (box) update(box);
		}
	});
	const track = (el: HTMLElement) => {
		if (seen.has(el)) return;
		seen.add(el);
		sizes.observe(el);
		if (el.firstElementChild) sizes.observe(el.firstElementChild);
		update(el);
	};
	const scan = (node: ParentNode) => {
		if (node instanceof HTMLElement && node.matches(SELECTOR)) track(node);
		node.querySelectorAll<HTMLElement>(SELECTOR).forEach(track);
	};
	scan(root);
	const added = new MutationObserver((records) => {
		for (const r of records)
			for (const n of r.addedNodes) {
				if (!(n instanceof HTMLElement)) continue;
				scan(n);
				// New content inside a known box (a table rendered once data loads).
				const box = n.parentElement?.closest<HTMLElement>(SELECTOR);
				if (box && seen.has(box)) {
					sizes.observe(n);
					update(box);
				}
			}
	});
	added.observe(root, { childList: true, subtree: true });
	return () => {
		added.disconnect();
		sizes.disconnect();
	};
}
