import { describe, expect, it } from 'vitest';
import { cleanModelNames, cleanName, hasNameControlChars } from './names';

describe('names are one line (issue #385)', () => {
	it.each(['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\u009fb', 'a\u2028b', 'a\u2029b'])('%j holds a control character', (s) => {
		expect(hasNameControlChars(s)).toBe(true);
	});

	it.each(['Golf Farm', 'Café Farm', 'Dam 1 (upper)', 'a b', 'a﻿b', '水坝', ''])('%j does not', (s) => {
		expect(hasNameControlChars(s)).toBe(false);
	});

	it('cleanName turns every run of whitespace and control characters into one space, trimmed', () => {
		expect(cleanName('  Golf\r\n\tFarm\u009f ')).toBe('Golf Farm');
		expect(cleanName('a\u2028b')).toBe('a b');
		expect(cleanName('\n\u0001')).toBe('');
	});

	it('cleanModelNames cleans every name and schedule label, leaving the rest and the input alone', () => {
		const model = {
			nodes: [{ id: 'n', name: 'Golf\nFarm', kind: 'farm' }],
			crops: [{ id: 'c', name: 'Vines\u009fD', cropFactor: [] }],
			boreholes: [{ id: 'b', name: 'BH\t1' }],
			demandObjects: [{ id: 'd', name: 'Town\r\nwater', note: 'line one\nline two', schedule: [{ label: 'Easter\nweek', factor: 2 }] }],
			transfers: [],
			cropAreas: []
		};
		const before = JSON.stringify(model);
		const out = cleanModelNames(model);
		expect(out.nodes[0]!.name).toBe('Golf Farm');
		expect(out.crops[0]!.name).toBe('Vines D');
		expect(out.boreholes[0]!.name).toBe('BH 1');
		expect(out.demandObjects[0]).toEqual({ id: 'd', name: 'Town water', note: 'line one\nline two', schedule: [{ label: 'Easter week', factor: 2 }] });
		expect(JSON.stringify(model)).toBe(before);
	});

	it('cleanModelNames adds no list a model lacks and passes anything else through', () => {
		expect(cleanModelNames({ nodes: [] })).toEqual({ nodes: [] });
		expect(cleanModelNames(null)).toBeNull();
		expect(cleanModelNames('x')).toBe('x');
		expect(cleanModelNames({ nodes: 'nope', crops: [null, 3] })).toEqual({ nodes: 'nope', crops: [null, 3] });
	});
});
