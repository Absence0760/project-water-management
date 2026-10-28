// Forgetting the assistant's past chats kept in this browser (history.ts;
// docs/security.md § Personal information). Its own small module because
// every sign-out path imports it (lib/auth/signOut.ts, the terms page's Sign
// out, the root layout when the session has ended), and the history code
// itself loads only with the assistant's panel.

/** The IndexedDB database the past chats live in (history.ts idbBackend). */
export const CHAT_HISTORY_DB = 'wm-assistant-history';

/**
 * Delete every past chat in this browser, every user's (sign-out, an ended
 * session). An open connection closes itself on the delete's versionchange
 * (history.ts), so the delete isn't blocked. Never throws: storage that is
 * blocked or missing kept nothing.
 */
export function clearAllChatHistory(factory: Pick<IDBFactory, 'deleteDatabase'> | null | undefined = idb()): void {
	try {
		factory?.deleteDatabase(CHAT_HISTORY_DB);
	} catch {
		// Storage unavailable: nothing was kept.
	}
}

function idb(): IDBFactory | null {
	try {
		return globalThis.indexedDB ?? null;
	} catch {
		return null;
	}
}
