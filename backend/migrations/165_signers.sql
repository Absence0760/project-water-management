-- 165_signers — who signs an evidence pack, and the registration check
-- (licensing positions, build list items 14 and 16; provisional position,
-- pre-counsel research, 2026-10-01; docs/evidence-pack.md § Signing,
-- docs/security.md § Professional sign-off, docs/data-model.md § Sign-offs).
--
-- Expand-only. app_verify_pack starts from its latest definition
-- (132_verify_pack_run_engines).
--
--  1. The applicant's appointed specialist. The licensing evidence is the
--     applicant's (NWA s41(2)(a)(ii)); until now only the host's editors
--     could sign it, which makes the authority's side its author. The
--     project owner may now mark a member of an applying party
--     (project_member.party, 049) `specialist`: that member, contributor or
--     above, signs the draft packs of the applications whose owner is in the
--     same party (compared ignoring case, as app_share_allowed does). Editors
--     still draft, sign and issue.
--       - project_member.specialist, needing a party (CHECK); a change of
--         party clears it unless the same update sets it
--         (project_member_specialist_party). Set through the owner-only
--         member_update policy (001), so only an owner sets it.
--       - app_pack_specialist(project, pack): the rule, in one place.
--       - app_specialist_pack(project, pack): what the sign-off route needs
--         of a pack the specialist can't read under RLS (they read no pack
--         row, 112): its lifecycle fields and its runs' identity, stamp and
--         digest. Never the manifest.
--       - signoff_insert_specialist / signoff_select_specialist: they insert
--         their own `specialist` sign-off of such a pack, and read that
--         pack's sign-offs (the dialog lists who signed).
--
--  2. signoff.kind: `specialist` (the professional statement of whoever is
--     responsible for the evidence: every sign-off so far) or `review` (an
--     authority-side reviewer's second sign-off of a pack, by an editor).
--     Issue needs a `specialist` sign-off of the current statement; a
--     `review` adds to it, never replaces it (evidence/packs.ts).
--
--  3. The registration check. A signer's registration is typed in; the host
--     checks it against the public SACNASP or ECSA register and the operator
--     records that check with `pnpm import:registration-check`, as the schema
--     owner (registration_check: insert-only, no water_app write grant). At
--     issue, app_pack_bind_registration_checks binds each sign-off of the
--     pack to its signer's current check (signoff_registration_check,
--     written only by that function), and names the specialist signers who
--     have none: with REGISTRATION_CHECK_REQUIRED on (always on Lambda) issue
--     is refused until they do. Verify and the sign-off lists show
--     "checked against the register" only from such a record; anything else
--     reads "self-declared".
--       - A check is current for 365 days, and only while it is the latest
--         check of that registration for that person and says `registered`.
--       - Bound at issue, so verify keeps showing what was checked when the
--         pack was issued, even after the signer's account is deleted
--         (registration_check.user_id SET NULL; a bound check stays, as the
--         sign-off's typed name does; one no pack rests on is removed,
--         registration_check_forget).

-- ---------------------------------------------------------------------------
-- 1. The applicant's specialist
-- ---------------------------------------------------------------------------
ALTER TABLE project_member
	ADD COLUMN specialist boolean NOT NULL DEFAULT false,
	ADD CONSTRAINT project_member_specialist_party CHECK (NOT specialist OR party IS NOT NULL);
COMMENT ON COLUMN project_member.specialist IS
	'The applying party''s appointed specialist (165): signs the draft evidence packs of the applications made in their party. Set by the project owner; needs a party.';

-- A party change ends the appointment, unless the same update makes it again.
CREATE FUNCTION project_member_specialist_party() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF lower(NEW.party) IS DISTINCT FROM lower(OLD.party) AND NEW.specialist = OLD.specialist THEN
			NEW.specialist := false;
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER project_member_specialist_party BEFORE UPDATE OF party ON project_member
	FOR EACH ROW EXECUTE FUNCTION project_member_specialist_party();

