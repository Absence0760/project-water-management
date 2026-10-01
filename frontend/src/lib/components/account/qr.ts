// The otpauth QR code on the Account page's two-step sign-in panel (issue
// #282), drawn here, never by a QR web service: the secret in it must not
// leave the browser. uqr (MIT, no dependencies) does the encoding; this turns
// its module grid into one SVG path. Loaded only when someone sets up an
// authenticator (TwoStepSignIn.svelte imports it lazily), so the page chunk
// doesn't carry it.
import { encode } from 'uqr';

export interface QrDrawing {
	/** Modules a side, the quiet zone included. */
	size: number;
	/** One path of 1×1 squares, one per dark module, in module units. */
	path: string;
}

/**
 * The QR code for `text`: error correction M (an authenticator app reads it
 * off a screen, so a little damage tolerance is plenty) and the 4-module quiet
 * zone the standard asks for, so it scans on any background.
 */
export function qrDrawing(text: string): QrDrawing {
	const qr = encode(text, { ecc: 'M', border: 4 });
	let path = '';
	qr.data.forEach((row, y) => {
		row.forEach((dark, x) => {
			if (dark) path += `M${x} ${y}h1v1h-1z`;
		});
	});
	return { size: qr.size, path };
}
