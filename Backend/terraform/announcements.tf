locals {
  restaurant_content_table_name = "${local.resource_name_prefix}-restaurant-content"
}

resource "aws_dynamodb_table" "restaurant_content" {
  name         = local.restaurant_content_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = var.orders_point_in_time_recovery_enabled
  }

  server_side_encryption {
    enabled = true
  }
}

resource "aws_cloudwatch_log_group" "get_announcements" {
  name              = "/aws/lambda/${local.resource_name_prefix}-get-announcements"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "manage_announcements" {
  name              = "/aws/lambda/${local.resource_name_prefix}-manage-announcements"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "get_announcements_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.get_announcements.arn}:*"]
  }

  statement {
    sid       = "QueryRestaurantAnnouncements"
    actions   = ["dynamodb:Query"]
    resources = [aws_dynamodb_table.restaurant_content.arn]
  }
}

resource "aws_iam_role" "get_announcements_lambda" {
  name               = "${local.resource_name_prefix}-get-announcements-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "get_announcements_lambda" {
  name   = "GetAnnouncementsPolicy"
  role   = aws_iam_role.get_announcements_lambda.id
  policy = data.aws_iam_policy_document.get_announcements_lambda.json
}

data "aws_iam_policy_document" "manage_announcements_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.manage_announcements.arn}:*"]
  }

  statement {
    sid = "ManageRestaurantAnnouncements"

    actions = [
      "dynamodb:DeleteItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]

    resources = [aws_dynamodb_table.restaurant_content.arn]
  }
}

resource "aws_iam_role" "manage_announcements_lambda" {
  name               = "${local.resource_name_prefix}-manage-announcements-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "manage_announcements_lambda" {
  name   = "ManageAnnouncementsPolicy"
  role   = aws_iam_role.manage_announcements_lambda.id
  policy = data.aws_iam_policy_document.manage_announcements_lambda.json
}

resource "aws_lambda_function" "get_announcements" {
  function_name    = "${local.resource_name_prefix}-get-announcements"
  role             = aws_iam_role.get_announcements_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/get-announcements.fn"
  memory_size      = 256
  timeout          = 15
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      ADMIN_GROUP_NAME         = aws_cognito_user_group.admins.name
      CORS_ALLOWED_ORIGIN      = var.cors_allowed_origin
      RESTAURANT_CONTENT_TABLE = aws_dynamodb_table.restaurant_content.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.get_announcements,
    aws_iam_role_policy.get_announcements_lambda,
  ]
}

resource "aws_lambda_function" "manage_announcements" {
  function_name    = "${local.resource_name_prefix}-manage-announcements"
  role             = aws_iam_role.manage_announcements_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/manage-announcements.fn"
  memory_size      = 256
  timeout          = 15
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      ADMIN_GROUP_NAME         = aws_cognito_user_group.admins.name
      CORS_ALLOWED_ORIGIN      = var.cors_allowed_origin
      RESTAURANT_CONTENT_TABLE = aws_dynamodb_table.restaurant_content.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.manage_announcements,
    aws_iam_role_policy.manage_announcements_lambda,
  ]
}

resource "aws_api_gateway_resource" "announcements" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "announcements"
}

resource "aws_api_gateway_resource" "private_announcements" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.announcements.id
  path_part   = "private"
}

resource "aws_api_gateway_resource" "announcement_by_id" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.announcements.id
  path_part   = "{announcementId}"
}

resource "aws_api_gateway_method" "get_announcements" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.announcements.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "get_announcements" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.announcements.id
  http_method             = aws_api_gateway_method.get_announcements.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.get_announcements.invoke_arn
}

resource "aws_api_gateway_method" "create_announcement" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.announcements.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "create_announcement" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.announcements.id
  http_method             = aws_api_gateway_method.create_announcement.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.manage_announcements.invoke_arn
}

resource "aws_api_gateway_method" "get_private_announcements" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.private_announcements.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "get_private_announcements" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.private_announcements.id
  http_method             = aws_api_gateway_method.get_private_announcements.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.get_announcements.invoke_arn
}

resource "aws_api_gateway_method" "update_announcement" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.announcement_by_id.id
  http_method   = "PATCH"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "update_announcement" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.announcement_by_id.id
  http_method             = aws_api_gateway_method.update_announcement.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.manage_announcements.invoke_arn
}

resource "aws_api_gateway_method" "delete_announcement" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.announcement_by_id.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "delete_announcement" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.announcement_by_id.id
  http_method             = aws_api_gateway_method.delete_announcement.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.manage_announcements.invoke_arn
}

resource "aws_api_gateway_method" "announcements_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.announcements.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "announcements_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.announcements.id
  http_method = aws_api_gateway_method.announcements_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "announcements_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.announcements.id
  http_method = aws_api_gateway_method.announcements_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "announcements_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.announcements.id
  http_method = aws_api_gateway_method.announcements_options.http_method
  status_code = aws_api_gateway_method_response.announcements_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,GET,POST'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.announcements_options]
}

resource "aws_api_gateway_method" "private_announcements_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.private_announcements.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "private_announcements_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.private_announcements.id
  http_method = aws_api_gateway_method.private_announcements_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "private_announcements_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.private_announcements.id
  http_method = aws_api_gateway_method.private_announcements_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "private_announcements_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.private_announcements.id
  http_method = aws_api_gateway_method.private_announcements_options.http_method
  status_code = aws_api_gateway_method_response.private_announcements_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,GET'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.private_announcements_options]
}

resource "aws_api_gateway_method" "announcement_by_id_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.announcement_by_id.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "announcement_by_id_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.announcement_by_id.id
  http_method = aws_api_gateway_method.announcement_by_id_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "announcement_by_id_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.announcement_by_id.id
  http_method = aws_api_gateway_method.announcement_by_id_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "announcement_by_id_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.announcement_by_id.id
  http_method = aws_api_gateway_method.announcement_by_id_options.http_method
  status_code = aws_api_gateway_method_response.announcement_by_id_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,PATCH,DELETE'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.announcement_by_id_options]
}

resource "aws_lambda_permission" "allow_get_announcements_from_api_gateway" {
  statement_id  = "AllowGetAnnouncementsFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_announcements.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.get_announcements.http_method}${aws_api_gateway_resource.announcements.path}"
}

resource "aws_lambda_permission" "allow_get_private_announcements_from_api_gateway" {
  statement_id  = "AllowGetPrivateAnnouncementsFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_announcements.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.get_private_announcements.http_method}${aws_api_gateway_resource.private_announcements.path}"
}

resource "aws_lambda_permission" "allow_create_announcement_from_api_gateway" {
  statement_id  = "AllowCreateAnnouncementFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.manage_announcements.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.create_announcement.http_method}${aws_api_gateway_resource.announcements.path}"
}

resource "aws_lambda_permission" "allow_update_announcement_from_api_gateway" {
  statement_id  = "AllowUpdateAnnouncementFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.manage_announcements.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.update_announcement.http_method}${replace(aws_api_gateway_resource.announcement_by_id.path, "{announcementId}", "*")}"
}

resource "aws_lambda_permission" "allow_delete_announcement_from_api_gateway" {
  statement_id  = "AllowDeleteAnnouncementFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.manage_announcements.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.delete_announcement.http_method}${replace(aws_api_gateway_resource.announcement_by_id.path, "{announcementId}", "*")}"
}
