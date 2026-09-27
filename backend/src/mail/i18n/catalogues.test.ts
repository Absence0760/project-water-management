import { describe, expect, it } from 'vitest';
import { LOCALES } from '@water-management/engine/languages';
import { CATALOGUES } from './catalogues.js';

describe('the email catalogue index', () => {
	it('has a catalogue for every language in the table but English, and for nothing else', () => {
		expect(Object.keys(CATALOGUES).sort()).toEqual(LOCALES.filter((l) => l !== 'en').sort());
	});
});
