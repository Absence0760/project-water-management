# ----------------------------------------------------------------------------
# The data mirror's backfill (issue #604 R2-B, D4; docs/deployment.md § The
# data mirror → Backfill)
#
# A Step Functions state machine the operator starts by hand (no schedule)
# with the month list ingest/backfill_plan.py prints:
#
#   { "items": [ { "product": "rnl", "mode": "backfill", "month": "1981-01" }, … ] }
#
# It invokes the Python ingest Lambda (ingest.tf) once per month, in order,
# one at a time, and waits ingest_backfill_wait_seconds (≥ 60) after each:
# D4's one bulk file a minute against CHC.
#
#   - One at a time (MaxConcurrency = 1), not D11's 2: a finals chunk holds a
#     whole year (chunk (1, 366, 20, 20)), so two months of one year written
#     at once would each read the chunk, add their month and write it back,
#     and the second write would lose the first month.
#   - A failed month stops the execution. The function's own errors are never
#     retried: a 403 (polite.py StopRun) is CHC refusing us, and asking again
#     is what gets an address banned. Only Lambda's service errors (throttled
#     by the ingest's reserved concurrency, a transient API error) are retried,
#     after a minute. Re-running the plan skips the months the manifest holds.
#     Two "busy" errors are waits, not failures, and are retried: MirrorBusy
#     (the daily run holds the product's lease) and HostBusy (the fetcher
#     Lambda holds CHC's one request slot, feeds.tf header): a month that
#     meets either asked CHC nothing.
#   - The execution holds CHC's request slot for its whole run (issue #618
#     step 4; ingest/lease.py hold_host_for_backfill). Each month's payload
#     names the execution ($$.Execution.Id) and the pause, so every month
#     takes the slot as one owner and keeps it through the Pace after; the
#     fetcher's per-feed fetches defer (and re-queue every 2 minutes) and the
#     daily rnl/sat runs end quietly until it ends, with no manual switching.
#     ReleaseHold, reached after the Map on success and through its Catch on
#     failure, releases it; then Outcome fails the execution with the month's
#     own error, or succeeds. Released here rather than by an EventBridge
#     rule on the execution's status: the step reuses this role's one grant
#     (invoke the ingest function) and needs no rule, target or extra
#     permission. The case it misses, an execution stopped by hand (Catch
#     doesn't run on StopExecution), is covered by the hold's expiry: at most
#     the pause plus 5 minutes after the month that was running ends (the
#     running month's own deadline plus that, if stopped mid-month), or delete
#     ingest-state/hosts/chc/lease.json by hand (docs/deployment.md § Backfill).
#   - A plain (inline) Map over the list: ~900 months at ~10 history events
#     each stays well under a Standard execution's 25,000-event history, and
#     needs no S3 item reader or child executions.
#
# Created only once the ingest function exists (ingest_image_tag). Its role
# may invoke that one function and nothing else.
# ----------------------------------------------------------------------------

locals {
  ingest_backfill_name = "${local.project}-mirror-backfill"
  # Lambda's own service errors (throttling, a transient API failure): retried; the function's errors aren't.
  ingest_backfill_lambda_errors = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
}

data "aws_iam_policy_document" "ingest_backfill_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
    # Only this account's state machine of this name may assume it (confused deputy).
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.ingest_backfill_name}"]
    }
  }
}

resource "aws_iam_role" "ingest_backfill" {
  count = local.ingest_enabled ? 1 : 0

  name               = "${local.project}-mirror-backfill"
  assume_role_policy = data.aws_iam_policy_document.ingest_backfill_assume_role.json
}

data "aws_iam_policy_document" "ingest_backfill" {
  statement {
    sid     = "InvokeIngestOnly"
    actions = ["lambda:InvokeFunction"]
    # The function and its qualified forms (a version or alias), nothing else.
    resources = [local.ingest_function_arn, "${local.ingest_function_arn}:*"]
  }
}

resource "aws_iam_role_policy" "ingest_backfill" {
  count = local.ingest_enabled ? 1 : 0

  name   = "invoke-mirror-ingest"
  role   = aws_iam_role.ingest_backfill[0].id
  policy = data.aws_iam_policy_document.ingest_backfill.json
}

