import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import FarmFrameHost from './__fixtures__/FarmFrameHost.svelte';
import FarmFrameProbe from './__fixtures__/FarmFrameProbe.svelte';
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

describe('farmFrameReader / provideFarmFrame', () => {
	it('outside the root layout, never the farm frame', () => {
		let reader: (() => boolean) | undefined;
		// The renderer runs on reading the body.
		void render(FarmFrameProbe, { props: { onread: (r) => (reader = r) } }).body;
		expect(reader!()).toBe(false);
	});

	it('under the root layout, what it provides, read when called so it follows a change', () => {
		let inFrame = true;
		let reader: (() => boolean) | undefined;
		void render(FarmFrameHost, { props: { inFarmFrame: () => inFrame, onread: (r) => (reader = r) } }).body;
		expect(reader!()).toBe(true);
		inFrame = false;
		expect(reader!()).toBe(false);
	});
});
