import { describe, expect, it } from 'vitest';
import { isAccountPath, isFarmerOnly } from './frame';

describe('isFarmerOnly', () => {
	it('is true only when every membership is farmer', () => {
		expect(isFarmerOnly(['farmer'])).toBe(true);
		expect(isFarmerOnly(['farmer', 'farmer'])).toBe(true);
		expect(isFarmerOnly(['farmer', 'viewer'])).toBe(false);
		expect(isFarmerOnly(['owner'])).toBe(false);
		expect(isFarmerOnly(['contributor'])).toBe(false);
	});
	it('is false with no memberships (a new account belongs to the workspace)', () => {
		expect(isFarmerOnly([])).toBe(false);
	});
});

describe('isAccountPath', () => {
	it('matches /account and the pages under it, under a base path too', () => {
		expect(isAccountPath('/account')).toBe(true);
		expect(isAccountPath('/account/alerts')).toBe(true);
		expect(isAccountPath('/wm/account/alerts', '/wm')).toBe(true);
	});
	it('does not match lookalikes or other pages', () => {
		expect(isAccountPath('/accounts')).toBe(false);
		expect(isAccountPath('/alerts/unsubscribe')).toBe(false);
		expect(isAccountPath('/farm')).toBe(false);
	});
});
