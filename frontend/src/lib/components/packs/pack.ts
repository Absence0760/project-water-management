// Evidence packs on screen (WP-3.14, issue #71; docs/ui.md § Evidence pack and
// § Verify; docs/evidence-pack.md): the stamp every section of a pack prints,
// its verify line, the status words, and the in-browser file check on the
// public verify page. Pure, so each is unit-tested (pack.test.ts); the hash
// itself is WebCrypto's (sha256Hex).
import { packManifestText, type PackManifest } from '@water-management/engine';
import { fmtDate } from '$lib/format/number';
import type { Pack, PackIssueChecks, PackStatus, PackVerification } from '$lib/api';

/** A pack's status in a word, as its badges say it. */
export const PACK_STATUS_LABEL: Record<PackStatus, string> = {
	draft: 'Draft',
	issued: 'Issued',
	superseded: 'Superseded',
	withdrawn: 'Withdrawn'
};

/** The badge tone of a status (ApplicationsTab's pill tones): issued is good, withdrawn bad, the rest neutral. */
export const PACK_STATUS_TONE: Record<PackStatus, 'awaiting' | 'good' | 'mixed' | 'bad'> = {
	draft: 'awaiting',
	issued: 'good',
	superseded: 'mixed',
	withdrawn: 'bad'
};

/**
 * The stamp on every section of a pack (G12): "Issued · version 2 · 2026-09-29",
 * "Draft pack · not issued", "Superseded · version 1 · issued 2026-09-01",
 * "Withdrawn · version 1". A pack withdrawn after it was issued keeps its issue date.
 */
export function packStamp(p: Pick<Pack, 'status' | 'version' | 'issuedAt'>): string {
	const issued = p.issuedAt ? fmtDate(p.issuedAt) : null;
	switch (p.status) {
		case 'draft':
			return 'Draft pack · not issued';
		case 'issued':
			return `Issued · version ${p.version} · ${issued ?? '–'}`;
		case 'superseded':
			return `Superseded · version ${p.version}${issued ? ` · issued ${issued}` : ''}`;
		case 'withdrawn':
			return `Withdrawn · version ${p.version}${issued ? ` · issued ${issued}` : ''}`;
	}
}

/**
 * How the pack view and the verify page name the errata found since a pack's
 * manifest was frozen (errataFoundSince, 132): since issue once it was issued,
 * since the draft before (a draft, or one withdrawn before it was issued).
 * The manifest never changes, so an issued pack can't record them; a draft
 * drafted again does.
 */
export function errataFoundSinceNote(p: { issuedAt: string | null }): { heading: string; note: string } {
	return p.issuedAt
		? {
				heading: 'Errata found since issue',
				note: 'Added to the engine’s errata list after this pack was issued, for the engine of one of its runs (or of the automatic fit its parameters came from). The pack doesn’t record them, and never will: its manifest and hash are fixed. Weigh them with its results.'
			}
		: {
				heading: 'Errata found since this draft was made',
				note: 'Added to the engine’s errata list after this draft froze its manifest, for the engine of one of its runs (or of the automatic fit its parameters came from). The draft doesn’t record them: draft the pack again to record them before it is issued.'
			};
}

/** The public verify page of a short code, on this site: `{origin}{base}/verify/{code}`. */
export const verifyUrl = (origin: string, base: string, shortCode: string) => `${origin}${base}/verify/${encodeURIComponent(shortCode)}`;

/** What an issued pack prints to be verified (G11): its manifest hash, its short code and its verify link. */
export interface VerifyRef {
	sha256: string;
	code: string;
	url: string;
}

/** The pack's VerifyRef on this site, or null for a draft: no verify page answers for a draft. */
export function packVerifyRef(p: Pick<Pack, 'status' | 'manifestSha256' | 'shortCode'>, origin: string, base: string): VerifyRef | null {
	if (p.status === 'draft') return null;
	return { sha256: p.manifestSha256, code: p.shortCode, url: verifyUrl(origin, base, p.shortCode) };
}

