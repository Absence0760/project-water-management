// The season decision log (issue #119): what the `publication.published` and
// `publication.notice_changed` audit events record, so a WUA can show, long
// after the run and the publication row are trimmed (12 publications kept,
// runs by the run cap), what it announced, over which window, and from which
// per-farm figures.
//
// The audit log is the record: append-only for water_app (030_history.sql),
// staff-only (viewers and above; farmers and applicants read none of it),
// kept for the life of the project, and pseudonymised on account deletion
// (048). A farmer reads their own farm's line through GET
// /projects/:id/farm/:nodeId/history, never this. docs/data-model.md
// § Change history lists the fields.
import type { FarmProjection, ModelBand, NoticeText, RestrictionLevel } from '@water-management/engine';
import type { Publication } from './publish.js';

/** One farm's figures in a publication: the farm history's (FarmHistoryEntry) own-farm fields, plus its id and name. Never the even share. */
export interface DecisionFarm {
	nodeId: string;
	name: string;
	dataUntil: string;
	season: { from: string; to: string; demandM3: number; suppliedM3: number; fraction: number | null; shortDays: number };
	/** The dam on dataUntil (0–1); null without a dam. */
	damPct: number | null;
	model: { headline: number | null; band: ModelBand | null };
}

/** The WUA's notice as it stood: level, %, the text in every language it wrote, the next date, and the modeller's note. */
export interface DecisionNotice {
	restriction: { level: RestrictionLevel; pct: number | null; notice: NoticeText };
	nextExpectedOn: string | null;
	note: string;
}

/** The run a publication rested on: the window its figures cover, and what identifies the run after it is trimmed. */
export interface DecisionRun {
	runId: string;
	engineVersion: string;
	runoffModel: string;
	/** SHA-256 (hex) of the run's inputs snapshot (model_run.inputs::text), the same hash app_run_digest folds in (077). */
	inputsSha256: string;
	window: { runStart: string; dataUntil: string; season: { from: string; to: string }; last30: { from: string; to: string } };
}

export const decisionFarm = (v: FarmProjection): DecisionFarm => ({
	nodeId: v.nodeId,
	name: v.name,
	dataUntil: v.dataUntil,
	season: {
		from: v.season.from,
		to: v.season.to,
		demandM3: v.season.demandM3,
		suppliedM3: v.season.suppliedM3,
		fraction: v.season.fraction,
		shortDays: v.season.shortDays
	},
	damPct: v.dam?.pct ?? null,
	model: { headline: v.river.headline, band: v.river.band }
});

export const decisionNotice = (p: Publication): DecisionNotice => ({
	restriction: { level: p.restriction.level, pct: p.restriction.pct, notice: p.restriction.notice },
	nextExpectedOn: p.nextExpectedOn,
	note: p.note ?? ''
});

/** The run part of a publication, from its stored catchment view and the run's inputs hash. */
export const decisionRun = (p: Publication, inputsSha256: string): DecisionRun => {
	const cv = p.catchmentView;
	return {
		runId: p.runId,
		engineVersion: cv.engineVersion,
		runoffModel: cv.runoffModel,
		inputsSha256,
		window: {
			runStart: cv.runStart,
			dataUntil: cv.dataUntil,
			season: { from: cv.season.from, to: cv.season.to },
			last30: { from: cv.last30.from, to: cv.last30.to }
		}
	};
};

/** The `publication.published` subject: who it went to, what it said, what it rested on. */
export function publishedSubject(
	p: Publication,
	o: { inputsSha256: string; views: readonly FarmProjection[]; auto?: boolean }
): Record<string, unknown> {
	return {
		publicationId: p.id,
		...decisionRun(p, o.inputsSha256),
		...decisionNotice(p),
		farms: o.views.length,
		perFarm: o.views.map(decisionFarm),
		...(o.auto ? { auto: true } : {})
	};
}

/** The `publication.notice_changed` subject: which parts were sent, and the whole notice as it stands after the change. */
export function noticeChangedSubject(p: Publication, fields: readonly string[]): Record<string, unknown> {
	return { publicationId: p.id, runId: p.runId, fields: [...fields], ...decisionNotice(p) };
}

/**
 * An audit subject as the data-subject export carries it: without the
 * per-farm figures. They are the project's figures about other people's
 * farms, not the exporting person's data, and every member who may read them
 * reads them in the app's history.
 */
export function withoutFarmFigures<T>(event: T): T {
	if (!event || typeof event !== 'object') return event;
	const e = event as { subject?: unknown };
	if (!e.subject || typeof e.subject !== 'object' || !('perFarm' in e.subject)) return event;
	const { perFarm: _perFarm, ...subject } = e.subject as Record<string, unknown>;
	return { ...event, subject };
}
