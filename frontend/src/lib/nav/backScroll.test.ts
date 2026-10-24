// awayFrom (backScroll.ts): Back/Forward move the window only when it isn't already at the saved place.
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, beforeNavigate: () => {} }));

import { awayFrom } from './backScroll';

describe('awayFrom', () => {
	it('is true when the window is elsewhere', () => {
		expect(awayFrom({ x: 0, y: 2006 }, { x: 0, y: 2717 })).toBe(true);
	});

	it('is false at the saved place, to the pixel (positive control)', () => {
		expect(awayFrom({ x: 0, y: 2006 }, { x: 0, y: 2006.4 })).toBe(false);
	});
});