/** The verify line in every section and footer: "Manifest SHA-256 … · verify code xxxx-xxxx-xxxx at https://…/verify/xxxx-xxxx-xxxx". */
export const packVerifyLine = (v: VerifyRef) => `Manifest SHA-256 ${v.sha256} · verify code ${v.code} at ${v.url}`;

/** The manifest's canonical text (RFC 8785) as a file: the bytes its SHA-256 is taken of, so the downloaded file checks on /verify. */
export const manifestFileText = (m: PackManifest): string => packManifestText(m);

/** A file name for a pack's manifest: `evidence-pack-<code>-manifest.json`. */
export const manifestFileName = (shortCode: string) => `evidence-pack-${shortCode}-manifest.json`;

/** SHA-256 of bytes, as lower-case hex, with the browser's WebCrypto. Nothing leaves the browser. */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
	const digest = await subtle.digest('SHA-256', bytes as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the file check found. */
export type FileCheck =
	| { result: 'pdf'; sha256: string }
	| { result: 'bundle'; sha256: string }
	| { result: 'manifest'; sha256: string; canonical: boolean }
	| { result: 'no-match'; sha256: string };

/**
 * Check a file against a verified pack: its SHA-256 against the PDF's, the
 * reproduction bundle's and the manifest's. A JSON file that doesn't match byte for byte is tried once more
 * as a manifest in its canonical form (RFC 8785, as the hash is taken), so a
 * manifest saved pretty-printed still checks; any change to what it says
 * changes the canonical text too. `hash` is sha256Hex (a parameter for tests).
 */
export async function checkFile(
	bytes: Uint8Array,
	v: Pick<PackVerification, 'manifestSha256' | 'pdfSha256'> & Partial<Pick<PackVerification, 'bundleSha256'>>,
	hash: (b: Uint8Array) => Promise<string> = (b) => sha256Hex(b)
): Promise<FileCheck> {
	const sha256 = await hash(bytes);
	if (v.pdfSha256 && sha256 === v.pdfSha256) return { result: 'pdf', sha256 };
	if (v.bundleSha256 && sha256 === v.bundleSha256) return { result: 'bundle', sha256 };
	if (sha256 === v.manifestSha256) return { result: 'manifest', sha256, canonical: false };
	const canonical = canonicalOf(bytes);
	if (canonical !== null && (await hash(new TextEncoder().encode(canonical))) === v.manifestSha256) return { result: 'manifest', sha256, canonical: true };
	return { result: 'no-match', sha256 };
}

/** What a verified pack's file check takes, in words: "manifest", "PDF or manifest", "PDF, reproduction bundle or manifest". */
export function checkableFiles(v: Pick<PackVerification, 'pdfSha256'> & Partial<Pick<PackVerification, 'bundleSha256'>>): string {
	const kinds = [...(v.pdfSha256 ? ['PDF'] : []), ...(v.bundleSha256 ? ['reproduction bundle'] : []), 'manifest'];
	return kinds.length === 1 ? kinds[0]! : `${kinds.slice(0, -1).join(', ')} or ${kinds.at(-1)}`;
}

/** The file types the check's picker offers. */
export function checkableAccept(v: Pick<PackVerification, 'pdfSha256'> & Partial<Pick<PackVerification, 'bundleSha256'>>): string {
	return [...(v.pdfSha256 ? ['.pdf', 'application/pdf'] : []), ...(v.bundleSha256 ? ['.zip', 'application/zip'] : []), '.json', 'application/json'].join(',');
}

/** The RFC 8785 text of a file that is a JSON manifest, or null for anything else. */
function canonicalOf(bytes: Uint8Array): string | null {
	if (bytes.byteLength > 50 * 1024 * 1024 || bytes[0] === 0x25 /* %PDF */ || (bytes[0] === 0x50 && bytes[1] === 0x4b) /* PK: a zip */) return null;
	try {
		const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
		return packManifestText(value as PackManifest);
	} catch {
		return null;
	}
}

/** Packs grouped by application (scenario id; `null` for baseline evidence), newest version first in each. */
export function packsByScenario(packs: readonly Pack[]): Map<string | null, Pack[]> {
	const out = new Map<string | null, Pack[]>();
	for (const p of packs) {
		const list = out.get(p.scenarioId) ?? [];
		list.push(p);
		out.set(p.scenarioId, list);
	}
	for (const list of out.values()) list.sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt));
	return out;
}

