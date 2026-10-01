// The QR drawing (qr.ts): a square grid with its quiet zone, dark modules as
// unit squares, and deterministic for one input.
import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';
import { qrDrawing } from './qr';

const URI = 'otpauth://totp/Water%20Management:a%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Water%20Management&algorithm=SHA1&digits=6&period=30';

describe('qrDrawing', () => {
	it('draws one unit square per dark module, with a 4-module quiet zone', () => {
		const d = qrDrawing(URI);
		const grid = encode(URI, { ecc: 'M', border: 4 });
		expect(d.size).toBe(grid.size);
		const squares = d.path.match(/M\d+ \d+h1v1h-1z/g) ?? [];
		expect(squares.join('')).toBe(d.path);
		expect(squares).toHaveLength(grid.data.flat().filter(Boolean).length);
		// Nothing dark in the quiet zone.
		for (const s of squares) {
			const [x, y] = s.slice(1).split(/[ h]/).map(Number) as [number, number];
			expect(x >= 4 && y >= 4 && x < d.size - 4 && y < d.size - 4, s).toBe(true);
		}
	});
	it('is the same drawing for the same text, and a different one for another secret', () => {
		expect(qrDrawing(URI)).toEqual(qrDrawing(URI));
		expect(qrDrawing(URI.replace('GEZD', 'MFRG')).path).not.toBe(qrDrawing(URI).path);
	});
});
