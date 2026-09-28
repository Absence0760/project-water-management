// The app-wide API instance, bound to PUBLIC_API_URL. Tests import createApi
// from ./client directly so they don't need SvelteKit's $env modules.
import { PUBLIC_API_URL } from '$env/static/public';
import { createApi } from './client';

export const api = createApi(PUBLIC_API_URL);
export { ApiError, createApi, scenarioProblems } from './client';
export type { Api } from './client';
export * from './types';
