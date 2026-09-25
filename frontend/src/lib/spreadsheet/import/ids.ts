// Deterministic ids, as extract_project.py makes them: uuid5 of the project
// name under NAMESPACE_URL, then uuid5 of "node:<name>", "crop:<name>" or
// "transfer:<from>><to>:<column>" under that. Re-importing the same workbook
// gives the same ids, in either importer. SHA-1 is written out because
// crypto.subtle.digest is async and the parser is synchronous; ids are not a
// security boundary.

function sha1(bytes: Uint8Array): Uint8Array {
	const ml = bytes.length * 8;
	const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, Math.floor(ml / 2 ** 32));
	view.setUint32(padded.length - 4, ml >>> 0);
	let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
	const w = new Uint32Array(80);
	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 80; i++) {
			const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
			w[i] = (x << 1) | (x >>> 31);
		}
		let a = h0, b = h1, c = h2, d = h3, e = h4;
		for (let i = 0; i < 80; i++) {
			let f: number, k: number;
			if (i < 20) [f, k] = [(b & c) | (~b & d), 0x5a827999];
			else if (i < 40) [f, k] = [b ^ c ^ d, 0x6ed9eba1];
			else if (i < 60) [f, k] = [(b & c) | (b & d) | (c & d), 0x8f1bbcdc];
			else [f, k] = [b ^ c ^ d, 0xca62c1d6];
			const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) >>> 0;
			e = d;
			d = c;
			c = (b << 30) | (b >>> 2);
			b = a;
			a = t;
		}
		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
	}
	const out = new Uint8Array(20);
	const ov = new DataView(out.buffer);
	[h0, h1, h2, h3, h4].forEach((h, i) => ov.setUint32(i * 4, h));
	return out;
}

function parseUuid(u: string): Uint8Array {
	const hex = u.replace(/-/g, '');
	return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function formatUuid(b: Uint8Array): string {
	const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Python uuid.NAMESPACE_URL. */
export const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/** Python uuid.uuid5(namespace, name): SHA-1 of the namespace bytes + the UTF-8 name. */
export function uuid5(namespace: string, name: string): string {
	const ns = parseUuid(namespace);
	const nameBytes = new TextEncoder().encode(name);
	const buf = new Uint8Array(16 + nameBytes.length);
	buf.set(ns);
	buf.set(nameBytes, 16);
	const b = sha1(buf).slice(0, 16);
	b[6] = (b[6]! & 0x0f) | 0x50;
	b[8] = (b[8]! & 0x3f) | 0x80;
	return formatUuid(b);
}

/** The id maker extract_project.py uses for a project called `name`. */
export function projectIds(name: string): (key: string) => string {
	const ns = uuid5(NAMESPACE_URL, `https://water-management.local/wbt-import/${name}`);
	return (key) => uuid5(ns, key);
}
