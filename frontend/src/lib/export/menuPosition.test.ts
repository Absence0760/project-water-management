import { describe, expect, it } from 'vitest';
import { menuPlacement, placementStyle } from './menuPosition';

const viewport = { width: 1200, height: 800 };
const trigger = (top: number, left = 1000, right = 1100) => ({ top, bottom: top + 30, left, right });

describe('menuPlacement', () => {
	it('opens below the trigger, right-aligned, when there is room', () => {
		expect(menuPlacement(trigger(100), viewport, 'end')).toEqual({ top: 134, right: 100, maxHeight: 658 });
	});

	it('opens above a trigger near the bottom of the window (the last row of a table)', () => {
		const p = menuPlacement(trigger(700), viewport, 'end');
		expect(p.top).toBeUndefined();
		expect(p.bottom).toBe(104); // 800 − 700 + 4
		expect(p.maxHeight).toBe(688); // 700 − 4 − 8
	});

	it('stays below when there is little room either way but more below', () => {
		const small = { width: 1200, height: 300 };
		expect(menuPlacement(trigger(100), small, 'end').top).toBe(134);
	});

	it('aligns to the trigger’s left edge for align="start", never off-screen', () => {
		expect(menuPlacement(trigger(100, 40, 140), viewport, 'start')).toMatchObject({ left: 40 });
		expect(menuPlacement(trigger(100, -20, 80), viewport, 'start')).toMatchObject({ left: 8 });
		expect(menuPlacement(trigger(100, 1150, 1210), viewport, 'end')).toMatchObject({ right: 8 });
	});

	it('writes only the sides it sets', () => {
		expect(placementStyle({ bottom: 104, right: 100, maxHeight: 688 })).toBe('bottom: 104px; right: 100px; max-height: 688px;');
	});
});
