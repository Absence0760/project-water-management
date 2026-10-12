-- 231_authority_reads_allocations — the members acting for the responsible
-- authority always read each registered volume, how it is held and who holds
-- it, whatever the project's viewer settings (issue #523 G6; the licensing
-- assessor's review, D3: "the flagged authority members must always see
-- per-user registered volume, authorisation kind and name ... as a guarantee
-- that a future visibility tweak can't remove"; docs/allocations.md § Who
-- sees what, docs/security.md § Allocations).
--
-- Cumulative assessment (National Water Act s27(1)(a), s29) can't be done
-- without them. Until now it held only by accident: a confirmed delegate
-- holds editor or above (229), and editors read everything. Who reads what
-- was decided in five places, each with its own copy of the rule
-- (allocation_select 162, allocation_holder_select 038, app_audit_subject
-- 190, report_enqueue 218, and the API's role checks). Now one place decides:
--
--   app_user_reads_allocation_units(project, user)
--       Each allocation row: its volume, storage, dates, registration
--       number, and its authorisation (licence, verified existing lawful
--       use, unverified registration, general authorisation, Schedule 1).
--       True for a member acting for the authority (app_authority_member,
--       229: a confirmed delegate holding editor or above), first and
--       unconditionally; then an editor or owner; then a viewer while an
--       owner lets viewers read each volume (project.allocations_viewer_units,
--       162). Nobody else (a farmer reads their own farms' rows by
--       allocation_select_farmer, 038, which this doesn't touch).
--   app_user_reads_allocation_holders(project, user)
--       The registered user's name (allocation_holder): a member acting for
--       the authority, first and unconditionally; then an editor or owner.
--       Never a viewer, whatever the switch (D3).
--
-- Both are internal (invoker's rights, closed to PUBLIC and water_app, as
-- app_authority_member is, 230): they answer for any user, which the app
-- mustn't ask about someone else. What the app calls:
--
--   app_reads_allocation_units(project), app_reads_allocation_holders(project)
--       The current user. The policies, app_audit_subject, report_enqueue
--       and the API (allocations/viewerUnits.ts allocationUnitsHidden, the
--       allocations route's unitsHidden and canSeeHolders) read these.
--   app_allocation_units_readers(project)
--       The members (directly or through the team) who read each volume, for
--       a viewer or above of the project; nothing for anyone else. Who a
--       report printed with volumes is emailed to (reports/store.ts
--       membersAmong) reads this.
--
-- A future change to who reads what goes in the two internal functions and
-- keeps their first line; db test authority-reads.db.test.ts fails if a
-- policy or function stops calling them, or if a member acting for the
-- authority stops reading.
--
-- Changes (each from its latest definition):
--   allocation_select         from 162: app_reads_allocation_units.
--   allocation_holder_select  from 038: app_reads_allocation_holders, or a
--                             farmer's own farm (unchanged).
--   app_audit_subject         from 190: app_reads_allocation_units.
--   report_enqueue            from 218: with_volumes by
--                             app_reads_allocation_units.
-- Behaviour today is unchanged for every reader (a delegate is an editor);
-- what changes is that the authority's clause no longer rests on that.

-- ---------------------------------------------------------------------------
-- 1. The one place
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_user_reads_allocation_units(p_project uuid, p_user uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SET search_path = public
	AS $$
	DECLARE
		v_role project_role;
	BEGIN
		IF p_user IS NULL THEN
			RETURN false;
		END IF;
		-- G6: the responsible authority's members, whatever follows. Keep this first.
		IF app_authority_member(p_project, p_user) THEN
			RETURN true;
		END IF;
		v_role := app_member_role(p_project, p_user);
		IF v_role IS NULL OR v_role < 'viewer'::project_role THEN
			RETURN false;
		END IF;
		RETURN v_role >= 'editor'::project_role OR app_allocations_viewer_units(p_project);
	END
	$$;
COMMENT ON FUNCTION app_user_reads_allocation_units(uuid, uuid) IS
	'Whether p_user reads each of p_project''s allocation rows (volume, dates, registration number, authorisation): a member acting for the responsible authority always (231, #523 G6), an editor or owner, a viewer while allocations_viewer_units is on (162). The one place that decides; internal (invoker''s rights, closed to water_app), called from the SECURITY DEFINER functions below.';
REVOKE ALL ON FUNCTION app_user_reads_allocation_units(uuid, uuid) FROM PUBLIC, water_app;

CREATE FUNCTION app_user_reads_allocation_holders(p_project uuid, p_user uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SET search_path = public
	AS $$
	BEGIN
		IF p_user IS NULL THEN
			RETURN false;
		END IF;
		-- G6: the responsible authority's members, whatever follows. Keep this first.
		IF app_authority_member(p_project, p_user) THEN
			RETURN true;
		END IF;
		RETURN coalesce(app_member_role(p_project, p_user) >= 'editor'::project_role, false);
	END
	$$;
COMMENT ON FUNCTION app_user_reads_allocation_holders(uuid, uuid) IS
	'Whether p_user reads the names of p_project''s registered users (allocation_holder): a member acting for the responsible authority always (231, #523 G6), an editor or owner; never a viewer (D3). The one place that decides; internal, as app_user_reads_allocation_units.';
REVOKE ALL ON FUNCTION app_user_reads_allocation_holders(uuid, uuid) FROM PUBLIC, water_app;

-- What the app asks: the current user.
CREATE FUNCTION app_reads_allocation_units(p_project uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT app_user_reads_allocation_units(p_project, app_current_user_id())
	$$;
COMMENT ON FUNCTION app_reads_allocation_units(uuid) IS
	'Whether the current user reads each of the project''s allocation rows (app_user_reads_allocation_units, 231). allocation_select, app_audit_subject, report_enqueue and the API read it.';

CREATE FUNCTION app_reads_allocation_holders(p_project uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT app_user_reads_allocation_holders(p_project, app_current_user_id())
	$$;
COMMENT ON FUNCTION app_reads_allocation_holders(uuid) IS
	'Whether the current user reads the names of the project''s registered users (app_user_reads_allocation_holders, 231). allocation_holder_select and the API read it.';

-- The members who read each volume, for a viewer or above; nothing for anyone else.
CREATE FUNCTION app_allocation_units_readers(p_project uuid) RETURNS TABLE (user_id uuid)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT app_has_role(p_project, 'viewer') THEN
			RETURN;
		END IF;
		RETURN QUERY SELECT u.uid FROM (
			SELECT m.user_id AS uid FROM project_member m WHERE m.project_id = p_project
			UNION SELECT tm.user_id FROM project p JOIN team_member tm ON tm.team_id = p.team_id WHERE p.id = p_project
		) u
		WHERE app_user_reads_allocation_units(p_project, u.uid);
	END
	$$;
COMMENT ON FUNCTION app_allocation_units_readers(uuid) IS
	'The project''s members (directly or through its team) who read each allocation row (app_user_reads_allocation_units, 231), for a viewer or above of the project; nothing for anyone else. Who a report printed with volumes is emailed to.';

REVOKE ALL ON FUNCTION app_reads_allocation_units(uuid), app_reads_allocation_holders(uuid), app_allocation_units_readers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_reads_allocation_units(uuid), app_reads_allocation_holders(uuid), app_allocation_units_readers(uuid) TO water_app;

-- ---------------------------------------------------------------------------
-- 2. The policies, from 162 and 038
-- ---------------------------------------------------------------------------
DROP POLICY allocation_select ON allocation;
CREATE POLICY allocation_select ON allocation FOR SELECT USING (app_reads_allocation_units(project_id));

-- A farmer: an allocation on their own farm (allocation's own policies apply inside the subquery), as in 038.
DROP POLICY allocation_holder_select ON allocation_holder;
CREATE POLICY allocation_holder_select ON allocation_holder FOR SELECT
	USING (
		app_reads_allocation_holders(project_id)
		OR EXISTS (
			SELECT 1 FROM allocation a
			WHERE a.id = allocation_holder.allocation_id AND a.node_id IN (SELECT app_farm_nodes(a.project_id))
		)
	);

-- ---------------------------------------------------------------------------
-- 3. An audit event's subject, from 190
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_audit_subject(p_project uuid, p_kind text, p_subject jsonb) RETURNS jsonb
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT CASE
			WHEN p_kind LIKE 'allocation.%' AND NOT app_reads_allocation_units(p_project)
			THEN p_subject - 'registrationNo' - 'volumeM3PerYear'
			ELSE p_subject
		END
	$$;
COMMENT ON FUNCTION app_audit_subject(uuid, text, jsonb) IS
	'An audit event''s subject as the current user may read it (190, 231): an allocation event without its registration number or volume for a reader who can''t read the allocation rows themselves (app_reads_allocation_units). The History reads every subject through it.';

-- ---------------------------------------------------------------------------
-- 4. report_enqueue, from 218: with_volumes by the one rule
-- ---------------------------------------------------------------------------
-- Latest definition: 218_report_volumes.sql.
CREATE OR REPLACE FUNCTION report_enqueue() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a report needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.requested_by := uid;
		NEW.status := 'queued';
		NEW.pages := NULL;
		NEW.bytes := NULL;
		NEW.error := NULL;
		NEW.created_at := now();
		NEW.finished_at := NULL;
		IF NEW.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM model_run r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id) THEN
			RAISE EXCEPTION 'the run is not one of the project''s' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.job_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'report_render' AND j.acting_user_id = uid
		) THEN
			RAISE EXCEPTION 'the job is not this report''s render' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.schedule_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM report_schedule s WHERE s.id = NEW.schedule_id AND s.project_id = NEW.project_id) THEN
			RAISE EXCEPTION 'the schedule is not one of the project''s' USING ERRCODE = 'check_violation';
		END IF;
		-- An impact report names its baseline, one the requester can read
		-- (this function is SECURITY INVOKER: model_run's RLS is theirs), and
		-- not the run itself.
		IF NEW.impact AND NEW.against_run_id IS NULL THEN
			RAISE EXCEPTION 'an impact report needs a baseline run' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.against_run_id IS NOT NULL THEN
			IF NOT EXISTS (SELECT 1 FROM model_run r WHERE r.id = NEW.against_run_id AND app_has_role(r.project_id, 'viewer')) THEN
				RAISE EXCEPTION 'the baseline run is not one the requester can read' USING ERRCODE = 'insufficient_privilege';
			END IF;
			IF NEW.against_run_id = NEW.run_id THEN
				RAISE EXCEPTION 'the baseline is the run itself' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		-- 218: printed with each farm's registered volume? The requester reads each one (app_reads_allocation_units, 231), the report isn't
		-- against another project's baseline (printed without any volumes), and a run they can read of this project,
		-- or the baseline, carries one. Under their RLS, as the render will read.
		NEW.with_volumes := app_reads_allocation_units(NEW.project_id)
			AND (NEW.against_run_id IS NULL OR EXISTS (SELECT 1 FROM model_run b WHERE b.id = NEW.against_run_id AND b.project_id = NEW.project_id))
			AND EXISTS (
				SELECT 1 FROM model_run r
				WHERE (r.project_id = NEW.project_id OR r.id = NEW.against_run_id)
				  AND CASE WHEN jsonb_typeof(r.inputs -> 'model' -> 'allocations') = 'array'
				           THEN jsonb_array_length(r.inputs -> 'model' -> 'allocations') > 0 ELSE false END
			);
		RETURN NEW;
	END
	$$;
