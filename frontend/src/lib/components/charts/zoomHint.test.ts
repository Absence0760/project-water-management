import { describe, expect, it } from 'vitest';
import { zoomHint } from './zoomHint';

describe('the chart’s zoom hint, worded for the reader’s pointer (issue #586)', () => {
	it('tells a mouse about the zoom box, Shift+drag and double-click', () => {
		expect(zoomHint(true).fine).toBe('Drag across the chart to zoom, then Shift+drag (or Earlier / Later) to move through the record; double-click for the full period.');
		expect(zoomHint(false).fine).toBe('Drag across the chart to zoom; double-click to reset.');
	});

	it('never promises a touch screen a gesture the chart lacks: no drag, no Shift key, no double-click', () => {
		for (const pannable of [true, false]) {
			const { touch } = zoomHint(pannable);
			expect(touch).toMatch(/^Tap the chart to read its values/);
			expect(touch).not.toMatch(/drag|shift|double/i);
		}
		// A daily chart's way through the record on touch: the buttons.
		expect(zoomHint(true).touch).toContain('Earlier / Later');
		expect(zoomHint(false).touch).not.toContain('Earlier');
	});
});
