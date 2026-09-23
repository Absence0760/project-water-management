import { createHash } from 'node:crypto';

// RFC 4122 v5 (SHA-1, name-based) under a fixed namespace, so example ids are
// stable across re-seeds. The import script remaps them to fresh ids anyway.
const NAMESPACE = Buffer.from('6f1d7c3e2a9b4e0f8c5d1a2b3c4d5e6f', 'hex');

export function v5(name: string): string {
	const h = createHash('sha1').update(NAMESPACE).update(name).digest();
	h[6] = (h[6]! & 0x0f) | 0x50;
	h[8] = (h[8]! & 0x3f) | 0x80;
	const x = h.subarray(0, 16).toString('hex');
	return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
