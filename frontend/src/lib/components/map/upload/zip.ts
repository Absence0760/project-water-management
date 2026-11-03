// A small zip reader for the Map's upload (a zipped shapefile, a KMZ;
// docs/maps.md § Uploads, docs/security.md § Input handling). Its own code
// rather than a library's because the caps are the point: a zip is an
// untrusted file, and one of a few kilobytes can inflate to gigabytes. So
// only the entries asked for are inflated, each refused when its declared
// size passes what is left of the budget, and inflation itself is counted
// as it streams (DecompressionStream, no dependency) and stopped the moment
// it passes the entry's declared size or the budget: a zip that lies about
// its sizes is refused, never trusted. Stored (0) and deflated (8) entries
// only; encrypted entries, ZIP64 and other methods are refused.
import { UploadRefused } from './common';

export interface ZipEntry {
	/** The entry's path in the zip, `/`-separated. */
	name: string;
	method: number;
	compressedSize: number;
	size: number;
	encrypted: boolean;
	localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export const BROKEN_ZIP = 'This file isn’t a zip we can open: it may be damaged or only partly downloaded.';

/** The zip's entries, from its central directory; nothing inflated. Throws UploadRefused for anything but a plain zip. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// The end-of-central-directory record: 22 bytes, plus a comment of up to 64 KB, at the end.
	let eocd = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
		if (view.getUint32(i, true) === EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new UploadRefused(BROKEN_ZIP);
	const count = view.getUint16(eocd + 10, true);
	const cdSize = view.getUint32(eocd + 12, true);
	const cdOffset = view.getUint32(eocd + 16, true);
	if (count === 0xffff || cdOffset === 0xffffffff) throw new UploadRefused('This zip is too large to read here (ZIP64); split the layer or simplify it.');
	if (cdOffset + cdSize > eocd) throw new UploadRefused(BROKEN_ZIP);
	const names = new TextDecoder();
	const out: ZipEntry[] = [];
	let p = cdOffset;
	for (let i = 0; i < count; i++) {
		if (p + 46 > eocd || view.getUint32(p, true) !== CEN_SIG) throw new UploadRefused(BROKEN_ZIP);
		const flags = view.getUint16(p + 8, true);
		const method = view.getUint16(p + 10, true);
		const compressedSize = view.getUint32(p + 20, true);
		const size = view.getUint32(p + 24, true);
		const nameLen = view.getUint16(p + 28, true);
		const extraLen = view.getUint16(p + 30, true);
		const commentLen = view.getUint16(p + 32, true);
		const localOffset = view.getUint32(p + 42, true);
		if (p + 46 + nameLen > eocd) throw new UploadRefused(BROKEN_ZIP);
		const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
		out.push({ name, method, compressedSize, size, encrypted: (flags & 1) === 1, localOffset });
		p += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

/** Whether an entry is a file worth reading: not a folder, nor macOS's `__MACOSX/` or `._x` resource forks. */
export function isContentEntry(name: string): boolean {
	if (name.endsWith('/') || name.split('/').includes('__MACOSX')) return false;
	const base = name.slice(name.lastIndexOf('/') + 1);
	return base !== '' && !base.startsWith('._');
}

/**
 * The entries' bytes, inflated, with at most `budget` bytes out in all. Each
 * entry's declared size counts against the budget before it is inflated, and
 * inflation stops at whichever is smaller, its declared size or what is left.
 */
export async function readEntries(bytes: Uint8Array, entries: readonly ZipEntry[], budget: number, overBudget: string): Promise<Map<string, Uint8Array>> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out = new Map<string, Uint8Array>();
	let left = budget;
	for (const e of entries) {
		if (e.encrypted) throw new UploadRefused('This zip is password-protected; upload one without a password.');
		if (e.method !== 0 && e.method !== 8) throw new UploadRefused('This zip uses a compression method we can’t read; zip it again with ordinary (deflate) compression.');
		if (e.size === 0xffffffff || e.compressedSize === 0xffffffff) throw new UploadRefused('This zip is too large to read here (ZIP64); split the layer or simplify it.');
		if (e.size > left) throw new UploadRefused(overBudget);
		const p = e.localOffset;
		if (p + 30 > bytes.length || view.getUint32(p, true) !== LOC_SIG) throw new UploadRefused(BROKEN_ZIP);
		const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
		const end = start + e.compressedSize;
		if (end > bytes.length) throw new UploadRefused(BROKEN_ZIP);
		const data = bytes.subarray(start, end);
		let body: Uint8Array;
		if (e.method === 0) {
			if (e.compressedSize !== e.size) throw new UploadRefused(BROKEN_ZIP);
			body = data;
		} else {
			body = await inflateRaw(data, e.size);
		}
		left -= body.length;
		out.set(e.name, body);
	}
	return out;
}

/** Raw deflate, refused as soon as more than `limit` bytes come out, and when fewer than `limit` do (the entry said `limit`). */
async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
	const ds = new DecompressionStream('deflate-raw');
	const writer = ds.writable.getWriter();
	// A copy into a plain ArrayBuffer: the stream takes a BufferSource, and the caller's view may be over a shared one.
	writer.write(data.slice()).catch(() => {});
	writer.close().catch(() => {});
	const reader = ds.readable.getReader();
	const chunks: Uint8Array[] = [];
	let n = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			n += value.length;
			if (n > limit) {
				await reader.cancel().catch(() => {});
				throw new UploadRefused(BROKEN_ZIP);
			}
			chunks.push(value);
		}
	} catch (e) {
		if (e instanceof UploadRefused) throw e;
		throw new UploadRefused(BROKEN_ZIP);
	}
	if (n !== limit) throw new UploadRefused(BROKEN_ZIP);
	const out = new Uint8Array(n);
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}
