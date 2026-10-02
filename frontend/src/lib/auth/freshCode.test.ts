import { describe, expect, it } from 'vitest';
import { answerCode, askForCode, freshCode } from './freshCode.svelte';

describe('asking for a fresh code', () => {
	it('opens the dialog and resolves with its answer; a second ask while open waits on the same one', async () => {
		const a = askForCode();
		const b = askForCode();
		expect(freshCode.open).toBe(true);
		answerCode(true);
		expect(freshCode.open).toBe(false);
		await expect(a).resolves.toBe(true);
		await expect(b).resolves.toBe(true);
	});

	it('a cancel resolves false, and the next ask is a new question', async () => {
		const a = askForCode();
		answerCode(false);
		await expect(a).resolves.toBe(false);
		const b = askForCode();
		answerCode(true);
		await expect(b).resolves.toBe(true);
	});
});
