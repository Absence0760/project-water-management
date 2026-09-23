// Fetch an export and hand it to the browser as a file. Downloads go through
// fetch (not a bare <a href>) so a 404/413 shows the server's message in the
// page instead of navigating to a JSON error body.
import { fallbackFilename, filenameFromDisposition } from './urls';

export class DownloadError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'DownloadError';
	}
}

/** GET `url` with the session cookie; resolve to the file, or throw DownloadError with a readable message. */
export async function fetchDownload(
	url: string,
	fetchFn: typeof fetch = (...a) => fetch(...a)
): Promise<{ blob: Blob; filename: string }> {
	let res: Response;
	try {
		res = await fetchFn(url, { credentials: 'include' });
	} catch {
		throw new DownloadError(0, 'Could not reach the server');
	}
	if (!res.ok) {
		let msg = '';
		try {
			const body = (await res.json()) as { error?: unknown };
			if (typeof body.error === 'string') msg = body.error;
		} catch {
			/* not JSON */
		}
		if (!msg) {
			msg =
				res.status === 401
					? 'You are not signed in'
					: res.status === 404
						? 'Not found — the run or series may have been deleted'
						: `Download failed (${res.status})`;
		}
		throw new DownloadError(res.status, msg);
	}
	const blob = await res.blob();
	return { blob, filename: filenameFromDisposition(res.headers.get('content-disposition'), fallbackFilename(url)) };
}

/** Browser-only: save a blob under `filename` via a temporary object URL. */
export function saveBlob(blob: Blob, filename: string): void {
	const href = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = href;
	a.download = filename;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
	// Give the browser a tick to start the download before revoking.
	setTimeout(() => URL.revokeObjectURL(href), 0);
}
