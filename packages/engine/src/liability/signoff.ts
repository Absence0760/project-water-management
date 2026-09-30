// What a professional sign-off on a run confirms (roadmap WP-3.13). The
// statement is built here, purely, from the run's identity and the committed
// limitations list; the backend hashes its canonical text (SHA-256) and a
// sign-off records that hash, so a signature is bound to the exact words it
// was shown. If the statements, the limitations or the disclaimer change
// between showing the dialog and submitting it, the hash no longer matches
// and the sign-off is refused.
import { canonicalJson } from '../manifest';
import { DISCLAIMER } from './disclaimer';
import { errataFor, type Erratum } from './errata';
import { ENGINE_ERRATA } from './errata.generated';
import type { Limitation } from './limitations';
import { KNOWN_LIMITATIONS } from './limitations.generated';
import type { MethodologyVersion } from './methodology';
import { METHODOLOGY } from './methodology.generated';

/**
 * Bumped whenever a statement's wording or the statement's shape changes. A
 * stored sign-off keeps the version and hash it was made under (signoff-1
 * and signoff-2 rows keep theirs); new sign-offs are made against this one
 * only. signoff-3 (issue #47): the identity confirmation covers the category
 * and field recorded with the registration (registration.ts). signoff-4
 * (issue #71): the statement cites the methodology statement by version and
 * hash, lists the errata of the run's engine version, and the limitations
 * confirmation covers both.
 */
export const SIGNOFF_STATEMENT_VERSION = 'signoff-4';

export interface SignoffConfirmation {
	/** `pack`: a pack sign-off's own confirmation (packSignoffStatement). */
	id: 'identity' | 'competence' | 'conflict' | 'inputs' | 'calibration' | 'ewr' | 'works' | 'assurance' | 'plausibility' | 'limitations' | 'pack';
	text: string;
}

export interface SignoffStatement {
	version: string;
	/** The run signed, and the engine that made it. */
	runId: string;
	engineVersion: string;
	/** A scenario run confirms that the scenario represents the proposed works; a baseline run, the existing ones. */
	scenario: boolean;
	/** Each ticked on its own in the dialog. */
	confirmations: SignoffConfirmation[];
	/** The known limitations the signer confirms they read (engine-audit.md, generated). */
	limitations: readonly Limitation[];
	/** Known bugs of the run's engine version the signer confirms they read (engine-errata.md, generated). */
	errata: Erratum[];
	/** The methodology statement the run's methods are described by (docs/methodology). */
	methodology: Pick<MethodologyVersion, 'version' | 'sha256'>;
	/** Printed with the statement, not confirmed: what the signature does not cover. */
	notes: string[];
	disclaimerVersion: string;
}

export interface SignoffRun {
	id: string;
	engineVersion: string;
	/** The run was made by a scenario (model_run.scenario_id). */
	scenario: boolean;
	/** The engine of the automatic fit the run's parameters came from (settings.fitRecord.engineVersion); null for entered parameters. */
	fitEngineVersion?: string | null;
}

/** The statement a signer of this run is shown and confirms. */
export function signoffStatement(
	run: SignoffRun,
	limitations: readonly Limitation[] = KNOWN_LIMITATIONS,
	errata: readonly Erratum[] = ENGINE_ERRATA
): SignoffStatement {
	return {
		version: SIGNOFF_STATEMENT_VERSION,
		runId: run.id,
		engineVersion: run.engineVersion,
		scenario: run.scenario,
		confirmations: [
			{
				id: 'identity',
				text: 'I am the person named above, and I am currently registered with the body, in the category and field, and under the registration number shown.'
			},
			{ id: 'competence', text: 'This work is within my competence and the category of my registration, and I did it or supervised it.' },
			{
				id: 'conflict',
				text: 'I have disclosed in writing to my client any interest that could conflict with this work, and I have none that prevents me from doing it.'
			},
			{
				id: 'inputs',
				text: 'I have checked the input data (rainfall, evaporation and the observed record) against their sources, and they are adequate in quality and length for this assessment.'
			},
			{ id: 'calibration', text: 'The calibration and the observed record chosen for it are appropriate for this catchment.' },
			{
				id: 'ewr',
				text: 'The EWR tables are the applicable ones for the EWR sites in this run, from the source cited, and are entered as published.'
			},
			{
				id: 'works',
				text: run.scenario
					? 'The scenario represents the proposed works and water use, as described to me by the applicant and checked against the sources I cite.'
					: 'Checked against the sources I cite, the modelled network represents the existing works and water use of the catchment.'
			},
			{ id: 'assurance', text: 'The assurance levels and demand patterns used suit the water use assessed.' },
			{ id: 'plausibility', text: 'I have reviewed the results for plausibility.' },
			{
				id: 'limitations',
				text: 'I have read the methodology statement cited below, and the known limitations and the errata of this engine version listed below, and considered them for this run.'
			}
		],
		limitations,
		errata: errataFor(run.engineVersion, errata, run.fitEngineVersion ?? null),
		methodology: { version: METHODOLOGY.version, sha256: METHODOLOGY.sha256 },
		notes: [
			'The registration details are the signer’s own declaration. This app does not check them. You can check them on the public register, whose address the report prints beside each signature: ECSA “Find a Registered Person”, or the SACNASP database of registered scientists.',
			'A dam that can hold more than 50 000 m³ and has a wall more than 5 m high, or one the Minister has declared, is a dam with a safety risk (National Water Act, Chapter 12). The Department of Water and Sanitation must classify it; for a licence application that is form DW793. It also needs its own dam safety approvals. This sign-off does not cover dam safety.',
			'This sign-off makes no finding on whether any water use or works are lawful.',
			'The signature covers professional judgement on this run’s inputs and results. It relies on the app’s calculations and does not verify its software.',
			'The signature covers this run only, as it was made. A later run, even of the same inputs, is not signed.'
		],
		disclaimerVersion: DISCLAIMER.version
	};
}

