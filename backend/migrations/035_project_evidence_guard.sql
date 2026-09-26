-- 035_project_evidence_guard — a project that has nominated an evidence run
-- can't be deleted (issue #43; docs/data-model.md § Evidence nomination,
-- docs/security.md § Tamper evidence).
--
-- 010_run_nomination made the nomination history append-only and kept every
-- nominated run, but deleting the whole project still cascaded to both, so
-- the evidence and its history went with the project. This trigger closes
-- that: a DELETE of a project with any run_nomination row fails, for every
-- role and on every path (the route, a direct DELETE as water_app, and any
-- future cascade into project; today none exists: project.team_id is ON
-- DELETE SET NULL and project.created_by is NO ACTION).
--
-- Any row, not only the current one. The history can't be withdrawn (no
-- UPDATE or DELETE for water_app), so once a project has nominated it always
-- has a current nomination (the newest row); "current" and "any" pick out the
-- same projects. Checking for any row says the rule plainly and stays right if
-- a withdrawal is ever added: a withdrawn nomination is still history.
--
-- SECURITY DEFINER so the check sees the history past RLS whoever deletes;
-- search_path pinned. restrict_violation (23001): the route answers 409 with
-- the run's name before it gets here, and maps this code to the same 409 if a
-- nomination lands between its check and the DELETE (the nomination's foreign
-- key check and the DELETE lock the same project row, so one waits for the
-- other and this trigger sees the committed row).
--
-- The operator can still remove such a project out of band, as the schema
-- owner, by disabling this trigger for one transaction
-- (docs/security.md § Tamper evidence). The app can't.

CREATE FUNCTION project_evidence_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		latest uuid;
	BEGIN
		SELECT n.run_id INTO latest
			FROM run_nomination n
			WHERE n.project_id = OLD.id
			ORDER BY n.nominated_at DESC LIMIT 1;
		IF FOUND THEN
			RAISE EXCEPTION 'project % has a nominated evidence run (%), so it is kept with its nomination history', OLD.id, latest
				USING ERRCODE = 'restrict_violation';
		END IF;
		RETURN OLD;
	END
	$$;
CREATE TRIGGER project_evidence_guard BEFORE DELETE ON project
	FOR EACH ROW EXECUTE FUNCTION project_evidence_guard();

-- A trigger function needs no EXECUTE grant (Postgres checks it only at
-- CREATE TRIGGER); 028's default privileges gave water_app one, so take it back.
REVOKE ALL ON FUNCTION project_evidence_guard() FROM PUBLIC, water_app;

COMMENT ON FUNCTION project_evidence_guard() IS
	'Refuses to delete a project with any run_nomination row, so its evidence run and nomination history are kept (035_project_evidence_guard, issue #43).';
