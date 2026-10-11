import { describe, expect, it } from 'vitest';
import { emailGroups, emailParts } from './email';

describe('emailParts', () => {
	it('breaks before the @ and after dots, hyphens, underscores and plus signs', () => {
		expect(emailParts('jo.smith@farm-a.example')).toEqual(['jo.', 'smith', '@farm-', 'a.', 'example']);
		expect(emailParts('first_last+water@x.co')).toEqual(['first_', 'last+', 'water', '@x.', 'co']);
	});
	it('always joins back to the address', () => {
		for (const e of ['a@b.c', 'catchment.hydrology.consultant@very-long-subdomain.example.com', 'plain', '.lead@x.', '']) {
			expect(emailParts(e).join('')).toBe(e);
		}
	});
	it('wraps only before the @ and after a dot when told so (the team page, issue #520)', () => {
		expect(emailParts('thandiwe-mokoena_v+w@farm-a.example.com', '.')).toEqual(['thandiwe-mokoena_v+w', '@farm-a.', 'example.', 'com']);
		expect(emailParts('a-b@c-d', '')).toEqual(['a-b', '@c-d']);
		// A character a regex class treats specially is taken as itself.
		expect(emailParts('a]b^c-d\\e@x', ']^-\\')).toEqual(['a]', 'b^', 'c-', 'd\\', 'e', '@x']);
		for (const e of ['jo.smith@farm-a.example', 'x@y']) expect(emailParts(e, '.').join('')).toBe(e);
	});
	it('leaves an address without break points whole', () => {
		expect(emailParts('nobreaks')).toEqual(['nobreaks']);
	});
});

describe('emailGroups', () => {
	it('groups the parts at the @: the name, then the domain', () => {
		expect(emailGroups('jo.smith@farm-a.example')).toEqual([['jo.', 'smith'], ['@farm-', 'a.', 'example']]);
		expect(emailGroups('demo@example.com', '.')).toEqual([['demo'], ['@example.', 'com']]);
		expect(emailGroups('@x.co', '.')).toEqual([['@x.', 'co']]);
		expect(emailGroups('plain')).toEqual([['plain']]);
		expect(emailGroups('')).toEqual([]);
		for (const e of ['a.b@c.d', 'x-y@z']) expect(emailGroups(e).flat().join('')).toBe(e);
	});
});
