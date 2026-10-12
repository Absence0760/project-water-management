-- 232_decision_events — what follows a recorded decision: an appeal lodged,
-- then upheld, set aside or varied (issue #523 G4; the licensing assessor's
-- review, § Outcome words (D14); docs/roadmap/step-3-licensing.md § 11 D14;
-- docs/data-model.md § Applications).
--
-- The Water Tribunal (NWA s148, s149) or a court can set an authority's
-- decision aside or vary it. A decision stays immutable (scenario_guard, 163,
-- 231); what happens after it is recorded beside it, one append-only row per
-- event:
--
--  1. decision_event: the scenario, its place in the sequence (position, from
--     1), the kind (lodged, upheld, set_aside, varied), the forum
--     (water_tribunal or court), the date on the lodging or the order, a
--     reference and a note; for `varied`, the new granted terms in 231's shape
--     (ops, ops_sha256, op_names, conditions); who recorded it and when. Never
--     changed or deleted by water_app (no UPDATE or DELETE grant or policy);
--     goes with its scenario (which a decision keeps) or its project.
--  2. The sequence (decision_event_guard): an appeal is lodged after the
--     decision or after an earlier appeal's outcome, never while one is open;
--     upheld, set aside and varied each answer the open appeal, in its forum.
--     Each event's date is on or after the one before (the decision letter's
--     date first) and not in the future. Recorded only by a member acting for
--     the responsible authority (app_acts_for_authority, the helper 163 made
--     and the authority's delegates decide), never by an application's owner,
--     and only on a decided scenario with an outcome.
--  3. What counts (app_scenario_licence, from 231): the newest set aside or
--     varied decides. Varied: the licence is in force on the event's terms
--     (also after a refusal: the forum substituted a licence). Set aside: it
--     isn't in force (a court that reinstates a licence records varied, with
--     its terms). Lodged changes nothing until it is resolved
--     (appealPending: true); upheld keeps what stood.
--  4. Who reads the events: whoever reads the scenario (the policy asks the
--     scenario's own policies): the applicant and the people they shared it
--     with, the editors, and the viewers once it is decided.
--
-- Not built: "lapsed / deemed withdrawn" (GN R267's time limits). That is the
-- end of an application that was never decided, not an event after a
-- decision, so it belongs with the outcome words (a fifth outcome, or a
-- withdrawn status recorded by the authority), not here. Tracked as a
-- follow-up (docs/followups.md, issue #523 G4).

CREATE TABLE decision_event (
	id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	scenario_id  uuid NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
	position     integer NOT NULL CHECK (position >= 1),
	kind         text NOT NULL CHECK (kind IN ('lodged', 'upheld', 'set_aside', 'varied')),
	forum        text NOT NULL CHECK (forum IN ('water_tribunal', 'court')),
	event_date   date NOT NULL,
	reference    text NOT NULL DEFAULT '' CHECK (char_length(reference) <= 200),
	note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 4000),
	-- A variation's granted terms, in 231's shape (scenario.granted_*).
	ops          jsonb CHECK (ops IS NULL OR (jsonb_typeof(ops) = 'array' AND jsonb_array_length(ops) <= 500 AND octet_length(ops::text) <= 1048576)),
	ops_sha256   text CHECK (ops_sha256 IS NULL OR ops_sha256 ~ '^[0-9a-f]{64}$'),
	op_names     jsonb CHECK (op_names IS NULL OR (jsonb_typeof(op_names) = 'array' AND jsonb_array_length(op_names) <= 2000 AND octet_length(op_names::text) <= 1048576)),
	conditions   text NOT NULL DEFAULT '' CHECK (char_length(conditions) <= 4000),
	recorded_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
	recorded_at  timestamptz NOT NULL DEFAULT now(),
	UNIQUE (scenario_id, position),
	CONSTRAINT decision_event_terms CHECK (
		(kind = 'varied') = (ops IS NOT NULL)
		AND (ops IS NULL) = (ops_sha256 IS NULL)
		AND (ops IS NULL) = (op_names IS NULL)
		AND (ops IS NOT NULL OR conditions = '')
	)
);
-- scenario_id is covered by the unique (scenario_id, position).
CREATE INDEX decision_event_project_idx ON decision_event (project_id, recorded_at DESC);
CREATE INDEX decision_event_recorded_by_idx ON decision_event (recorded_by);
CREATE TRIGGER decision_event_same_project BEFORE INSERT OR UPDATE ON decision_event
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('scenario_id');

COMMENT ON TABLE decision_event IS
	'What followed a recorded decision (232, issue #523 G4): an appeal lodged (Water Tribunal, NWA s148, or a court), then upheld, set aside or varied. Append-only, in order (position); the decision itself never changes. app_scenario_licence reads them: the newest set aside or varied decides whether the licence counts in cumulative impact, and on which terms.';
COMMENT ON COLUMN decision_event.ops IS
	'A variation''s granted terms as ops (232), in 231''s shape (scenario.granted_ops): set exactly when kind = varied. They count in cumulative impact from then on, in place of the decision''s.';
COMMENT ON COLUMN decision_event.recorded_by IS 'The member acting for the responsible authority who recorded it (NULL once that account is gone).';

-- The sequence and who records it: stamped here, so no caller chooses its place, author or time.
CREATE FUNCTION decision_event_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		s scenario%ROWTYPE;
		last decision_event%ROWTYPE;
	BEGIN
		IF NOT app_acts_for_authority(NEW.project_id) THEN
			RAISE EXCEPTION 'only a member acting for the responsible authority records what followed its decision' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- One event at a time per scenario, so two can't both answer the same open appeal.
		PERFORM pg_advisory_xact_lock(hashtextextended('decision_event:' || NEW.scenario_id::text, 0));
		SELECT * INTO s FROM scenario WHERE id = NEW.scenario_id AND project_id = NEW.project_id;
		IF s.id IS NULL THEN
			RAISE EXCEPTION 'scenario % not found', NEW.scenario_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF s.status <> 'decided' OR s.outcome IS NULL THEN
			RAISE EXCEPTION 'an appeal follows a recorded decision' USING ERRCODE = 'check_violation';
		END IF;
		IF s.origin = 'applicant' AND uid IS NOT DISTINCT FROM s.owner_user_id THEN
			RAISE EXCEPTION 'an applicant doesn''t record what followed the decision on their own application' USING ERRCODE = 'insufficient_privilege';
		END IF;
		SELECT * INTO last FROM decision_event WHERE scenario_id = NEW.scenario_id ORDER BY position DESC LIMIT 1;
		IF NEW.kind = 'lodged' THEN
			IF last.kind = 'lodged' THEN
				RAISE EXCEPTION 'an appeal is already lodged; record its outcome first' USING ERRCODE = 'check_violation';
			END IF;
		ELSE
			IF last.id IS NULL OR last.kind <> 'lodged' THEN
				RAISE EXCEPTION 'no appeal is open: record the appeal lodged first' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.forum <> last.forum THEN
				RAISE EXCEPTION 'an appeal is decided in the forum it was lodged with' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		IF NEW.event_date < coalesce(last.event_date, s.decision_date, NEW.event_date) THEN
			RAISE EXCEPTION 'an event is dated on or after the one before it' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.event_date > current_date + 1 THEN
			RAISE EXCEPTION 'an event isn''t dated in the future' USING ERRCODE = 'check_violation';
		END IF;
		NEW.position := coalesce(last.position, 0) + 1;
		NEW.recorded_by := uid;
		NEW.recorded_at := now();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER decision_event_guard BEFORE INSERT ON decision_event
	FOR EACH ROW EXECUTE FUNCTION decision_event_guard();
REVOKE ALL ON FUNCTION decision_event_guard() FROM PUBLIC;

ALTER TABLE decision_event ENABLE ROW LEVEL SECURITY;
-- Whoever reads the scenario reads what followed its decision (the scenario's own policies decide).
CREATE POLICY decision_event_select ON decision_event FOR SELECT
	USING (EXISTS (SELECT 1 FROM scenario s WHERE s.id = decision_event.scenario_id AND s.project_id = decision_event.project_id));
CREATE POLICY decision_event_insert ON decision_event FOR INSERT
	WITH CHECK (app_acts_for_authority(project_id));
-- Append-only: no UPDATE or DELETE grant or policy.
GRANT SELECT, INSERT ON decision_event TO water_app;

-- app_scenario_licence, from 231: the newest set aside or varied decides; an
-- open appeal (the newest event lodged) changes nothing but appealPending.
CREATE OR REPLACE FUNCTION app_scenario_licence(p_scenario uuid) RETURNS jsonb
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT CASE
			WHEN s.outcome IS NULL THEN NULL
			WHEN r.kind = 'varied' THEN jsonb_build_object(
				'inForce', true, 'from', 'event', 'eventId', r.id, 'appealPending', coalesce(p.pending, false),
				'terms', jsonb_build_object('ops', r.ops, 'opsSha256', r.ops_sha256, 'opNames', r.op_names,
					'conditions', r.conditions, 'asApplied', r.ops_sha256 = s.ops_sha256))
			WHEN r.kind = 'set_aside' THEN jsonb_build_object(
				'inForce', false, 'from', 'event', 'eventId', r.id, 'appealPending', coalesce(p.pending, false), 'terms', NULL)
			ELSE jsonb_build_object(
				'inForce', s.outcome = 'licence_issued', 'from', 'decision', 'eventId', NULL, 'appealPending', coalesce(p.pending, false),
				'terms', CASE WHEN s.outcome = 'licence_issued' THEN jsonb_build_object(
					'ops', s.granted_ops, 'opsSha256', s.granted_ops_sha256, 'opNames', s.granted_op_names,
					'conditions', s.granted_conditions, 'asApplied', s.granted_ops_sha256 = s.ops_sha256) END)
		END
		FROM scenario s
		LEFT JOIN LATERAL (
			SELECT e.id, e.kind, e.ops, e.ops_sha256, e.op_names, e.conditions FROM decision_event e
			WHERE e.scenario_id = s.id AND e.kind IN ('set_aside', 'varied') ORDER BY e.position DESC LIMIT 1
		) r ON true
		LEFT JOIN LATERAL (
			SELECT e.kind = 'lodged' AS pending FROM decision_event e WHERE e.scenario_id = s.id ORDER BY e.position DESC LIMIT 1
		) p ON true
		WHERE s.id = p_scenario AND s.status = 'decided'
	$$;
