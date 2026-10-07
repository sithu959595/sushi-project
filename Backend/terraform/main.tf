locals {
  normalized_service_name = lower(replace(var.service_name, "_", "-"))
  stage                   = local.deployment_target.stage
  resource_name_prefix    = "${local.normalized_service_name}-${local.stage}"
  dishes_table_name_base  = var.table_name != "" ? var.table_name : "dishes-table"
  dishes_table_name       = "${local.dishes_table_name_base}-${local.stage}"
  dish_images_bucket_name = "${substr(local.resource_name_prefix, 0, 35)}-${local.deployment_target.aws_account_id}-images"
  lambda_zip_path         = "${path.module}/build/lambda-source.zip"
}

data "archive_file" "lambda_source" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = local.lambda_zip_path
}

resource "aws_dynamodb_table" "dishes" {
  name         = local.dishes_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_s3_bucket" "dish_images" {
  bucket        = local.dish_images_bucket_name
  force_destroy = false
}

resource "aws_s3_bucket_ownership_controls" "dish_images" {
  bucket = aws_s3_bucket.dish_images.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "dish_images" {
  bucket = aws_s3_bucket.dish_images.id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = !var.dish_images_public_read_enabled
  restrict_public_buckets = !var.dish_images_public_read_enabled
}

resource "aws_s3_bucket_server_side_encryption_configuration" "dish_images" {
  bucket = aws_s3_bucket.dish_images.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "dish_images" {
  bucket = aws_s3_bucket.dish_images.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_cors_configuration" "dish_images" {
  bucket = aws_s3_bucket.dish_images.id

  cors_rule {
    allowed_headers = ["Cache-Control", "Content-Type"]
    allowed_methods = ["GET", "HEAD", "PUT"]
    allowed_origins = [var.cors_allowed_origin]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "dish_images" {
  bucket = aws_s3_bucket.dish_images.id

  rule {
    id     = "clean-up-incomplete-and-replaced-images"
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

  depends_on = [aws_s3_bucket_versioning.dish_images]
}

data "aws_iam_policy_document" "dish_images_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.dish_images.arn,
      "${aws_s3_bucket.dish_images.arn}/*",
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

  dynamic "statement" {
    for_each = var.dish_images_public_read_enabled ? [1] : []

    content {
      sid     = "PublicReadPublishedDishImages"
      effect  = "Allow"
      actions = ["s3:GetObject"]
      resources = [
        "${aws_s3_bucket.dish_images.arn}/dishes/*",
      ]

      principals {
        type        = "*"
        identifiers = ["*"]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "dish_images" {
  bucket = aws_s3_bucket.dish_images.id
  policy = data.aws_iam_policy_document.dish_images_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.dish_images]
}

resource "aws_cognito_user_pool" "users" {
  name = "${local.resource_name_prefix}-user-pool"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }
}

resource "aws_cognito_user_pool_client" "app" {
  name         = "${local.resource_name_prefix}-app-client"
  user_pool_id = aws_cognito_user_pool.users.id

  generate_secret               = false
  prevent_user_existence_errors = "ENABLED"

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]
}

resource "aws_cognito_user_group" "admins" {
  name         = var.admin_group_name
  user_pool_id = aws_cognito_user_pool.users.id
  description  = "Users allowed to create and manage sushi menu dishes."
}

resource "aws_cloudwatch_log_group" "create_dish" {
  name              = "/aws/lambda/${local.resource_name_prefix}-create-dish"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "get_dishes" {
  name              = "/aws/lambda/${local.resource_name_prefix}-get-dishes"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "replace_dishes" {
  name              = "/aws/lambda/${local.resource_name_prefix}-replace-dishes"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "create_image_upload" {
  name              = "/aws/lambda/${local.resource_name_prefix}-create-image-upload"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "dish_stream" {
  name              = "/aws/lambda/${local.resource_name_prefix}-dish-stream"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "create_dish" {
  function_name    = "${local.resource_name_prefix}-create-dish"
  role             = aws_iam_role.create_dish_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/index.fn"
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      ADMIN_GROUP_NAME    = aws_cognito_user_group.admins.name
      CORS_ALLOWED_ORIGIN = var.cors_allowed_origin
      DISHES_TABLE        = aws_dynamodb_table.dishes.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.create_dish]
}

resource "aws_lambda_function" "get_dishes" {
  function_name    = "${local.resource_name_prefix}-get-dishes"
  role             = aws_iam_role.get_dishes_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/get-dishes.fn"
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      ADMIN_GROUP_NAME    = aws_cognito_user_group.admins.name
      CORS_ALLOWED_ORIGIN = var.cors_allowed_origin
      DISHES_TABLE        = aws_dynamodb_table.dishes.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.get_dishes]
}

resource "aws_lambda_function" "replace_dishes" {
  function_name    = "${local.resource_name_prefix}-replace-dishes"
  role             = aws_iam_role.replace_dishes_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/replace-dishes.fn"
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      ADMIN_GROUP_NAME    = aws_cognito_user_group.admins.name
      CORS_ALLOWED_ORIGIN = var.cors_allowed_origin
      DISHES_TABLE        = aws_dynamodb_table.dishes.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.replace_dishes]
}

resource "aws_lambda_function" "create_image_upload" {
  function_name    = "${local.resource_name_prefix}-create-image-upload"
  role             = aws_iam_role.create_image_upload_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/create-image-upload.fn"
  memory_size      = 256
  timeout          = 10
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      ADMIN_GROUP_NAME    = aws_cognito_user_group.admins.name
      CORS_ALLOWED_ORIGIN = var.cors_allowed_origin
      DISH_IMAGES_BUCKET  = local.dish_images_bucket_name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.create_image_upload,
    aws_iam_role_policy.create_image_upload_lambda,
  ]
}

resource "aws_lambda_function" "dish_stream" {
  function_name    = "${local.resource_name_prefix}-dish-stream"
  role             = aws_iam_role.dish_stream_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/dish-stream.fn"
  memory_size      = 256
  timeout          = 60
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      DISH_IMAGES_BUCKET           = local.dish_images_bucket_name
      DISH_INDEX_UPDATES_QUEUE_URL = aws_sqs_queue.dish_index_updates.url
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.dish_stream,
    aws_iam_role_policy.dish_stream_lambda,
  ]
}

resource "aws_lambda_event_source_mapping" "dish_stream" {
  event_source_arn  = aws_dynamodb_table.dishes.stream_arn
  function_name     = aws_lambda_function.dish_stream.arn
  starting_position = "TRIM_HORIZON"
  batch_size        = 1

  bisect_batch_on_function_error = true

  depends_on = [aws_iam_role_policy.dish_stream_lambda]
}

resource "aws_api_gateway_rest_api" "api" {
  name = local.resource_name_prefix

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_authorizer" "cognito" {
  name          = "${local.resource_name_prefix}-cognito-authorizer"
  rest_api_id   = aws_api_gateway_rest_api.api.id
  type          = "COGNITO_USER_POOLS"
  provider_arns = [aws_cognito_user_pool.users.arn]
}

resource "aws_api_gateway_resource" "dishes" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "dishes"
}

resource "aws_api_gateway_resource" "private_dishes" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.dishes.id
  path_part   = "private"
}

resource "aws_api_gateway_resource" "dish_images" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "dish-images"
}

resource "aws_api_gateway_resource" "dish_image_upload_url" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.dish_images.id
  path_part   = "upload-url"
}

resource "aws_api_gateway_method" "create_dish" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.dishes.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "create_dish" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.dishes.id
  http_method             = aws_api_gateway_method.create_dish.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.create_dish.invoke_arn
}

