import { describe, expect, it, vi } from 'vitest';
import { FlowUnit } from './flowUnit.svelte';

describe('a flow rate shown in m³/s, l/s or m³/day (stored unchanged)', () => {
	it('scales a stored m³/day or m³/s value to the picked unit, starts at its default and remembers the pick', () => {
		const kept = new Map<string, string>();
		vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) });
		const u = new FlowUnit('t.unit', 'm3s');
		expect([u.label, 86_400 * u.scale]).toEqual(['m³/s', 1]);
		u.set('ls');
		expect([u.label, 86_400 * u.scale, u.scaleFromM3s]).toEqual(['l/s', 1000, 1000]);
		u.set('m3day');
		expect([u.label, u.scale, u.scaleFromM3s]).toEqual(['m³/day', 1, 86_400]);
		expect(new FlowUnit('t.unit', 'm3s').id).toBe('m3day');
		kept.set('t.unit', 'gallons');
		expect(new FlowUnit('t.unit', 'ls').id).toBe('ls');
		vi.unstubAllGlobals();
		// No storage at all (a private window): the default, and picking still works.
		const bare = new FlowUnit('t.unit', 'm3day');
		bare.set('ls');
		expect(bare.label).toBe('l/s');
	});
});
