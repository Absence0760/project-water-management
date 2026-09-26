// What a professional sign-off on a run confirms (roadmap WP-3.13). The
// statement is built here, purely, from the run's identity and the committed
// limitations list; the backend hashes its canonical text (SHA-256) and a
// sign-off records that hash, so a signature is bound to the exact words it
// was shown. If the statements, the limitations or the disclaimer change
// between showing the dialog and submitting it, the hash no longer matches
// and the sign-off is refused.
import { canonicalJson } from '../manifest';
import { DISCLAIMER } from './disclaimer';
import type { Limitation } from './limitations';
import { KNOWN_LIMITATIONS } from './limitations.generated';

/** Bumped whenever a statement's wording or the statement's shape changes. */
export const SIGNOFF_STATEMENT_VERSION = 'signoff-1';

export interface SignoffConfirmation {
	id: 'calibration' | 'ewr' | 'works' | 'assurance' | 'limitations';
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
	/** Printed with the statement, not confirmed: what the signature does not cover. */
	notes: string[];
	disclaimerVersion: string;
}

export interface SignoffRun {
	id: string;
	engineVersion: string;
	/** The run was made by a scenario (model_run.scenario_id). */
	scenario: boolean;
}

/** The statement a signer of this run is shown and confirms. */
export function signoffStatement(run: SignoffRun, limitations: readonly Limitation[] = KNOWN_LIMITATIONS): SignoffStatement {
	return {
		version: SIGNOFF_STATEMENT_VERSION,
		runId: run.id,
		engineVersion: run.engineVersion,
		scenario: run.scenario,
		confirmations: [
			{ id: 'calibration', text: 'The calibration and the observed record chosen for it are appropriate for this catchment.' },
			{ id: 'ewr', text: 'The EWR tables and their source are correct for the EWR sites in this run.' },
			{
				id: 'works',
				text: run.scenario
					? 'The scenario represents the proposed works and water use.'
					: 'The modelled network represents the existing works and water use of the catchment.'
			},
			{ id: 'assurance', text: 'The assurance levels and demand patterns used suit the water use assessed.' },
			{ id: 'limitations', text: 'I have read the known limitations listed below and considered them for this run.' }
		],
		limitations,
		notes: [
			'The registration number is self-declared. This app does not check it against the professional body’s register.',
			'Dams higher than 5 m with a capacity above 50 000 m³ also need a dam safety classification (DW793) by others; this sign-off does not cover it.',
			'The signature covers this run only, as it was made. A later run, even of the same inputs, is not signed.'
		],
		disclaimerVersion: DISCLAIMER.version
	};
}

/** The text whose SHA-256 a sign-off records (RFC 8785, as a manifest; the caller hashes it). */
export const signoffStatementText = (s: SignoffStatement): string => canonicalJson(s);
