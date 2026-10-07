locals {
  frontend_hosting_enabled = local.deployment_target.frontend_subdomain != null
  frontend_sites = local.frontend_hosting_enabled ? {
    current = {
      domain_name = "${local.deployment_target.frontend_subdomain}.${var.frontend_root_domain_name}"
    }
  } : {}
  frontend_bucket_name  = "${substr(local.resource_name_prefix, 0, 32)}-${local.deployment_target.aws_account_id}-frontend"
  frontend_s3_origin_id = "${local.resource_name_prefix}-frontend-s3"
}

data "aws_route53_zone" "frontend" {
  for_each = local.frontend_sites

  name         = "${var.frontend_root_domain_name}."
  private_zone = false
}

resource "aws_s3_bucket" "frontend" {
  for_each = local.frontend_sites

  bucket        = local.frontend_bucket_name
  force_destroy = false
}

resource "aws_s3_bucket_ownership_controls" "frontend" {
  for_each = local.frontend_sites

  bucket = aws_s3_bucket.frontend[each.key].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  for_each = local.frontend_sites

  bucket = aws_s3_bucket.frontend[each.key].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  for_each = local.frontend_sites

  bucket = aws_s3_bucket.frontend[each.key].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "frontend" {
  for_each = local.frontend_sites

  bucket = aws_s3_bucket.frontend[each.key].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "frontend" {
  for_each = local.frontend_sites

  bucket = aws_s3_bucket.frontend[each.key].id

  rule {
    id     = "clean-up-incomplete-and-old-frontend-objects"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    expiration {
      expired_object_delete_marker = true
    }
  }

  depends_on = [aws_s3_bucket_versioning.frontend]
}

resource "aws_acm_certificate" "frontend" {
  provider = aws.us_east_1
  for_each = local.frontend_sites

  domain_name       = each.value.domain_name
  validation_method = "DNS"

  options {
    certificate_transparency_logging_preference = "ENABLED"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "frontend_certificate_validation" {
  for_each = local.frontend_sites

  zone_id = data.aws_route53_zone.frontend[each.key].zone_id
  name    = one(aws_acm_certificate.frontend[each.key].domain_validation_options).resource_record_name
  type    = one(aws_acm_certificate.frontend[each.key].domain_validation_options).resource_record_type
  ttl     = 60
  records = [one(aws_acm_certificate.frontend[each.key].domain_validation_options).resource_record_value]
}

resource "aws_acm_certificate_validation" "frontend" {
  provider = aws.us_east_1
  for_each = local.frontend_sites

  certificate_arn = aws_acm_certificate.frontend[each.key].arn
  validation_record_fqdns = [
    aws_route53_record.frontend_certificate_validation[each.key].fqdn,
  ]
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  for_each = local.frontend_sites

  name                              = "${local.resource_name_prefix}-frontend-oac"
  description                       = "Private S3 access for ${each.value.domain_name}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_cloudfront_cache_policy" "frontend_no_cache" {
  for_each = local.frontend_sites
  name     = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "frontend_assets" {
  for_each = local.frontend_sites
  name     = "Managed-CachingOptimized"
}

data "aws_cloudfront_response_headers_policy" "frontend_security_headers" {
  for_each = local.frontend_sites
  name     = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudfront_distribution" "frontend" {
  for_each = local.frontend_sites

  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  comment             = each.value.domain_name
  aliases             = [each.value.domain_name]
  default_root_object = "index.html"
  price_class         = var.frontend_cloudfront_price_class

  origin {
    domain_name              = aws_s3_bucket.frontend[each.key].bucket_regional_domain_name
    origin_id                = local.frontend_s3_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend[each.key].id
  }

  default_cache_behavior {
    target_origin_id       = local.frontend_s3_origin_id
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    allowed_methods = ["GET", "HEAD"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id            = data.aws_cloudfront_cache_policy.frontend_no_cache[each.key].id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.frontend_security_headers[each.key].id
  }

  ordered_cache_behavior {
    path_pattern           = "assets/*"
    target_origin_id       = local.frontend_s3_origin_id
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    allowed_methods = ["GET", "HEAD"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id            = data.aws_cloudfront_cache_policy.frontend_assets[each.key].id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.frontend_security_headers[each.key].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.frontend[each.key].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  lifecycle {
    precondition {
      condition     = var.cors_allowed_origin == "https://${each.value.domain_name}"
      error_message = "cors_allowed_origin must exactly match https://${each.value.domain_name} before frontend hosting can be deployed."
    }
  }
}

data "aws_iam_policy_document" "frontend_bucket" {
  for_each = local.frontend_sites

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.frontend[each.key].arn,
      "${aws_s3_bucket.frontend[each.key].arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid     = "AllowCloudFrontRead"
    effect  = "Allow"
    actions = ["s3:GetObject"]
    resources = [
      "${aws_s3_bucket.frontend[each.key].arn}/*",
    ]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend[each.key].arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  for_each = local.frontend_sites

  bucket = aws_s3_bucket.frontend[each.key].id
  policy = data.aws_iam_policy_document.frontend_bucket[each.key].json

  depends_on = [aws_s3_bucket_public_access_block.frontend]
}

resource "aws_route53_record" "frontend_ipv4" {
  for_each = local.frontend_sites

  zone_id = data.aws_route53_zone.frontend[each.key].zone_id
  name    = each.value.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend[each.key].domain_name
    zone_id                = aws_cloudfront_distribution.frontend[each.key].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "frontend_ipv6" {
  for_each = local.frontend_sites

  zone_id = data.aws_route53_zone.frontend[each.key].zone_id
  name    = each.value.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.frontend[each.key].domain_name
    zone_id                = aws_cloudfront_distribution.frontend[each.key].hosted_zone_id
    evaluate_target_health = false
  }
}