-- The current user is the appointed specialist of the party that made the
-- application this pack is evidence for.
CREATE FUNCTION app_pack_specialist(p_project uuid, p_pack uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		me project_member;
		v_owner uuid;
		o project_member;
	BEGIN
		IF uid IS NULL THEN
			RETURN false;
		END IF;
		SELECT * INTO me FROM project_member WHERE project_id = p_project AND user_id = uid;
		IF NOT FOUND OR NOT me.specialist OR me.party IS NULL OR me.role < 'contributor'::project_role THEN
			RETURN false;
		END IF;
		SELECT s.owner_user_id INTO v_owner FROM evidence_pack p JOIN scenario s ON s.id = p.scenario_id
		WHERE p.id = p_pack AND p.project_id = p_project AND s.origin = 'applicant';
		IF v_owner IS NULL THEN
			RETURN false;
		END IF;
		SELECT * INTO o FROM project_member WHERE project_id = p_project AND user_id = v_owner;
		RETURN FOUND AND o.party IS NOT NULL AND lower(o.party) = lower(me.party);
	END
	$$;
COMMENT ON FUNCTION app_pack_specialist(uuid, uuid) IS
	'Whether the signed-in member is the appointed specialist (project_member.specialist) of the applying party whose application this pack is evidence for (165).';
REVOKE ALL ON FUNCTION app_pack_specialist(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_pack_specialist(uuid, uuid) TO water_app;

-- What the specialist's sign-off needs of a pack: never the manifest.
CREATE FUNCTION app_specialist_pack(p_project uuid, p_pack uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		p evidence_pack;
	BEGIN
		IF NOT app_pack_specialist(p_project, p_pack) THEN
			RETURN NULL;
		END IF;
		SELECT * INTO p FROM evidence_pack WHERE id = p_pack AND project_id = p_project;
		RETURN jsonb_build_object(
			'id', p.id,
			'scenarioId', p.scenario_id,
			'title', p.manifest->'report'->'identity'->>'title',
			'version', p.version,
			'status', p.status,
			'manifestSha256', p.manifest_sha256,
			'baselineRunId', p.baseline_run_id,
			'scenarioRunId', p.scenario_run_id,
			'createdAt', p.created_at,
			'runs', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', r.id,
					'engineVersion', r.engine_version,
					'scenario', r.scenario_id IS NOT NULL,
					'fitEngineVersion', r.inputs->'settings'->'fitRecord'->>'engineVersion',
					'legacy', coalesce(r.inputs->'settings'->>'runoffModel', 'legacy') = 'legacy',
					'forecast', r."trigger" = 'forecast',
					'stamp', encode(r.stamp, 'hex'),
					'digest', encode(app_run_digest_body(r.id), 'hex')
				)), '[]'::jsonb)
				FROM model_run r WHERE r.project_id = p_project AND (r.id = p.baseline_run_id OR r.id = p.scenario_run_id)
			)
		);
	END
	$$;
COMMENT ON FUNCTION app_specialist_pack(uuid, uuid) IS
	'A pack the signed-in specialist may sign (app_pack_specialist): lifecycle fields and its runs'' identity, stamp and digest for the sign-off statement and its checks, never the manifest (165). NULL otherwise.';