/** The packs of one run's report: an application pack cites its scenario run, a baseline pack only the nominated run. */
export const packsOfRun = (packs: readonly Pack[], runId: string) =>
	packs.filter((p) => (p.scenarioRunId ? p.scenarioRunId === runId : p.baselineRunId === runId && p.mode === 'baseline'));

/**
 * The issued pack a new draft of this report would supersede: one issued pack
 * per application (or per project's baseline evidence), so a second pack of
 * the same application is a new version of it.
 */
export const issuedOf = (packs: readonly Pack[], scenarioId: string | null) => packs.find((p) => p.status === 'issued' && p.scenarioId === scenarioId) ?? null;

/** A pack's page in the workspace. */
export const packHref = (base: string, projectId: string, packId: string) => `${base}/projects/${encodeURIComponent(projectId)}/packs/${encodeURIComponent(packId)}`;

/** A draft's checklist before issue, from the API's `issue` (an editor's read of a draft), in the order to do them. */
export function issueChecklist(c: PackIssueChecks): { id: keyof PackIssueChecks; ok: boolean; done: string; todo: string }[] {
	return [
		{
			id: 'issuable',
			ok: c.issuable,
			done: 'The frozen report may be issued: no check that stops issue fails.',
			todo: 'The frozen report can’t be issued: a check that stops issue failed when it was drafted. Withdraw it and draft again once the report passes.'
		},
		{
			id: 'runsVerified',
			ok: c.runsVerified,
			done: 'Both runs still carry the server’s stamp.',
			todo: 'A run it cites no longer matches the server’s stamp, so it can’t be signed or issued.'
		},
		{
			id: 'signed',
			ok: c.signed,
			done: 'Signed off under the current pack statement.',
			todo: 'Not signed under the current pack statement: a registered professional signs it in Appendix B.2 (again, if the statement changed since).'
		}
	];
}

/**
 * A guard against stale responses: each `begin()` starts a new request and
 * returns a check that stays true only while no later request has begun. A
 * page that loads on navigation applies an answer only when its check is
 * still true, so a slow first lookup can't overwrite a later one.
 */
export function latestOnly(): { begin: () => () => boolean } {
	let seq = 0;
	return {
		begin() {
			const mine = ++seq;
			return () => mine === seq;
		}
	};
}

/** What the verify page shows for a code: a lookup's outcome, as its states. */
export type VerifyLookup =
	| { status: 'no-code' | 'not-found' }
	| { status: 'found'; v: PackVerification }
	| { status: 'error'; error: string };

/**
 * Look a code up for the verify page: no code asks for one; a code that
 * can't be a pack's (`parse`) or that the API answers 404 is "not found",
 * the same answer whatever the reason; any other failure is an error.
 */
export async function lookUpCode(
	code: string,
	parse: (c: string) => unknown,
	verify: (c: string) => Promise<PackVerification>,
	isNotFound: (e: unknown) => boolean
): Promise<VerifyLookup> {
	if (!code) return { status: 'no-code' };
	if (!parse(code)) return { status: 'not-found' };
	try {
		return { status: 'found', v: await verify(code) };
	} catch (e) {
		if (isNotFound(e)) return { status: 'not-found' };
		return { status: 'error', error: e instanceof Error ? e.message : String(e) };
	}
}
