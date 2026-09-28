// The failed-chunk message (ChunkFailed.svelte) and how nested
// unsaved-changes providers combine. The component itself (Svelte context,
// the Reload button, the reload meeting the beforeunload guard) is pinned by
// e2e/tests/lazy-chunk.spec.ts: the context functions need a client
// component, which this node test environment doesn't render.
import { describe, expect, it } from 'vitest';
import { chunkFailedText, withParent } from './chunkFailed';

describe('chunkFailedText', () => {
	it('names the part and says to reload, with no "Try again"', () => {
		const t = chunkFailedText('The import', false);
		expect(t).toBe('The import could not be loaded. Check your connection, then reload the page.');
		expect(t).not.toMatch(/try again/i);
	});

	it('warns about unsaved changes only when there are some', () => {
		expect(chunkFailedText('This part of the page', true)).toBe(
			'This part of the page could not be loaded. Check your connection, then reload the page. You have unsaved changes: save them first, or the browser will ask before the reload discards them.'
		);
	});
});

describe('withParent', () => {
	it('is the check itself at the top', () => {
		const check = () => true;
		expect(withParent(check, undefined)).toBe(check);
	});

	it('counts either level unsaved, reading both live', () => {
		let outer = false;
		let inner = false;
		const combined = withParent(
			() => inner,
			() => outer
		);
		expect(combined()).toBe(false);
		outer = true;
		expect(combined()).toBe(true);
		outer = false;
		inner = true;
		expect(combined()).toBe(true);
	});
});
