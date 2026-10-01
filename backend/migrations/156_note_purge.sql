-- 156_note_purge — a deleted note's text is erased 90 days after it was
-- deleted (POPIA s14(1), s14(4)-(5); provisional position, pre-counsel
-- research, 2026-10-01: docs/security.md § Personal information,
-- docs/data-model.md § Notes, docs/followups.md "Retention of deleted notes'
-- bodies").
--
-- A note is soft-deleted (037): deleted_at and deleted_by are set, and RLS
-- and the API hide it from everyone. Until now the row, its body and its
-- earlier texts (note_revision, 115 and 128) stayed for the life of the
-- project with no reader. The fact of the deletion (which note, whose, by
-- whom, when) is in the note.deleted audit event, which never held the body,
-- so after a period long enough for a complaint or a moderation dispute to
-- surface the row holds nothing the event lacks.
--
--  1. app_purge_deleted_notes(p_age): deletes every note deleted more than
--     p_age ago, and its note_revision rows by their cascade (s14(5): nothing
--     left to reconstruct). The job tick calls it with 90 days
--     (jobs/runner.ts DELETED_NOTE_RETENTION_DAYS). The audit event stays.
--
--     Except a licence record: a note on a scenario past draft (submitted,
--     withdrawn or decided) or on an evidence pack past draft (issued,
--     superseded or withdrawn) is part of that application's record (the
--     comments, parties' exchanges and representations of NWA s41(2)(c)-(d)
--     and s41(4)). It stays, hidden as it already is (restricted, s14(6)(b)),
--     and goes with the record when the project is deleted.
--
--     scenario_comments_kept (115) counts every public_participation note,
--     deleted or not, and only for a draft scenario can that ever matter
--     (only a draft or withdrawn application can be deleted, and the purge
--     keeps every note of a withdrawn one). A draft's deleted comment purged
--     after 90 days no longer holds the draft: the comment is gone, so
--     nothing is lost by letting the draft go. app_scenario_has_public_comments
--     (115) reads the same set, so the route's 409 agrees with the trigger.
--
--     Worker context only (no user, no API key; 051's alert_worker_context),
--     and never with an age under 30 days, so no caller can erase a note
--     that was deleted this morning. SECURITY DEFINER: water_app still has
--     no DELETE on note (catalogue.db.test.ts NO_DELETE), so this function
--     is the only path by which a note row is removed, bar its project,
--     node, run, scenario or pack going.
--  2. note_deleted_idx: the purge's scan, partial on deleted rows.

CREATE FUNCTION app_purge_deleted_notes(p_age interval) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_count integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker purges deleted notes' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_age IS NULL OR p_age < interval '30 days' THEN
			RAISE EXCEPTION 'purge only notes deleted at least 30 days ago' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		DELETE FROM note n
		WHERE n.deleted_at < now() - p_age
		  AND NOT (
			(n.scenario_id IS NOT NULL AND EXISTS (SELECT 1 FROM scenario s WHERE s.id = n.scenario_id AND s.status <> 'draft'))
			OR (n.pack_id IS NOT NULL AND EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = n.pack_id AND p.status <> 'draft'))
		  );
		GET DIAGNOSTICS v_count = ROW_COUNT;
		RETURN v_count;
	END
	$$;

REVOKE ALL ON FUNCTION app_purge_deleted_notes(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_deleted_notes(interval) TO water_app;

CREATE INDEX note_deleted_idx ON note (deleted_at) WHERE deleted_at IS NOT NULL;

COMMENT ON TABLE note IS
	'Plain-text notes on a node, run, setting, scenario, pack or the project, visible to the team or also to the linked farmers (037, WP-2.7). Soft-deleted by the app; a deleted note is erased 90 days later by app_purge_deleted_notes (156), unless it belongs to a licence record (a scenario or pack past draft).';