REVOKE ALL ON FUNCTION app_specialist_pack(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_specialist_pack(uuid, uuid) TO water_app;

-- The draft packs of one application its specialist may sign, newest first.
CREATE FUNCTION app_specialist_packs(p_project uuid, p_scenario uuid) RETURNS SETOF jsonb
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	SELECT jsonb_build_object(
		'id', p.id,
		'title', p.manifest->'report'->'identity'->>'title',
		'version', p.version,
		'status', p.status,
		'manifestSha256', p.manifest_sha256,
		'createdAt', p.created_at,
		'signoffs', (SELECT count(*) FROM signoff s WHERE s.pack_id = p.id)
	)
	FROM evidence_pack p
	WHERE p.project_id = p_project AND p.scenario_id = p_scenario AND p.status = 'draft' AND app_pack_specialist(p_project, p.id)
	ORDER BY p.version DESC, p.created_at DESC
	$$;
COMMENT ON FUNCTION app_specialist_packs(uuid, uuid) IS
	'The draft evidence packs of one application the signed-in specialist may sign (165), newest first: lifecycle fields only.';
REVOKE ALL ON FUNCTION app_specialist_packs(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_specialist_packs(uuid, uuid) TO water_app;

-- ---------------------------------------------------------------------------
-- 2. signoff.kind, and the specialist's policies
-- ---------------------------------------------------------------------------
ALTER TABLE signoff
	ADD COLUMN kind text NOT NULL DEFAULT 'specialist' CHECK (kind IN ('specialist', 'review')),
	-- A review is a second sign-off of a pack, never a run's.
	ADD CONSTRAINT signoff_review_pack CHECK (kind = 'specialist' OR pack_id IS NOT NULL);
COMMENT ON COLUMN signoff.kind IS
	'specialist: the professional statement of whoever is responsible for the evidence (an editor, or the applicant''s appointed specialist). review: an authority-side reviewer''s second sign-off of a pack, by an editor (165). Issue needs a specialist one.';

-- ORed with signoff_insert (036): the appointed specialist signs their party's application's pack, as themselves.
CREATE POLICY signoff_insert_specialist ON signoff FOR INSERT
	WITH CHECK (
		user_id = app_current_user_id() AND kind = 'specialist' AND run_id IS NULL AND pack_id IS NOT NULL
		AND app_pack_specialist(project_id, pack_id)
	);
-- ORed with signoff_select (112): and reads that pack's sign-offs.
CREATE POLICY signoff_select_specialist ON signoff FOR SELECT
	USING (pack_id IS NOT NULL AND app_pack_specialist(project_id, pack_id));

-- ---------------------------------------------------------------------------
-- 3. The registration check
-- ---------------------------------------------------------------------------
CREATE TABLE registration_check (
	id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	-- The account whose registration was checked. SET NULL with the account:
	-- a bound check stays as the record of what verify showed.
	user_id               uuid REFERENCES app_user(id) ON DELETE SET NULL,
	registration_body     text NOT NULL CHECK (registration_body IN ('sacnasp', 'ecsa')),
	registration_category text NOT NULL CHECK (registration_category ~ '^[a-z_]{1,40}$'),
	registration_no       text NOT NULL CHECK (registration_no = btrim(registration_no) AND char_length(registration_no) BETWEEN 1 AND 50),
	-- The name as the register shows it.
	register_name         text NOT NULL CHECK (register_name = btrim(register_name) AND char_length(register_name) BETWEEN 1 AND 200),
	outcome               text NOT NULL CHECK (outcome IN ('registered', 'not_registered')),
	-- Who checked: the host organisation (the responsible party), never the operator's assurance.
	checked_by_org        text NOT NULL CHECK (checked_by_org = btrim(checked_by_org) AND char_length(checked_by_org) BETWEEN 1 AND 200),
	-- When the register was consulted.
	checked_at            timestamptz NOT NULL CHECK (checked_at <= now() + interval '1 minute'),
	note                  text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
	recorded_at           timestamptz NOT NULL DEFAULT now(),
	-- The database role that recorded it (the schema owner, through the operator's script).
	recorded_by           text NOT NULL DEFAULT current_user
);
COMMENT ON TABLE registration_check IS
	'A check of a signer''s registration against the public SACNASP or ECSA register, done by the host and recorded by the operator''s script as the schema owner (165, `pnpm import:registration-check`). Insert-only; a later check of the same registration supersedes it.';
CREATE INDEX registration_check_user_idx ON registration_check (user_id, registration_body, checked_at DESC);

-- Insert-only, even for the schema owner, except what an account deletion does:
-- its SET NULL, then (registration_check_forget) the removal of a check that
-- no issued pack's sign-off rests on.
CREATE FUNCTION registration_check_insert_only() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF TG_OP = 'UPDATE' AND NEW.user_id IS NULL AND OLD.user_id IS NOT NULL
		   AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id')
		   AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.user_id) THEN
			RETURN NEW;
		END IF;
		IF TG_OP = 'DELETE' AND OLD.user_id IS NULL
		   AND NOT EXISTS (SELECT 1 FROM signoff_registration_check b WHERE b.check_id = OLD.id) THEN
			RETURN OLD;
		END IF;
		RAISE EXCEPTION 'a registration check is recorded once and never changed; record a new check instead' USING ERRCODE = 'check_violation';
	END
	$$;
CREATE TRIGGER registration_check_insert_only BEFORE UPDATE OR DELETE ON registration_check
	FOR EACH ROW EXECUTE FUNCTION registration_check_insert_only();

-- An account deleted: a check no issued pack rests on has no purpose left and
-- goes (POPIA s14); a bound one stays, without the account, as the record of
-- what verify showed.
CREATE FUNCTION registration_check_forget() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		DELETE FROM registration_check c
		WHERE c.id = NEW.id AND c.user_id IS NULL
		  AND NOT EXISTS (SELECT 1 FROM signoff_registration_check b WHERE b.check_id = c.id);
		RETURN NULL;
	END
	$$;
REVOKE ALL ON FUNCTION registration_check_forget() FROM PUBLIC, water_app;

ALTER TABLE registration_check ENABLE ROW LEVEL SECURITY;
-- A person reads the checks of their own registration (their data export); everything else goes through the functions below.
CREATE POLICY registration_check_own ON registration_check FOR SELECT USING (user_id = app_current_user_id());
GRANT SELECT ON registration_check TO water_app;

-- Which check backed each sign-off of an issued pack, bound at issue.
CREATE TABLE signoff_registration_check (
	signoff_id uuid PRIMARY KEY REFERENCES signoff(id) ON DELETE CASCADE,
	check_id   bigint NOT NULL REFERENCES registration_check(id),
	bound_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE signoff_registration_check IS
	'The registration check that stood behind a pack sign-off when the pack was issued (165): what verify shows as "checked against the register". Written only by app_pack_bind_registration_checks.';
CREATE INDEX signoff_registration_check_check_idx ON signoff_registration_check (check_id);

CREATE TRIGGER registration_check_forget AFTER UPDATE OF user_id ON registration_check
	FOR EACH ROW WHEN (OLD.user_id IS NOT NULL AND NEW.user_id IS NULL)
	EXECUTE FUNCTION registration_check_forget();

ALTER TABLE signoff_registration_check ENABLE ROW LEVEL SECURITY;
-- Read as its sign-off is (the subquery runs under the caller's signoff policies).
CREATE POLICY signoff_registration_check_select ON signoff_registration_check FOR SELECT
	USING (EXISTS (SELECT 1 FROM signoff s WHERE s.id = signoff_registration_check.signoff_id));
GRANT SELECT ON signoff_registration_check TO water_app;

-- The current check of one person's registration: the latest for that
-- registration, if it says `registered` and is under a year old. Internal.
CREATE FUNCTION app_registration_check_current(p_user uuid, p_body text, p_category text, p_no text) RETURNS bigint
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	SELECT x.id FROM (
		SELECT c.id, c.outcome, c.checked_at FROM registration_check c
		WHERE c.user_id = p_user AND c.registration_body = lower(p_body) AND c.registration_category = p_category
		  AND lower(regexp_replace(c.registration_no, '\s', '', 'g')) = lower(regexp_replace(p_no, '\s', '', 'g'))
		ORDER BY c.checked_at DESC, c.id DESC LIMIT 1
	) x
	WHERE x.outcome = 'registered' AND x.checked_at > now() - interval '365 days'
	$$;
REVOKE ALL ON FUNCTION app_registration_check_current(uuid, text, text, text) FROM PUBLIC, water_app;

-- A sign-off's check as the app shows it: the one bound at issue, else
-- (a draft) the signer's current one, not yet bound. For whoever reads the
-- sign-off (the caller's signoff policies decide, inside the subquery).
CREATE FUNCTION app_signoff_registration_check(p_signoff uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		s signoff;
		v_check bigint;
		v_bound boolean := true;
	BEGIN
		-- Only for a sign-off the caller reads: signoff_select's rule (a viewer, and the pack's reader:
		-- evidence_pack_select, 112) or signoff_select_specialist's.
		SELECT * INTO s FROM signoff WHERE id = p_signoff;
		IF NOT FOUND THEN
			RETURN NULL;
		END IF;
		IF NOT (
			(app_has_role(s.project_id, 'viewer') AND (s.pack_id IS NULL OR app_has_role(s.project_id, 'editor')
				OR EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = s.pack_id AND (p.scenario_id IS NULL OR app_scenario_readable(p.scenario_id)))))
			OR (s.pack_id IS NOT NULL AND app_pack_specialist(s.project_id, s.pack_id))
		) THEN
			RETURN NULL;
		END IF;
		SELECT b.check_id INTO v_check FROM signoff_registration_check b WHERE b.signoff_id = p_signoff;
		IF v_check IS NULL AND s.user_id IS NOT NULL AND s.registration_category IS NOT NULL THEN
			v_check := app_registration_check_current(s.user_id, s.registration_body, s.registration_category, s.registration_no);
			v_bound := false;
		END IF;
		IF v_check IS NULL THEN
			RETURN NULL;
		END IF;
		RETURN (SELECT jsonb_build_object('checkedAt', c.checked_at, 'checkedByOrg', c.checked_by_org, 'bound', v_bound)
			FROM registration_check c WHERE c.id = v_check);
	END
	$$;
COMMENT ON FUNCTION app_signoff_registration_check(uuid) IS
	'A sign-off''s registration check (165): the one bound when its pack was issued, else the signer''s current check; NULL when there is none or the caller can''t read the sign-off.';
REVOKE ALL ON FUNCTION app_signoff_registration_check(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_signoff_registration_check(uuid) TO water_app;

-- At issue (evidence/packs.ts): bind each sign-off of the pack to its signer's
-- current check (p_bind; false only reports, for the pack's issue checks),
-- and return the names of the `specialist` signers of the current statement
-- who have none. An editor's call, on a draft of their project; the issue
-- route's transaction rolls the binding back on a refusal.
CREATE FUNCTION app_pack_bind_registration_checks(p_project uuid, p_pack uuid, p_statement text, p_bind boolean) RETURNS text[]
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		missing text[] := '{}';
		s record;
		v_check bigint;
	BEGIN
		IF NOT app_has_role(p_project, 'editor')
		   OR NOT EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = p_pack AND p.project_id = p_project AND p.status = 'draft') THEN
			RAISE EXCEPTION 'app_pack_bind_registration_checks: not allowed' USING ERRCODE = '42501';
		END IF;
		FOR s IN SELECT * FROM signoff WHERE pack_id = p_pack AND project_id = p_project ORDER BY signed_at, id LOOP
			v_check := CASE WHEN s.user_id IS NOT NULL AND s.registration_category IS NOT NULL
				THEN app_registration_check_current(s.user_id, s.registration_body, s.registration_category, s.registration_no) END;
			IF v_check IS NOT NULL THEN
				CONTINUE WHEN NOT p_bind;
				INSERT INTO signoff_registration_check (signoff_id, check_id) VALUES (s.id, v_check)
				ON CONFLICT (signoff_id) DO NOTHING;
			ELSIF s.kind = 'specialist' AND s.statement_sha256 = p_statement THEN
				missing := missing || s.full_name;
			END IF;
		END LOOP;
		RETURN missing;
	END
	$$;
COMMENT ON FUNCTION app_pack_bind_registration_checks(uuid, uuid, text, boolean) IS
	'Binds each sign-off of a draft pack to its signer''s current registration check at issue, and names the specialist signers of the current statement with none (165). Editors only.';
REVOKE ALL ON FUNCTION app_pack_bind_registration_checks(uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_pack_bind_registration_checks(uuid, uuid, text, boolean) TO water_app;

-- ---------------------------------------------------------------------------
-- app_verify_pack, from 132_verify_pack_run_engines.sql: each signer's kind
-- and the check bound at issue (same signature, SECURITY DEFINER and
-- search_path; CREATE OR REPLACE keeps 112's grants).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_verify_pack(p_code text) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		c text := lower(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'));
		p evidence_pack;
	BEGIN
		IF c ~ '^[0-9a-f]{64}$' THEN
			SELECT * INTO p FROM evidence_pack WHERE manifest_sha256 = c;
		ELSIF c ~ '^[0-9a-f]{12}$' THEN
			SELECT * INTO p FROM evidence_pack WHERE left(manifest_sha256, 12) = c;
		ELSE
			RETURN NULL;
		END IF;
		IF NOT FOUND OR p.status = 'draft' OR p.issued_at IS NULL THEN
			RETURN NULL;
		END IF;
		RETURN jsonb_build_object(
			'status', p.status,
			'version', p.version,
			'issuedAt', p.issued_at,
			'catchment', p.manifest->'project'->>'name',
			'engineVersion', p.engine_version,
			'reportVersion', p.report_version,
			'manifestSha256', p.manifest_sha256,
			'pdfSha256', p.pdf_sha256,
			'bundleSha256', p.bundle_sha256,
			'successorSha256', (SELECT s.manifest_sha256 FROM evidence_pack s WHERE s.id = p.superseded_by_pack_id),
			'withdrawnReason', CASE WHEN p.status = 'withdrawn' THEN p.status_reason END,
			'methodology', jsonb_build_object(
				'version', p.manifest->'report'->'verification'->'methodology'->>'version',
				'sha256', p.manifest->'report'->'verification'->'methodology'->>'sha256'
			),
			'errata', (
				SELECT coalesce(jsonb_agg(jsonb_build_object('id', e->>'id', 'summary', e->>'summary') ORDER BY ord), '[]'::jsonb)
				FROM jsonb_array_elements(coalesce(p.manifest->'report'->'verification'->'errata', '[]'::jsonb)) WITH ORDINALITY AS x(e, ord)
			),
			-- For the API's errata found since issue only; never returned as is (132).
			'runs', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'engineVersion', r.engine_version,
					'fitEngineVersion', r.inputs->'settings'->'fitRecord'->>'engineVersion'
				) ORDER BY r.id IS DISTINCT FROM p.baseline_run_id), '[]'::jsonb)
				FROM model_run r WHERE r.id = p.baseline_run_id OR r.id = p.scenario_run_id
			),
			'signers', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'fullName', s.full_name,
					'registrationBody', s.registration_body,
					'registrationCategory', s.registration_category,
					'registrationField', s.registration_field,
					'registrationNo', s.registration_no,
					'signedAt', s.signed_at,
					-- 165: who signed as what, and the check bound at issue (none: self-declared).
					'kind', s.kind,
					'registrationCheck', (
						SELECT jsonb_build_object('checkedAt', rc.checked_at, 'checkedByOrg', rc.checked_by_org)
						FROM signoff_registration_check b JOIN registration_check rc ON rc.id = b.check_id
						WHERE b.signoff_id = s.id
					)
				) ORDER BY s.signed_at, s.id), '[]'::jsonb)
				FROM signoff s WHERE s.pack_id = p.id
			)
		);
	END
	$$;
COMMENT ON FUNCTION app_verify_pack(text) IS
	'The public verify lookup (112_evidence_pack, 122_pack_bundle, 132_verify_pack_run_engines, 165_signers; GET /verify/:code): only the printed fields of a pack that was issued, by short code or manifest hash, with its PDF and bundle hashes, its signers'' kinds and registration checks, and its runs'' engines and fits'' engines for the errata found since issue (the API maps them to errata, never returns them); NULL otherwise.';