resource "aws_api_gateway_method" "get_dishes" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.dishes.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "get_dishes" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.dishes.id
  http_method             = aws_api_gateway_method.get_dishes.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.get_dishes.invoke_arn
}

resource "aws_api_gateway_method" "get_private_dishes" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.private_dishes.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "get_private_dishes" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.private_dishes.id
  http_method             = aws_api_gateway_method.get_private_dishes.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.get_dishes.invoke_arn
}

resource "aws_api_gateway_method" "replace_dishes" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.dishes.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "replace_dishes" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.dishes.id
  http_method             = aws_api_gateway_method.replace_dishes.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.replace_dishes.invoke_arn
}

resource "aws_api_gateway_method" "create_image_upload" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.dish_image_upload_url.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "create_image_upload" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.dish_image_upload_url.id
  http_method             = aws_api_gateway_method.create_image_upload.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.create_image_upload.invoke_arn
}

resource "aws_api_gateway_method" "dishes_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.dishes.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "dishes_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.dishes.id
  http_method = aws_api_gateway_method.dishes_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "dishes_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.dishes.id
  http_method = aws_api_gateway_method.dishes_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "dishes_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.dishes.id
  http_method = aws_api_gateway_method.dishes_options.http_method
  status_code = aws_api_gateway_method_response.dishes_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,GET,POST,PUT'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.dishes_options]
}

