// scrollToRestore (backScroll.ts): Back/Forward go back to the entry's saved scroll, unless already there.
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, beforeNavigate: () => {} }));

import { scrollToRestore } from './backScroll';

describe('scrollToRestore', () => {
	it('restores the saved place when the window is elsewhere', () => {
		expect(scrollToRestore({ x: 0, y: 2006 }, { x: 0, y: 2717 })).toEqual({ x: 0, y: 2006 });
	});

	it('does nothing when SvelteKit already restored it, to the pixel (positive control), or saved none', () => {
		expect(scrollToRestore({ x: 0, y: 2006 }, { x: 0, y: 2006.4 })).toBeNull();
		expect(scrollToRestore(null, { x: 0, y: 10 })).toBeNull();
	});
});
