# ----------------------------------------------------------------------------
# RDS PostgreSQL 17 — single-AZ db.t4g.micro in the private subnets
#
# Why RDS over Aurora Serverless v2 (infra/README.md § Database choice): it is
# always warm (no ~15 s resume on the first request after idle), costs a
# predictable ~$14/month, and uses the same `pg` driver + Postgres 17 as local
# dev.
#
# Roles:
#   - `water` — the RDS master user. Owns the database and every object the
#     migrations create (it is the "schema owner"). Its password is generated,
#     stored and rotated by RDS in Secrets Manager
#     (manage_master_user_password), so it never appears in Terraform state or
#     in any Lambda environment. Only the migrate Lambda reads it, at run time.
#   - `water_app` — the RLS-bound runtime role (NOSUPERUSER NOBYPASSRLS, owns
#     nothing). Created / password-set by the migrate Lambda
#     (backend/src/lambda-migrate.ts) from the sops `db_app_password`.
# ----------------------------------------------------------------------------

resource "aws_db_subnet_group" "main" {
  name       = "${local.project}-db"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${local.project}-db" }
}

resource "aws_db_parameter_group" "pg17" {
  name        = "${local.project}-pg17"
  family      = "postgres17"
  description = "water-management Postgres 17: TLS enforced, slow-query logging."

  # Refuse any non-TLS connection (the default is already 1 on PG 15+, pinned
  # here so a default-group change can't silently loosen it).
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Log statements slower than 1 s — enough to spot a bad model-run query
  # without logging every statement (and without Performance Insights).
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  # No statement is logged for its type (the default, pinned): DDL, including
  # the migrate Lambda's `ALTER ROLE water_app … PASSWORD 'SCRAM-SHA-256$…'`,
  # is not logged just for being DDL. It does NOT keep a statement's text out
  # of the log altogether: log_min_duration_statement above logs the full text
  # of anything slower than 1 s, whatever its type. DDL can't take bind
  # parameters, so a slow ALTER ROLE (a cold instance, a lock wait on
  # pg_authid) would log the verifier. That is a salted SCRAM verifier, never
  # the plaintext (lambda-migrate.ts computes it in-process), in a log group
  # only this account's operators can read, kept 30 days.
  parameter {
    name  = "log_statement"
    value = "none"
  }

  # Never log bind values. With log_min_duration_statement on, Postgres 17
  # appends "parameters: $1 = '…'" to every slow statement, in full by default
  # (-1): email addresses, farm names, a whole series blob. 0 logs none, for
  # slow statements and (the _on_error twin, pinned too) for failed ones.
  # Both are dynamic: no reboot.
  parameter {
    name  = "log_parameter_max_length"
    value = "0"
  }
  parameter {
    name  = "log_parameter_max_length_on_error"
    value = "0"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Pre-create the log group so retention is bounded (RDS would otherwise
# create it with "never expire").
resource "aws_cloudwatch_log_group" "rds" {
  name              = "/aws/rds/instance/${local.project}/postgresql"
  retention_in_days = var.db_log_retention_days
}

resource "aws_db_instance" "main" {
  identifier = local.project

  engine                     = "postgres"
  engine_version             = "17"
  auto_minor_version_upgrade = true
  instance_class             = var.db_instance_class
  parameter_group_name       = aws_db_parameter_group.pg17.name

  storage_type          = "gp3"
  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_max_allocated_storage_gb
  storage_encrypted     = true # AWS-managed aws/rds key; a CMK would add $1/mo for no gain here

  db_name  = "water"
  username = "water"
  # RDS generates, stores (Secrets Manager, aws/secretsmanager key) and
  # rotates the master password. Nothing secret enters Terraform state.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  backup_retention_period   = var.db_backup_retention_days
  backup_window             = "00:00-01:00" # UTC — 02:00-03:00 SAST
  maintenance_window        = "sun:01:30-sun:02:30"
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.project}-final"
  deletion_protection       = true

  # Off to keep the bill flat: Performance Insights and Enhanced Monitoring.
  # The basic (free) CloudWatch RDS metrics feed the alarms in alarms.tf, and
  # slow queries land in the exported postgresql log.
  performance_insights_enabled = false
  monitoring_interval          = 0

  enabled_cloudwatch_logs_exports = ["postgresql"]

  # Instance/engine changes wait for the maintenance window. Flip this for a
  # one-off apply when a change genuinely can't wait.
  apply_immediately = false

  tags = { Name = "${local.project}-db" }

  depends_on = [aws_cloudwatch_log_group.rds]
}