resource "aws_api_gateway_method" "private_dishes_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.private_dishes.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "private_dishes_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.private_dishes.id
  http_method = aws_api_gateway_method.private_dishes_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "private_dishes_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.private_dishes.id
  http_method = aws_api_gateway_method.private_dishes_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "private_dishes_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.private_dishes.id
  http_method = aws_api_gateway_method.private_dishes_options.http_method
  status_code = aws_api_gateway_method_response.private_dishes_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,GET'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.private_dishes_options]
}

resource "aws_api_gateway_method" "dish_image_upload_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.dish_image_upload_url.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "dish_image_upload_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.dish_image_upload_url.id
  http_method = aws_api_gateway_method.dish_image_upload_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "dish_image_upload_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.dish_image_upload_url.id
  http_method = aws_api_gateway_method.dish_image_upload_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "dish_image_upload_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.dish_image_upload_url.id
  http_method = aws_api_gateway_method.dish_image_upload_options.http_method
  status_code = aws_api_gateway_method_response.dish_image_upload_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,POST'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.dish_image_upload_options]
}

resource "aws_api_gateway_gateway_response" "default_4xx" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  response_type = "DEFAULT_4XX"

  response_templates = {
    "application/json" = "{\"message\":$context.error.messageString}"
  }

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "gatewayresponse.header.Access-Control-Allow-Methods" = "'OPTIONS,GET,PATCH,POST,PUT'"
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }
}

resource "aws_api_gateway_gateway_response" "default_5xx" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  response_type = "DEFAULT_5XX"

  response_templates = {
    "application/json" = "{\"message\":$context.error.messageString}"
  }

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "gatewayresponse.header.Access-Control-Allow-Methods" = "'OPTIONS,GET,PATCH,POST,PUT'"
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }
}

resource "aws_lambda_permission" "allow_create_dish_from_api_gateway" {
  statement_id  = "AllowCreateDishFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.create_dish.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.create_dish.http_method}${aws_api_gateway_resource.dishes.path}"
}

resource "aws_lambda_permission" "allow_get_dishes_from_api_gateway" {
  statement_id  = "AllowGetDishesFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_dishes.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.get_dishes.http_method}${aws_api_gateway_resource.dishes.path}"
}

resource "aws_lambda_permission" "allow_get_private_dishes_from_api_gateway" {
  statement_id  = "AllowGetPrivateDishesFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_dishes.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.get_private_dishes.http_method}${aws_api_gateway_resource.private_dishes.path}"
}

resource "aws_lambda_permission" "allow_replace_dishes_from_api_gateway" {
  statement_id  = "AllowReplaceDishesFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.replace_dishes.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.replace_dishes.http_method}${aws_api_gateway_resource.dishes.path}"
}

resource "aws_lambda_permission" "allow_create_image_upload_from_api_gateway" {
  statement_id  = "AllowCreateImageUploadFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.create_image_upload.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.create_image_upload.http_method}${aws_api_gateway_resource.dish_image_upload_url.path}"
}

