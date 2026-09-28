import { describe, expect, it } from 'vitest';
import { forceLightForPrint, restoreThemeAfterPrint } from './printTheme';

function fakeRoot(initial: string | null) {
	let v = initial;
	return {
		getAttribute: () => v,
		setAttribute: (_: string, x: string) => void (v = x),
		removeAttribute: () => void (v = null),
		get value() {
			return v;
		}
	};
}

describe('forceLightForPrint / restoreThemeAfterPrint', () => {
	it('prints light over the system theme and removes the attribute again afterwards', () => {
		const root = fakeRoot(null);
		forceLightForPrint(root);
		expect(root.value).toBe('light');
		restoreThemeAfterPrint(root);
		expect(root.value).toBeNull();
	});

	it('puts back an explicit theme', () => {
		const root = fakeRoot('dark');
		forceLightForPrint(root);
		expect(root.value).toBe('light');
		restoreThemeAfterPrint(root);
		expect(root.value).toBe('dark');
	});

	it('is idempotent: a second force keeps the first saved value, and a second restore does nothing', () => {
		const root = fakeRoot('dark');
		forceLightForPrint(root);
		forceLightForPrint(root);
		restoreThemeAfterPrint(root);
		expect(root.value).toBe('dark');
		root.setAttribute('data-theme', 'custom');
		restoreThemeAfterPrint(root);
		expect(root.value).toBe('custom');
	});
});
