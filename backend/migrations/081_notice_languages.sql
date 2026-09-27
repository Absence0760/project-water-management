-- 081_notice_languages — the WUA's restriction notice in any number of
-- languages (issue #58 item 5; docs/data-model.md § Publications, docs/api.md
-- § Publication, docs/ui.md § Language).
--
-- 022 stored the notice as two columns, notice_en and notice_af, so a third
-- language meant a schema change and a change in every reader. It is now one
-- column, `notice`: a jsonb object from a language code to the WUA's words in
-- that language, {"en": "…", "af": "…"}. No notice is the empty object (never
-- NULL). The database checks the shape (app_notice_valid): an object whose
-- keys look like language codes and whose values are strings, non-blank and
-- at most 2000 characters (PUBLICATION_TEXT_MAX, as 022's CHECKs). Which
-- codes are languages the app supports is the API's check, against the one
-- language list (packages/engine/src/languages.ts): a CHECK can't read a
-- table, and a notice written in a language later dropped from the list
-- should stay readable history, not break the row.
--
-- The app isn't deployed yet, so this one migration does the whole
-- expand/contract: add the column, copy the two old ones into it (a blank
-- one is no notice in that language), redefine app_share_view (025, its only
-- definition) to return it, then drop the old columns. The backfill touches
-- superseded publications too, which run_publication_final (067) refuses to
-- let change, so that trigger is off for the copy and back on after it.

-- Whether `n` is a valid notice map. plpgsql so each step is guarded before
-- the next reads it (the 055 pattern).
CREATE FUNCTION app_notice_valid(n jsonb) RETURNS boolean
	LANGUAGE plpgsql IMMUTABLE SET search_path = public
	AS $$
	BEGIN
		IF n IS NULL OR jsonb_typeof(n) <> 'object' THEN
			RETURN false;
		END IF;
		RETURN NOT EXISTS (
			SELECT 1 FROM jsonb_each(n) e
			WHERE e.key !~ '^[a-z]{2,3}$'
			   OR jsonb_typeof(e.value) <> 'string'
			   OR (e.value #>> '{}') ~ '^\s*$'
			   OR length(e.value #>> '{}') > 2000
		);
	END
	$$;

ALTER TABLE run_publication
	ADD COLUMN notice jsonb NOT NULL DEFAULT '{}'::jsonb CONSTRAINT run_publication_notice_valid CHECK (app_notice_valid(notice));

COMMENT ON COLUMN run_publication.notice IS
	'The WUA''s notice by language code, {"en": "…", "af": "…"}; {} = none. Codes are checked against the language list by the API (081, issue #58).';

-- The backfill. Only the notice changes, and a superseded publication's
-- history is otherwise untouched (updated_at / updated_by stay as they were).
ALTER TABLE run_publication DISABLE TRIGGER run_publication_final;
UPDATE run_publication SET notice = jsonb_strip_nulls(jsonb_build_object(
		'en', CASE WHEN notice_en ~ '^\s*$' THEN NULL ELSE notice_en END,
		'af', CASE WHEN notice_af ~ '^\s*$' THEN NULL ELSE notice_af END
	))
WHERE notice_en IS NOT NULL OR notice_af IS NOT NULL;
ALTER TABLE run_publication ENABLE TRIGGER run_publication_final;

-- From its only definition (025), with `notice` in place of the two columns.
-- The return type changes, so it is dropped and created again (and its grants
-- with it: 028's default privileges give a new function to water_app only,
-- and the explicit REVOKE / GRANT below say so here too).
DROP FUNCTION app_share_view(bytea);
CREATE FUNCTION app_share_view(p_hash bytea)
	RETURNS TABLE (
		project_name text,
		published_at timestamptz,
		published_by text,
		catchment_view jsonb,
		restriction_level text,
		restriction_pct numeric,
		notice jsonb,
		next_expected_on date
	)
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		v_link uuid;
		v_project uuid;
	BEGIN
		SELECT s.id, s.project_id INTO v_link, v_project FROM share_link s
		WHERE s.token_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > now();
		IF v_link IS NULL THEN
			RETURN;
		END IF;
		RETURN QUERY
			SELECT pr.name::text, p.published_at, u.display_name::text,
				jsonb_build_object(
					'runStart', p.catchment_view->'runStart',
					'dataUntil', p.catchment_view->'dataUntil',
					'season', p.catchment_view->'season',
					'last30', p.catchment_view->'last30',
					'runDays', p.catchment_view->'runDays',
					'farmCount', p.catchment_view->'farmCount',
					'sites', coalesce((
						SELECT jsonb_agg(jsonb_build_object(
							'name', CASE WHEN (e.s->>'isOutlet')::boolean THEN NULL ELSE e.s->'name' END,
							'isOutlet', coalesce((e.s->>'isOutlet')::boolean, false),
							'daysNotMet', jsonb_build_object(
								'run', e.s->'daysNotMet'->'run',
								'season', e.s->'daysNotMet'->'season',
								'last30', e.s->'daysNotMet'->'last30'
							)
						) ORDER BY e.o)
						FROM jsonb_array_elements(p.catchment_view->'sites') WITH ORDINALITY e(s, o)
					), '[]'::jsonb)
				),
				p.restriction_level, p.restriction_pct, p.notice, p.next_expected_on
			FROM run_publication p
			JOIN project pr ON pr.id = p.project_id
			LEFT JOIN app_user u ON u.id = p.published_by
			WHERE p.project_id = v_project AND p.superseded_at IS NULL;
		IF FOUND THEN
			UPDATE share_link SET last_used_at = now()
			WHERE id = v_link AND (last_used_at IS NULL OR last_used_at <= now() - interval '1 hour');
		END IF;
	END
	$$;
REVOKE ALL ON FUNCTION app_share_view(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_share_view(bytea) TO water_app;

-- The contract. Dropping a column drops its column grant (022's GRANT UPDATE
-- (…, notice_en, notice_af, …)); water_app may update the new one instead.
ALTER TABLE run_publication DROP COLUMN notice_en, DROP COLUMN notice_af;
GRANT UPDATE (notice) ON run_publication TO water_app;
