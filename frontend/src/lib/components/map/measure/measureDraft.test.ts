// The measurement (measureDraft.svelte.ts, issue #326 A7): the drawing
// mode's draft, never asking before Escape ends it, closed once finished.
import { describe, expect, it } from 'vitest';
import { MeasureDraft } from './measureDraft.svelte';

describe('MeasureDraft', () => {
	it('adds points with the running distance, closes for the area, and ends at Escape without asking', async () => {
		const m = new MeasureDraft();
		m.start();
		expect(m.active).toBe(true);
		expect(m.shape).toBe('polygon');
		m.add([21, -34]);
		m.add([21, -33.99]);
		expect(m.result).toMatch(/^Distance: 1\.11 km \(2 points\)\.$/);
		m.add([21.01, -33.99]);
		expect(m.closed).toBe(false);
		expect(m.finish()).toBe(true);
		expect(m.closed).toBe(true);
		expect(m.result).toMatch(/^Area: \d+\.\d ha\. Perimeter: \d\.\d\d km\.$/);
		let asked = false;
		expect(
			await m.escape(async () => {
				asked = true;
				return true;
			})
		).toBe(true);
		expect(asked).toBe(false);
		expect(m.active).toBe(false);
	});

	it('starts again empty', () => {
		const m = new MeasureDraft();
		m.start();
		m.add([21, -34]);
		m.start();
		expect(m.points).toEqual([]);
		expect(m.canUndo).toBe(false);
	});
});