resource "aws_sfn_state_machine" "ingest_backfill" {
  count = local.ingest_enabled ? 1 : 0

  name     = local.ingest_backfill_name
  role_arn = aws_iam_role.ingest_backfill[0].arn
  type     = "STANDARD"

  definition = jsonencode({
    Comment = "Mirror backfill (issue #604 D4): one CHC byMonth file a month, in order, one at a time, a wait after each, holding CHC's request slot for the whole run (released at the end, success or failure). Input: {\"items\": [{\"product\", \"mode\": \"backfill\", \"month\"}, …]} from ingest/backfill_plan.py."
    StartAt = "Months"
    States = {
      Months = {
        Type      = "Map"
        ItemsPath = "$.items"
        # One at a time: a finals chunk holds a whole year (see the header).
        MaxConcurrency = 1
        # The months' answers aren't kept: the execution's history has them.
        ResultPath = null
        ItemProcessor = {
          ProcessorConfig = { Mode = "INLINE" }
          StartAt         = "Ingest"
          States = {
            Ingest = {
              Type     = "Task"
              Resource = "arn:aws:states:::lambda:invoke"
              # The month, plus this execution's hold on CHC's request slot
              # (see the header): every month of the execution takes the slot
              # as the same owner and keeps it through the Pace after.
              Parameters = {
                FunctionName = local.ingest_function_arn
                Payload = {
                  "product.$" = "$.product"
                  "mode.$"    = "$.mode"
                  "month.$"   = "$.month"
                  hold = {
                    "execution.$" = "$$.Execution.Id"
                    pauseSeconds  = var.ingest_backfill_wait_seconds
                  }
                }
              }
              # A little over the function's own 900 s.
              TimeoutSeconds = local.ingest_timeout_s + 60
              ResultPath     = null
              # Lambda's service errors (throttled by the ingest's reserved
              # concurrency, a transient API failure), and MirrorBusy: the daily
              # monthly run holds the product's lease (ingest/lease.py, at most
              # 20 minutes), so wait it out (5 × 300 s outlasts it). The
              # function's other errors, StopRun on a 403 above all, are not
              # retried: they fail the execution.
              Retry = [{
                ErrorEquals     = local.ingest_backfill_lambda_errors
                IntervalSeconds = 60
                MaxAttempts     = 3
                BackoffRate     = 2
                }, {
                ErrorEquals     = ["MirrorBusy"]
                IntervalSeconds = 300
                MaxAttempts     = 5
                BackoffRate     = 1
                }, {
                # HostBusy: the fetcher Lambda (or a daily run, or another
                # execution) holds CHC's one request slot (ingest/lease.py,
                # backend/src/feeds/hostSlot.ts). Only the first month of an
                # execution meets it in practice (later ones find their own
                # hold), and it reserves the next turn, so the fetch running
                # now (at most its 900 s) is the wait; retry every 2 minutes
                # for an hour before the execution fails (re-running the plan
                # skips the months already held).
                ErrorEquals     = ["HostBusy"]
                IntervalSeconds = 120
                MaxAttempts     = 30
                BackoffRate     = 1
              }]
              Next = "Pace"
            }
            Pace = {
              Type    = "Wait"
              Seconds = var.ingest_backfill_wait_seconds
              End     = true
            }
          }
        }
        # Done or failed, the execution's hold on CHC's slot is released next.
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.error"
          Next        = "ReleaseHold"
        }]
        Next = "ReleaseHold"
      }
      # Release this execution's hold (ingest/lease.py release_backfill_hold:
      # only ever its own). Its own failure doesn't change the outcome: the
      # hold then expires within BACKFILL_HOLD_MARGIN_S past the pause.
      ReleaseHold = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = local.ingest_function_arn
          Payload = {
            mode = "release_hold"
            hold = { "execution.$" = "$$.Execution.Id" }
          }
        }
        TimeoutSeconds = 120
        ResultPath     = null
        Retry = [{
          ErrorEquals     = local.ingest_backfill_lambda_errors
          IntervalSeconds = 30
          MaxAttempts     = 3
          BackoffRate     = 2
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.releaseError"
          Next        = "Outcome"
        }]
        Next = "Outcome"
      }
      # The months' outcome stands: a month's error fails the execution with that error.
      Outcome = {
        Type = "Choice"
        Choices = [{
          Variable  = "$.error"
          IsPresent = true
          Next      = "MonthFailed"
        }]
        Default = "Done"
      }
      MonthFailed = {
        Type      = "Fail"
        ErrorPath = "$.error.Error"
        CausePath = "$.error.Cause"
      }
      Done = {
        Type = "Succeed"
      }
    }
  })

  depends_on = [aws_iam_role_policy.ingest_backfill]
}
