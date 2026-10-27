-- 254_feed_gap_fill_outcome — what a CHIRPS feed's fetch made of the
-- gap-filling products it fills (issue #604 R4-B, review of round 4;
-- backend feeds/gapRainFill.ts, docs/data-model.md § Data feeds).
--
-- A CHIRPS feed's fetch from our copy then fills ERA5-Land and IMERG Late
-- over its cells, each in its own savepoint, so a failed fill never takes
-- the feed's CHIRPS days with it. Until now that failure was only logged:
-- the Data tab said "nothing held yet" for ever. This records each
-- product's outcome on the feed, in data_feed.last_meta, where the feed's
-- other per-fetch facts live (GET …/feeds carries it as lastMeta, and GET
-- …/feeds/gap-rain as `fill`):
--
--   last_meta.gapEra5l / last_meta.gapImergLate: 'ok', 'not_ready' (the
--   copy holds no such product yet) or 'failed:<code>', the code one of
--   'format' (the copy's files aren't what we read), 'unavailable' (the
--   copy didn't answer usefully) or 'refused' (the cell cache refused the
--   values). Never an error's text: the code is ours.
--
-- The ingest rebuilds last_meta from each fetch's answer, so the keys always
-- describe the latest fill; a fetch that doesn't fill (the setting is off)
-- leaves none once its CHIRPS answer lands.
--
-- app_record_gap_fill(feed, job, product, outcome): SECURITY DEFINER, as
-- app_record_feed_result is (water_app can't write the health columns,
-- data_feed_stamp). Only for the running feed_fetch job of that feed queued
-- as the caller (the check 252's chirps_cache_recheck_apply makes), who
-- must still be an editor, and only with the values above: it merges the one
-- key into last_meta and touches nothing else.
--
-- No table, policy, RLS or grant changes besides the function's.

CREATE FUNCTION app_record_gap_fill(p_feed uuid, p_job uuid, p_product text, p_outcome text)
	RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_project uuid;
	BEGIN
		SELECT f.project_id INTO v_project FROM data_feed f WHERE f.id = p_feed;
		IF v_project IS NULL OR NOT app_has_role(v_project, 'editor') THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_job IS NULL OR NOT EXISTS (
			SELECT 1 FROM job j
			WHERE j.id = p_job AND j.project_id = v_project AND j.kind = 'feed_fetch' AND j.status = 'running'
				AND j.payload ->> 'feedId' = p_feed::text AND j.acting_user_id = app_current_user_id()
		) THEN
			RAISE EXCEPTION 'not this feed''s fetch' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_product IS NULL OR p_product NOT IN ('era5l', 'imerg_late')
			OR p_outcome IS NULL OR p_outcome !~ '^(ok|not_ready|failed:(format|unavailable|refused))$' THEN
			RAISE EXCEPTION 'not a gap-filling product and outcome' USING ERRCODE = 'check_violation';
		END IF;
		UPDATE data_feed f
		SET last_meta = COALESCE(f.last_meta, '{}'::jsonb)
			|| jsonb_build_object(CASE p_product WHEN 'era5l' THEN 'gapEra5l' ELSE 'gapImergLate' END, p_outcome)
		WHERE f.id = p_feed;
	END
	$$;

REVOKE ALL ON FUNCTION app_record_gap_fill(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_gap_fill(uuid, uuid, text, text) TO water_app;
