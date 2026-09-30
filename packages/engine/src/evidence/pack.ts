// The licensing evidence pack (roadmap WP-3.14, issue #71; docs/evidence-pack.md):
// the manifest an issued pack freezes, and its short code. Pure, like the rest
// of the engine: the manifest's canonical text (RFC 8785, manifest.ts) is
// built here, and the SHA-256 of that text is taken by the caller (the backend
// with node:crypto, the browser with WebCrypto).
//
// What the hash covers: the pack's identity (id, version, the pack it
// supersedes and that pack's hash), the project, the engine that built the
// manifest, and the evidence report exactly as the API serves it. What it
// doesn't: the pack's status and its dates, who issued it, the PDF and the
// reproduction bundle (each has its own SHA-256), and the sign-offs (each
// binds the manifest hash through its statement, liability/signoff.ts). So a
// pack moves from draft to issued, superseded or withdrawn with its hash
// unchanged.
import { canonicalJson } from '../manifest';
import type { EvidenceReport } from './types';

/** Bumped whenever the manifest's shape changes; the manifest records it. */
export const PACK_MANIFEST_VERSION = 'pack-1';

export interface PackManifest {
	version: typeof PACK_MANIFEST_VERSION;
	pack: {
		id: string;
		/** 1 for a first pack; the predecessor's version + 1 for a new version. */
		version: number;
		/** The issued pack this version replaces, by id and manifest hash; null for a first pack. */
		supersedes: { id: string; manifestSha256: string } | null;
	};
	project: { id: string; name: string };
	/** The engine that built the manifest; `build` is the git SHA when the server knows it. */
	engine: { version: string; build: string | null };
	/** The evidence report, as GET …/evidence-report serves it (JSON: NaN became null, undefined members dropped). */
	report: EvidenceReport;
}

export interface PackManifestInput {
	pack: PackManifest['pack'];
	project: PackManifest['project'];
	report: EvidenceReport;
	engine: PackManifest['engine'];
}

/**
 * The manifest of a pack. The report goes through JSON first, as the API
 * serves it and as jsonb stores it: a NaN becomes null and an undefined member
 * is dropped, so the text hashed at creation is the text rebuilt from the
 * stored manifest.
 */
export function buildPackManifest(input: PackManifestInput): PackManifest {
	if (!Number.isInteger(input.pack.version) || input.pack.version < 1) throw new RangeError('a pack version is a whole number from 1');
	if ((input.pack.version === 1) !== (input.pack.supersedes === null)) throw new RangeError('a first pack supersedes nothing, and a later version supersedes its predecessor');
	return {
		version: PACK_MANIFEST_VERSION,
		pack: { id: input.pack.id, version: input.pack.version, supersedes: input.pack.supersedes ? { ...input.pack.supersedes } : null },
		project: { id: input.project.id, name: input.project.name },
		engine: { version: input.engine.version, build: input.engine.build },
		report: JSON.parse(JSON.stringify(input.report)) as EvidenceReport
	};
}

/** The text whose SHA-256 is the pack's manifest hash (RFC 8785; the caller hashes it). */
export const packManifestText = (m: PackManifest): string => canonicalJson(m);

/** Characters of the manifest hash in the short code. */
export const PACK_SHORT_CODE_LENGTH = 12;

/** The short code printed on a pack and in its verify link: the manifest hash's first 12 hex digits, as `xxxx-xxxx-xxxx`. */
export function packShortCode(manifestSha256: string): string {
	if (!/^[0-9a-f]{64}$/.test(manifestSha256)) throw new TypeError('not a SHA-256 hex digest');
	return manifestSha256.slice(0, PACK_SHORT_CODE_LENGTH).match(/.{4}/g)!.join('-');
}

/**
 * A code someone typed or followed: a short code or a full manifest hash, any
 * case, with or without dashes and spaces. Null for anything else.
 */
export function parsePackCode(code: string): { kind: 'short' | 'full'; value: string } | null {
	const c = code.toLowerCase().replace(/[\s-]/g, '');
	if (/^[0-9a-f]{64}$/.test(c)) return { kind: 'full', value: c };
	if (c.length === PACK_SHORT_CODE_LENGTH && /^[0-9a-f]+$/.test(c)) return { kind: 'short', value: c };
	return null;
}
