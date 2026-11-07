// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
	namespace App {
		/** What the error page (routes/+error.svelte) shows; `id` is the crash's error id (hooks.client.ts). */
		interface Error {
			status: number;
			message: string;
			id?: string;
		}
		// interface Locals {}
		// interface PageData {}
		// interface Platform {}
	}
	/** The engine build record as JSON, or '' (vite.config.ts `define`; lib/components/liability/engineBuild.ts). */
	const __ENGINE_BUILD__: string;
}

export {};
