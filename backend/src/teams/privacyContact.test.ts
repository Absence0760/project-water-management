import { describe, expect, it } from 'vitest';
import { PrivacyContactInput, toPrivacyContact } from './privacyContact.js';

describe('PrivacyContactInput', () => {
	it('trims, and stores a blank or missing postal address as none', () => {
		expect(PrivacyContactInput.parse({ name: ' Info officer ', email: ' io@example.org ', postal: '  ' })).toEqual({ name: 'Info officer', email: 'io@example.org', postal: null });
		expect(PrivacyContactInput.parse({ name: 'A', email: 'a@example.org' })).toEqual({ name: 'A', email: 'a@example.org', postal: null });
		expect(PrivacyContactInput.parse({ name: 'A', email: 'a@example.org', postal: 'PO Box 1\nTown' }).postal).toBe('PO Box 1\nTown');
	});

	it('refuses a missing name, a bad address, too-long text and unknown keys', () => {
		expect(PrivacyContactInput.safeParse({ name: ' ', email: 'a@example.org' }).success).toBe(false);
		expect(PrivacyContactInput.safeParse({ name: 'A', email: 'not an address' }).success).toBe(false);
		expect(PrivacyContactInput.safeParse({ name: 'x'.repeat(201), email: 'a@example.org' }).success).toBe(false);
		expect(PrivacyContactInput.safeParse({ name: 'A', email: 'a@example.org', postal: 'x'.repeat(501) }).success).toBe(false);
		expect(PrivacyContactInput.safeParse({ name: 'A', email: 'a@example.org', phone: '1' }).success).toBe(false);
	});
});

describe('toPrivacyContact', () => {
	it('is null when not set, else the three fields', () => {
		expect(toPrivacyContact({ privacy_contact_name: null, privacy_contact_email: null, privacy_contact_postal: null })).toBeNull();
		expect(toPrivacyContact({ privacy_contact_name: 'A', privacy_contact_email: 'a@example.org', privacy_contact_postal: null })).toEqual({ name: 'A', email: 'a@example.org', postal: null });
	});
});
