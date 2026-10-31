-- 294_wula_reference — the water-use licence application (WULA) a scenario
-- models: its application number and the works as applied for (docs/followups.md
-- "Applied-for works against the modelled ones", the licensing authority;
-- docs/scenarios.md § Applications, docs/data-model.md § Scenarios,
-- docs/evidence-pack.md § The WULA reference).
--
-- Nothing tied a scenario's ops to what the WULA applies for, so an assessor
-- couldn't tell whether the modelled change is the applied-for one. The
-- scenario now records the WULA's number and its works as a list ({ ref, text }:
-- the applicant's short label, "W1" or the WULA's own item number, and the
-- works in words, as applied for). Each op may name the works it models by
-- that ref (the engine's op `works` tag, inside `ops`, so it is hashed into
-- ops_sha256 and recorded with every run); the check warns, never refuses,
-- when a proposal names no listed works (engine scenario/wula.ts). The
-- evidence report prints the reference on page 1 and beside the changes in
-- Appendix A.2 (report format evidence-25).
--
-- Expand-only.
--
--  1. Two columns on scenario. `wula_number`: NULL until given, else trimmed,
--     1–100 characters. `wula_works`: a JSON array of at most 50 { ref, text },
--     ref trimmed 1–20 characters and unique in the list, text trimmed 1–1 000
--     characters, nothing else (app_wula_works_ok). Any scenario may carry one
--     (a team scenario an editor models for an applicant too); who writes it is
--     whoever may change the scenario (an editor on a team scenario, only the
--     applicant on an application: the route's assertCanChange and
--     scenario_guard, unchanged), and who reads it is whoever reads the
--     scenario: 045's origin-aware scenario policies decide, and 024's
--     table-level `GRANT SELECT, INSERT, UPDATE, DELETE ON scenario TO
--     water_app` covers the new columns (a table-level grant extends to columns
--     added later; the catalogue test checks the grant). No foreign key, so no
--     index.
--
--  2. scenario_wula_frozen: part of what was submitted, like the ops and the
--     notice's objection details (166, scenario_objection_frozen, the pattern
--     followed): fixed until the scenario is a draft again (withdraw, reopen).
--     A new trigger rather than another branch in scenario_guard (227), which
--     stays as it is. A decision can't change them either, since only a
--     submitted scenario is decided.
--
-- The share link's projection (app_share_scenario, 115/291) is not changed:
-- it doesn't show the reference (docs/followups.md lists it as open).

-- ---------------------------------------------------------------------------
-- 1. The reference
-- ---------------------------------------------------------------------------

-- Whether a value is a WULA works list as wula_works holds it (module comment).
CREATE FUNCTION app_wula_works_ok(p jsonb) RETURNS boolean
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
		SELECT jsonb_typeof(p) = 'array'
			AND jsonb_array_length(p) <= 50
			AND NOT EXISTS (
				SELECT 1 FROM jsonb_array_elements(p) e(w)
				-- CASE, not OR: jsonb_object_keys raises on a non-object, and SQL doesn't promise to short-circuit.
				WHERE CASE WHEN jsonb_typeof(w) <> 'object' THEN true ELSE
					(SELECT count(*) FROM jsonb_object_keys(w)) <> 2
					OR jsonb_typeof(w->'ref') IS DISTINCT FROM 'string'
					OR jsonb_typeof(w->'text') IS DISTINCT FROM 'string'
					OR CASE WHEN jsonb_typeof(w->'ref') = 'string' AND jsonb_typeof(w->'text') = 'string' THEN
						w->>'ref' <> btrim(w->>'ref') OR char_length(w->>'ref') NOT BETWEEN 1 AND 20
						OR w->>'text' <> btrim(w->>'text') OR char_length(w->>'text') NOT BETWEEN 1 AND 1000
					ELSE true END
				END
			)
			AND (SELECT count(DISTINCT e->>'ref') FROM jsonb_array_elements(p) e) = jsonb_array_length(p)
	$$;
COMMENT ON FUNCTION app_wula_works_ok(jsonb) IS
	'Whether a value is a WULA works list (294): an array of at most 50 { ref, text }, ref trimmed 1–20 characters and unique, text trimmed 1–1 000.';

ALTER TABLE scenario
	ADD COLUMN wula_number text CHECK (wula_number IS NULL OR (wula_number = btrim(wula_number) AND char_length(wula_number) BETWEEN 1 AND 100)),
	ADD COLUMN wula_works jsonb NOT NULL DEFAULT '[]' CONSTRAINT scenario_wula_works_ok CHECK (app_wula_works_ok(wula_works));

COMMENT ON COLUMN scenario.wula_number IS
	'The water-use licence application''s number, as the authority gave it (294); NULL = not given. Frozen once submitted. Printed on the evidence report''s page 1 and Appendix A.2.';
COMMENT ON COLUMN scenario.wula_works IS
	'The works as the WULA applies for them (294): [{ ref, text }], ref the label an op''s `works` tag names. Frozen once submitted. The check warns of a proposal that names none.';

-- ---------------------------------------------------------------------------
-- 2. Frozen with what was submitted
-- ---------------------------------------------------------------------------
CREATE FUNCTION scenario_wula_frozen() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.status <> 'draft'
		   AND (NEW.wula_number IS DISTINCT FROM OLD.wula_number OR NEW.wula_works IS DISTINCT FROM OLD.wula_works) THEN
			RAISE EXCEPTION 'a % scenario''s WULA reference is frozen', OLD.status USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER scenario_wula_frozen BEFORE UPDATE OF wula_number, wula_works ON scenario
	FOR EACH ROW EXECUTE FUNCTION scenario_wula_frozen();
