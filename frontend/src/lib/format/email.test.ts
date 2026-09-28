import { describe, expect, it } from 'vitest';
import { emailParts } from './email';

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
	it('leaves an address without break points whole', () => {
		expect(emailParts('nobreaks')).toEqual(['nobreaks']);
	});
});
