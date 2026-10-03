import { describe, expect, it } from 'vitest';
import { toolStrip, type ToolState } from './mapTools';

const off: ToolState = { measuring: false, mode: null, delineating: false, dividing: false, tracing: false };

describe('toolStrip', () => {
	it('says nothing with no tool on', () => {
		expect(toolStrip(off)).toBeNull();
	});
	it('names each tool and how to leave it: stop for a mode with nothing to lose, cancel for a drawing', () => {
		expect(toolStrip({ ...off, measuring: true })).toBe('Measuring · Esc to stop');
		expect(toolStrip({ ...off, mode: 'place', delineating: true })).toBe('Delineating · Esc to stop');
		expect(toolStrip({ ...off, mode: 'place', dividing: true })).toBe('Sub-catchments, one per click · Esc to stop');
		expect(toolStrip({ ...off, mode: 'place', tracing: true })).toBe('Tracing a dam · Esc to stop');
		expect(toolStrip({ ...off, mode: 'place' })).toBe('Placing a point · Esc to cancel');
		expect(toolStrip({ ...off, mode: 'draw' })).toBe('Drawing a shape · Esc to cancel');
		expect(toolStrip({ ...off, mode: 'draw', traced: true })).toBe('Adjusting the traced dam · Esc to cancel');
	});
	it('names the feature being edited or split', () => {
		expect(toolStrip({ ...off, mode: 'edit', featureName: 'Upper farm' })).toBe('Editing “Upper farm” · Esc to cancel');
		expect(toolStrip({ ...off, mode: 'split', featureName: null })).toBe('Splitting the shape · Esc to cancel');
	});
	it('puts measuring first: a measurement is on top of whatever the draft was', () => {
		expect(toolStrip({ ...off, measuring: true, mode: 'draw' })).toBe('Measuring · Esc to stop');
	});
});
