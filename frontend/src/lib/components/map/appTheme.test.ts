import { describe, expect, it } from 'vitest';
import { appIsDark } from './appTheme';

const root = (theme: string | null) => ({ getAttribute: () => theme });

describe('appIsDark', () => {
	it('follows the app’s data-theme over the OS preference', () => {
		expect(appIsDark(root('dark'), () => false)).toBe(true);
		expect(appIsDark(root('light'), () => true)).toBe(false);
	});
	it('falls back to the OS preference when the app sets no theme', () => {
		expect(appIsDark(root(null), () => true)).toBe(true);
		expect(appIsDark(root(null), () => false)).toBe(false);
	});
});