resource "aws_api_gateway_deployment" "deployment" {
  rest_api_id = aws_api_gateway_rest_api.api.id

  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.dishes.id,
      aws_api_gateway_resource.private_dishes.id,
      aws_api_gateway_resource.dish_images.id,
      aws_api_gateway_resource.dish_image_upload_url.id,
      aws_api_gateway_resource.orders.id,
      aws_api_gateway_resource.ordering_status.id,
      aws_api_gateway_resource.my_orders.id,
      aws_api_gateway_resource.order_by_id.id,
      aws_api_gateway_resource.order_status.id,
      aws_api_gateway_resource.admin.id,
      aws_api_gateway_resource.admin_ordering_status.id,
      aws_api_gateway_resource.admin_orders.id,
      aws_api_gateway_resource.admin_order_by_id.id,
      aws_api_gateway_resource.admin_order_customer.id,
      aws_api_gateway_resource.admin_order_customer_pickup_failures.id,
      aws_api_gateway_resource.announcements.id,
      aws_api_gateway_resource.private_announcements.id,
      aws_api_gateway_resource.announcement_by_id.id,
      aws_api_gateway_resource.chat.id,
      aws_api_gateway_resource.chat_sessions.id,
      aws_api_gateway_resource.chat_session_by_id.id,
      aws_api_gateway_resource.chat_session_messages.id,
      aws_api_gateway_method.create_dish.id,
      aws_api_gateway_integration.create_dish.id,
      aws_api_gateway_method.get_dishes.id,
      aws_api_gateway_integration.get_dishes.id,
      aws_api_gateway_method.get_private_dishes.id,
      aws_api_gateway_integration.get_private_dishes.id,
      aws_api_gateway_method.replace_dishes.id,
      aws_api_gateway_integration.replace_dishes.id,
      aws_api_gateway_method.create_image_upload.id,
      aws_api_gateway_integration.create_image_upload.id,
      aws_api_gateway_method.dishes_options.id,
      aws_api_gateway_integration.dishes_options.id,
      aws_api_gateway_integration_response.dishes_options_200.id,
      aws_api_gateway_method.private_dishes_options.id,
      aws_api_gateway_integration.private_dishes_options.id,
      aws_api_gateway_integration_response.private_dishes_options_200.id,
      aws_api_gateway_method.dish_image_upload_options.id,
      aws_api_gateway_integration.dish_image_upload_options.id,
      aws_api_gateway_integration_response.dish_image_upload_options_200.id,
      aws_api_gateway_method.create_order.id,
      aws_api_gateway_integration.create_order.id,
      aws_api_gateway_method.get_ordering_status.id,
      aws_api_gateway_integration.get_ordering_status.id,
      aws_api_gateway_method.update_ordering_status.id,
      aws_api_gateway_integration.update_ordering_status.id,
      aws_api_gateway_method.list_orders.id,
      aws_api_gateway_integration.list_orders.id,
      aws_api_gateway_method.list_my_orders.id,
      aws_api_gateway_integration.list_my_orders.id,
      aws_api_gateway_method.update_order_status.id,
      aws_api_gateway_integration.update_order_status.id,
      aws_api_gateway_method.get_customer_pickup_failures.id,
      aws_api_gateway_integration.get_customer_pickup_failures.id,
      aws_api_gateway_method.orders_options.id,
      aws_api_gateway_integration.orders_options.id,
      aws_api_gateway_integration_response.orders_options_200.id,
      aws_api_gateway_method.ordering_status_options.id,
      aws_api_gateway_integration.ordering_status_options.id,
      aws_api_gateway_integration_response.ordering_status_options_200.id,
      aws_api_gateway_method.admin_ordering_status_options.id,
      aws_api_gateway_integration.admin_ordering_status_options.id,
      aws_api_gateway_integration_response.admin_ordering_status_options_200.id,
      aws_api_gateway_method.my_orders_options.id,
      aws_api_gateway_integration.my_orders_options.id,
      aws_api_gateway_integration_response.my_orders_options_200.id,
      aws_api_gateway_method.order_status_options.id,
      aws_api_gateway_integration.order_status_options.id,
      aws_api_gateway_integration_response.order_status_options_200.id,
      aws_api_gateway_method.customer_pickup_failures_options.id,
      aws_api_gateway_integration.customer_pickup_failures_options.id,
      aws_api_gateway_integration_response.customer_pickup_failures_options_200.id,
      aws_api_gateway_method.get_announcements.id,
      aws_api_gateway_integration.get_announcements.id,
      aws_api_gateway_method.create_announcement.id,
      aws_api_gateway_integration.create_announcement.id,
      aws_api_gateway_method.get_private_announcements.id,
      aws_api_gateway_integration.get_private_announcements.id,
      aws_api_gateway_method.update_announcement.id,
      aws_api_gateway_integration.update_announcement.id,
      aws_api_gateway_method.delete_announcement.id,
      aws_api_gateway_integration.delete_announcement.id,
      aws_api_gateway_method.announcements_options.id,
      aws_api_gateway_integration.announcements_options.id,
      aws_api_gateway_integration_response.announcements_options_200.id,
      aws_api_gateway_method.private_announcements_options.id,
      aws_api_gateway_integration.private_announcements_options.id,
      aws_api_gateway_integration_response.private_announcements_options_200.id,
      aws_api_gateway_method.announcement_by_id_options.id,
      aws_api_gateway_integration.announcement_by_id_options.id,
      aws_api_gateway_integration_response.announcement_by_id_options_200.id,
      aws_api_gateway_method.create_chat_session.id,
      aws_api_gateway_integration.create_chat_session.id,
      aws_api_gateway_method.get_chat_session.id,
      aws_api_gateway_integration.get_chat_session.id,
      aws_api_gateway_method.send_chat_message.id,
      aws_api_gateway_integration.send_chat_message.id,
      aws_api_gateway_method.chat_sessions_options.id,
      aws_api_gateway_integration.chat_sessions_options.id,
      aws_api_gateway_integration_response.chat_sessions_options_200.id,
      aws_api_gateway_method.chat_session_options.id,
      aws_api_gateway_integration.chat_session_options.id,
      aws_api_gateway_integration_response.chat_session_options_200.id,
      aws_api_gateway_method.chat_messages_options.id,
      aws_api_gateway_integration.chat_messages_options.id,
      aws_api_gateway_integration_response.chat_messages_options_200.id,
      aws_api_gateway_gateway_response.default_4xx.id,
      aws_api_gateway_gateway_response.default_5xx.id,
      var.cors_allowed_origin,
      "OPTIONS,DELETE,GET,PATCH,POST,PUT",
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_api_gateway_integration.create_dish,
    aws_api_gateway_integration.get_dishes,
    aws_api_gateway_integration.get_private_dishes,
    aws_api_gateway_integration.replace_dishes,
    aws_api_gateway_integration.create_image_upload,
    aws_api_gateway_integration.create_order,
    aws_api_gateway_integration.get_ordering_status,
    aws_api_gateway_integration.update_ordering_status,
    aws_api_gateway_integration.list_orders,
    aws_api_gateway_integration.list_my_orders,
    aws_api_gateway_integration.update_order_status,
    aws_api_gateway_integration.get_customer_pickup_failures,
    aws_api_gateway_integration.get_announcements,
    aws_api_gateway_integration.create_announcement,
    aws_api_gateway_integration.get_private_announcements,
    aws_api_gateway_integration.update_announcement,
    aws_api_gateway_integration.delete_announcement,
    aws_api_gateway_integration.create_chat_session,
    aws_api_gateway_integration.get_chat_session,
    aws_api_gateway_integration.send_chat_message,
    aws_api_gateway_integration_response.dishes_options_200,
    aws_api_gateway_integration_response.private_dishes_options_200,
    aws_api_gateway_integration_response.dish_image_upload_options_200,
    aws_api_gateway_integration_response.orders_options_200,
    aws_api_gateway_integration_response.ordering_status_options_200,
    aws_api_gateway_integration_response.admin_ordering_status_options_200,
    aws_api_gateway_integration_response.my_orders_options_200,
    aws_api_gateway_integration_response.order_status_options_200,
    aws_api_gateway_integration_response.customer_pickup_failures_options_200,
    aws_api_gateway_integration_response.announcements_options_200,
    aws_api_gateway_integration_response.private_announcements_options_200,
    aws_api_gateway_integration_response.announcement_by_id_options_200,
    aws_api_gateway_integration_response.chat_sessions_options_200,
    aws_api_gateway_integration_response.chat_session_options_200,
    aws_api_gateway_integration_response.chat_messages_options_200,
    aws_lambda_permission.allow_create_dish_from_api_gateway,
    aws_lambda_permission.allow_get_dishes_from_api_gateway,
    aws_lambda_permission.allow_get_private_dishes_from_api_gateway,
    aws_lambda_permission.allow_replace_dishes_from_api_gateway,
    aws_lambda_permission.allow_create_image_upload_from_api_gateway,
    aws_lambda_permission.allow_create_order_from_api_gateway,
    aws_lambda_permission.allow_get_ordering_status_from_api_gateway,
    aws_lambda_permission.allow_update_ordering_status_from_api_gateway,
    aws_lambda_permission.allow_list_orders_from_api_gateway,
    aws_lambda_permission.allow_list_my_orders_from_api_gateway,
    aws_lambda_permission.allow_update_order_status_from_api_gateway,
    aws_lambda_permission.allow_get_customer_pickup_failures_from_api_gateway,
    aws_lambda_permission.allow_get_announcements_from_api_gateway,
    aws_lambda_permission.allow_get_private_announcements_from_api_gateway,
    aws_lambda_permission.allow_create_announcement_from_api_gateway,
    aws_lambda_permission.allow_update_announcement_from_api_gateway,
    aws_lambda_permission.allow_delete_announcement_from_api_gateway,
    aws_lambda_permission.allow_rag_chat_from_api_gateway,
  ]
}

resource "aws_api_gateway_stage" "stage" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  deployment_id = aws_api_gateway_deployment.deployment.id
  stage_name    = local.stage
}
