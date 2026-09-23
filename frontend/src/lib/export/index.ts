// Download URLs bound to the app's API base (PUBLIC_API_URL). Tests import
// ./urls directly so they don't need SvelteKit's $env modules.
import { PUBLIC_API_URL } from '$env/static/public';
import { exportUrls } from './urls';

export const downloads = exportUrls(PUBLIC_API_URL);
export { exportUrls, runDownloadItems, filenameFromDisposition, fallbackFilename } from './urls';
export type { DailyWindow, DownloadItem, ExportUrls } from './urls';
