# ----------------------------------------------------------------------------
# Evidence packs' reproduction bundles (roadmap WP-3.14 item 11, issue #71;
# docs/evidence-pack.md § Reproduction, docs/deployment.md § Evidence packs,
# backend/migrations/122_pack_bundle.sql)
#
# Issuing a pack builds its reproduction bundle in the API, in the issue's own
# transaction, and stores it in the packs bucket (packs.tf) beside the PDF,
# under packs/<project>/<pack>/<sha256>.zip (app_record_pack_bundle derives
# the same key). The bucket's Object Lock keeps it as it keeps the PDF.
#
#   - the API may only PutObject a .zip under packs/ (no read, list, delete
#     or retention change), with the upload's own SHA-256 checksum, which S3
#     checks against the bytes and Object Lock requires of every put, and
#     If-None-Match, so a retried issue writes no second version;
#   - the bucket is SSE-S3 and its policy names no writer (packs.tf): the
#     role's own policy is the grant, and no KMS permission is needed;
#   - the API reaches S3 through packs.tf's one S3 interface endpoint (it is
#     in the private VPC, network.tf): SG to SG like every endpoint here, and
#     the endpoint policy's second statement (packs.tf) lets the API role put
#     bundles and nothing else through it. No new endpoint: no added cost;
#   - downloads go through /packs/* on CloudFront (packs.tf), signed by the
#     API as for the PDF: the API never reads the bucket.
# ----------------------------------------------------------------------------

data "aws_iam_policy_document" "api_pack_bundles" {
  statement {
    sid       = "PutPackBundles"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.packs.arn}/packs/*.zip"]
  }
}

resource "aws_iam_role_policy" "api_pack_bundles" {
  name   = "pack-bundles"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.api_pack_bundles.json
}

resource "aws_vpc_security_group_ingress_rule" "vpce_s3_from_api" {
  security_group_id            = aws_security_group.vpce_s3.id
  referenced_security_group_id = aws_security_group.api_lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the API Lambda (pack bundles)"
}

resource "aws_vpc_security_group_egress_rule" "api_to_vpce_s3" {
  security_group_id            = aws_security_group.api_lambda.id
  referenced_security_group_id = aws_security_group.vpce_s3.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "S3 endpoint"
}