/** The text whose SHA-256 a sign-off records (RFC 8785, as a manifest; the caller hashes it). */
export const signoffStatementText = (s: SignoffStatement | PackSignoffStatement): string => canonicalJson(s);

/**
 * The statement version of a sign-off on an evidence pack (WP-3.14), kept
 * apart from the run statement's (SIGNOFF_STATEMENT_VERSION): the database
 * ties a `pack-` version to a pack target and any other to a run (112).
 * pack-signoff-1 (issue #71): the run statement's confirmations, the works
 * one for the pack's application or baseline, plus the pack itself, bound by
 * its manifest hash.
 */
export const PACK_SIGNOFF_STATEMENT_VERSION = 'pack-signoff-1';

export interface PackSignoffStatement extends Omit<SignoffStatement, 'version' | 'runId' | 'engineVersion'> {
	version: typeof PACK_SIGNOFF_STATEMENT_VERSION;
	/** The pack signed: its id, version and the SHA-256 of its manifest (evidence/pack.ts). */
	packId: string;
	packVersion: number;
	manifestSha256: string;
	/** The runs the pack cites, with the engine that made each. */
	baseline: { runId: string; engineVersion: string };
	application: { runId: string; engineVersion: string } | null;
}

export interface SignoffPack {
	id: string;
	version: number;
	manifestSha256: string;
	baseline: SignoffRun;
	/** The scenario run, for an application pack; null for baseline evidence. */
	application: SignoffRun | null;
}

/**
 * The statement a signer of an evidence pack is shown and confirms. The errata
 * are those of either run's engine (or its fit's), deduplicated, from the
 * current list: a pack is signed against what is known now, whatever its
 * manifest froze.
 */
export function packSignoffStatement(
	pack: SignoffPack,
	limitations: readonly Limitation[] = KNOWN_LIMITATIONS,
	errata: readonly Erratum[] = ENGINE_ERRATA
): PackSignoffStatement {
	const named = pack.application ?? pack.baseline;
	const { version: _v, runId: _r, engineVersion: _e, ...base } = signoffStatement({ ...named, scenario: pack.application !== null }, limitations, errata);
	void _v;
	void _r;
	void _e;
	const seen = new Set<string>();
	const allErrata = [pack.baseline, ...(pack.application ? [pack.application] : [])]
		.flatMap((r) => errataFor(r.engineVersion, errata, r.fitEngineVersion ?? null))
		.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
	return {
		...base,
		version: PACK_SIGNOFF_STATEMENT_VERSION,
		packId: pack.id,
		packVersion: pack.version,
		manifestSha256: pack.manifestSha256,
		baseline: { runId: pack.baseline.id, engineVersion: pack.baseline.engineVersion },
		application: pack.application ? { runId: pack.application.id, engineVersion: pack.application.engineVersion } : null,
		confirmations: [
			...base.confirmations,
			{
				id: 'pack',
				text: `I have read this evidence pack (version ${pack.version}, manifest SHA-256 ${pack.manifestSha256}) as a whole: its flags, its change table and its appendices are those of the runs I judged, and nothing in it misrepresents them.`
			}
		],
		errata: allErrata,
		notes: [
			...base.notes.filter((n) => !n.startsWith('The signature covers this run only')),
			'The signature covers this evidence pack only, identified by the manifest SHA-256 above. Another version of the pack, or a later run of the same inputs, is not signed.'
		]
	};
}
