// The preview's run-input cache: the last run fetched is reused, another
// run is fetched, and a failed fetch isn't kept.
import type { ModelInput } from '@water-management/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetRunInput, runInputFor } from './inputs';

const input = (tag: string) => ({ tag }) as unknown as ModelInput;

describe('runInputFor', () => {
	beforeEach(forgetRunInput);

	it('fetches a run once, then reuses it', async () => {
		const fetch = vi.fn(async (_p: string, r: string) => input(r));
		await expect(runInputFor('p', 'r1', fetch)).resolves.toEqual(input('r1'));
		await expect(runInputFor('p', 'r1', fetch)).resolves.toEqual(input('r1'));
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('keeps one run only: another run (or project) is fetched', async () => {
		const fetch = vi.fn(async (p: string, r: string) => input(`${p}/${r}`));
		await runInputFor('p', 'r1', fetch);
		await expect(runInputFor('p', 'r2', fetch)).resolves.toEqual(input('p/r2'));
		await expect(runInputFor('q', 'r2', fetch)).resolves.toEqual(input('q/r2'));
		await runInputFor('p', 'r1', fetch);
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	it("doesn't keep a failed fetch", async () => {
		const fetch = vi.fn().mockRejectedValueOnce(new Error('409')).mockResolvedValueOnce(input('ok'));
		await expect(runInputFor('p', 'r1', fetch)).rejects.toThrow('409');
		await expect(runInputFor('p', 'r1', fetch)).resolves.toEqual(input('ok'));
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
