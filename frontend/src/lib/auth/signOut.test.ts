// Every sign-out path ends in forgetSession (signOut.ts): it forgets what this
// device kept for the person, the assistant's past chats included (issue
// #610, assistant/historyClear.ts), before the sign-in page; signOutTo does
// the same when the server's logout fails.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
vi.mock('$app/navigation', () => ({ goto: vi.fn(async (to: string) => void calls.push(`goto ${to}`)) }));
vi.mock('#lib/nav/base.js', () => ({ basePath: () => '' }));
vi.mock('#lib/api/index.js', () => ({ api: { auth: { logout: vi.fn(async () => Promise.reject(new Error('offline'))) } } }));
vi.mock('#lib/auth/session.svelte.js', () => ({ session: { user: { id: 'u1' } } }));
vi.mock('#lib/components/farm/savedCopy.js', () => ({ clearAllSaved: () => void calls.push('farm copies') }));
vi.mock('#lib/components/notes/counts.svelte.js', () => ({ clearNoteCounts: () => void calls.push('note counts') }));
vi.mock('#lib/components/assistant/historyClear.js', () => ({ clearAllChatHistory: () => void calls.push('past chats') }));

const { forgetSession, signOutTo } = await import('./signOut');
const { session } = await import('#lib/auth/session.svelte.js');

describe('signing out on this device', () => {
	beforeEach(() => {
		calls.length = 0;
		(session as { user: unknown }).user = { id: 'u1' };
	});

	it('forgetSession deletes the past chats with the rest, then goes to the sign-in page', async () => {
		await forgetSession();
		expect(calls).toEqual(['farm copies', 'note counts', 'past chats', 'goto /login']);
		expect(session.user).toBeNull();
	});

	it('signOutTo deletes them too when the server’s logout fails', async () => {
		await signOutTo('/login?next=%2F');
		expect(calls).toContain('past chats');
		expect(calls.at(-1)).toBe('goto /login?next=%2F');
	});
});
