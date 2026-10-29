-- 276_feed_fetch_out_hold — the scheduler leaves a feed alone while its fetch
-- is still out (docs/architecture.md § Data feeds → Schedule,
-- docs/data-model.md § Data feeds).
--
-- In production a feed_fetch job sends its request to the fetcher Lambda
-- through the fetch-requests FIFO queue and records itself on the feed
-- (data_feed.fetch_job_id, 029); only the answer to that newest fetch is
-- applied (app_take_feed_fetch), any older one is dropped as `not_awaited`.
-- CHC's requests go through one message group, one fetch at a time, and a
-- 120-day CHIRPS window takes 8–10 minutes at CHC's one request a second, so
-- with a dozen CHIRPS feeds an answer comes back about two hours after it was
-- asked for.
--
-- The scheduler didn't know a fetch was out. On 2026-10-28 22:29 UTC five
-- CHIRPS feeds failed once (CHC timed out), so each was due again 15 minutes
-- later (the failing backoff, 243), and again 15 minutes after that, each
-- time sending one more request to the back of the queue. Every answer that
-- came back then belonged to a fetch already superseded and was dropped: the
-- cell cache never got its days (so each request re-read all 120 days from
-- CHC, `cellDaysRead` = days), the failure was never cleared (so the backoff
-- stayed at 15 minutes), and the queue grew without end (98 requests on
-- 2026-10-29), holding CHC's shared request slot around the clock so the
-- mirror ingest's daily rnl and sat runs found it busy.
--
-- Now a feed whose fetch is out is not due, from either the listing
-- (app_due_feeds) or the claim (app_claim_feed), until that fetch's answer is
-- applied (which clears fetch_job_id) or the fetch is a day old
-- (app_feed_fetch_out): an answer lost for good (a message in the DLQ, a
-- feed_ingest that died) holds the feed back no longer than its daily
-- schedule would. The fetch's age is its job's last attempt (job.started_at,
-- set by every claim, 123), and a job already purged (30 days) is no fetch
-- out. A feed waits for its own answer instead of superseding it, so it has
-- at most one request in the queue (a "Run now" press aside, which still
-- sends a newer one, rate-limited by 111), and an answer that comes back is
-- applied: a failure counts, a success resets the backoff and goes on with
-- the backfill. app_feed_is_due and app_feed_next_attempt (243) don't change:
-- the feed list's nextAttemptAt is the earliest instant, and a fetch still
-- out puts the real one after its answer.
--
-- In-job fetches (our copy, the gauge store, a window the cell cache held
-- whole) record and take the fetch in one transaction, so no other session
-- ever sees one out; inline fetches (local dev) record none. Only the SQS
-- path is affected.
--
-- From 242_feed_refused_backoff.sql (the latest definitions of both, same
-- signatures, so CREATE OR REPLACE keeps their grants). The new helper is an
-- ordinary (invoker's rights) function: inside those two SECURITY DEFINER
-- callers it reads job as the owner; called by anyone else it would see only
-- the jobs RLS shows them. It is revoked from PUBLIC as 242 revoked
-- app_feed_is_due (the owner's default privileges still give water_app
-- EXECUTE, harmless for that reason). No table, column or policy changes.

-- Is fetch p_job still out? It names a feed_fetch job that last started
-- within a day. NULL (no fetch out), an unknown or purged job: no.
CREATE FUNCTION app_feed_fetch_out(p_job uuid, p_now timestamptz)
	RETURNS boolean
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT p_job IS NOT NULL AND EXISTS (
			SELECT 1 FROM job j
			WHERE j.id = p_job AND j.kind = 'feed_fetch'
			  AND coalesce(j.started_at, j.created_at) > p_now - interval '1 day'
		)
	$$;

CREATE OR REPLACE FUNCTION app_due_feeds(p_limit integer, p_all boolean DEFAULT false)
	RETURNS TABLE (id uuid, project_id uuid, acting_user_id uuid)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
			RAISE EXCEPTION 'list 1–500 feeds' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		RETURN QUERY
		SELECT f.id, f.project_id, f.acting_user_id FROM data_feed f
		WHERE f.enabled AND f.acting_user_id IS NOT NULL
		  AND (p_all OR (app_feed_is_due(f.source, f.schedule, f.consecutive_failures, f.last_scheduled_at, now(), f.last_error)
		                 AND NOT app_feed_fetch_out(f.fetch_job_id, now())))
		ORDER BY f.last_scheduled_at NULLS FIRST, f.id
		LIMIT p_limit;
	END
	$$;

CREATE OR REPLACE FUNCTION app_claim_feed(p_feed uuid, p_all boolean DEFAULT false)
	RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_id uuid;
	BEGIN
		SELECT f.id INTO v_id FROM data_feed f
		WHERE f.id = p_feed AND f.enabled AND f.acting_user_id IS NOT NULL
		  AND f.acting_user_id = app_current_user_id()
		  AND (p_all OR (app_feed_is_due(f.source, f.schedule, f.consecutive_failures, f.last_scheduled_at, now(), f.last_error)
		                 AND NOT app_feed_fetch_out(f.fetch_job_id, now())))
		FOR UPDATE SKIP LOCKED;
		IF v_id IS NULL THEN
			RETURN false;
		END IF;
		UPDATE data_feed f SET last_scheduled_at = now() WHERE f.id = v_id;
		RETURN true;
	END
	$$;

REVOKE ALL ON FUNCTION app_feed_fetch_out(uuid, timestamptz) FROM PUBLIC;
