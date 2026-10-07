locals {
  rag_lambda_zip_path = "${path.module}/build/rag-lambda-source.zip"
  rag_collection_name = "${var.rag_collection_name_prefix}_${replace(local.stage, "-", "_")}"
  rag_credentials_secret_arn = (
    trimspace(var.rag_credentials_secret_arn) != ""
    ? trimspace(var.rag_credentials_secret_arn)
    : one(aws_secretsmanager_secret.rag_credentials[*].arn)
  )
}

data "archive_file" "rag_lambda_source" {
  type        = "zip"
  source_dir  = "${path.module}/lambda-rag"
  output_path = local.rag_lambda_zip_path
  excludes = [
    "__pycache__",
    "rag_app/__pycache__",
    "tests",
  ]
}

# Terraform creates only the secret container when an existing ARN is not
# supplied. API-key values are entered out-of-band and never enter state.
resource "aws_secretsmanager_secret" "rag_credentials" {
  count = trimspace(var.rag_credentials_secret_arn) == "" ? 1 : 0

  name                    = "${local.resource_name_prefix}/rag-credentials"
  description             = "OpenAI, Weaviate, and Cohere credentials for the menu RAG Lambdas."
  kms_key_id              = trimspace(var.rag_credentials_kms_key_arn) != "" ? trimspace(var.rag_credentials_kms_key_arn) : null
  recovery_window_in_days = 7
}

resource "aws_dynamodb_table" "chat_history" {
  name         = "${local.resource_name_prefix}-chat-history"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.rag_chat_point_in_time_recovery_enabled
  }

  server_side_encryption {
    enabled = true
  }
}

resource "aws_sqs_queue" "dish_index_updates_dlq" {
  name                      = "${local.resource_name_prefix}-dish-index-updates-dlq.fifo"
  fifo_queue                = true
  message_retention_seconds = var.rag_dlq_message_retention_seconds
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "dish_index_updates" {
  name                       = "${local.resource_name_prefix}-dish-index-updates.fifo"
  fifo_queue                 = true
  message_retention_seconds  = var.rag_queue_message_retention_seconds
  visibility_timeout_seconds = (var.rag_indexer_timeout_seconds * 6) + 10
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dish_index_updates_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dish_index_updates_dlq" {
  queue_url = aws_sqs_queue.dish_index_updates_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.dish_index_updates.arn]
  })
}

resource "aws_cloudwatch_log_group" "rag_indexer" {
  name              = "/aws/lambda/${local.resource_name_prefix}-rag-indexer"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "rag_chat" {
  name              = "/aws/lambda/${local.resource_name_prefix}-rag-chat"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "rag_indexer_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.rag_indexer.arn}:*"]
  }

  statement {
    sid = "ConsumeDishIndexUpdates"

    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]

    resources = [aws_sqs_queue.dish_index_updates.arn]
  }

  statement {
    sid = "ReadAuthoritativeMenu"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:Scan",
    ]

    resources = [aws_dynamodb_table.dishes.arn]
  }

  statement {
    sid       = "ReadRagCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.rag_credentials_secret_arn]
  }

  dynamic "statement" {
    for_each = trimspace(var.rag_credentials_kms_key_arn) == "" ? [] : [trimspace(var.rag_credentials_kms_key_arn)]

    content {
      sid       = "DecryptRagCredentials"
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role" "rag_indexer_lambda" {
  name               = "${local.resource_name_prefix}-rag-indexer-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "rag_indexer_lambda" {
  name   = "RagIndexerPolicy"
  role   = aws_iam_role.rag_indexer_lambda.id
  policy = data.aws_iam_policy_document.rag_indexer_lambda.json
}

data "aws_iam_policy_document" "rag_chat_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.rag_chat.arn}:*"]
  }

  statement {
    sid = "ReadAuthoritativeMenu"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:Scan",
    ]

    resources = [aws_dynamodb_table.dishes.arn]
  }

  statement {
    sid = "OwnChatSessionsAndHistory"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
      "dynamodb:UpdateItem",
    ]

    resources = [aws_dynamodb_table.chat_history.arn]
  }

  statement {
    sid       = "ReadRagCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.rag_credentials_secret_arn]
  }

  dynamic "statement" {
    for_each = trimspace(var.rag_credentials_kms_key_arn) == "" ? [] : [trimspace(var.rag_credentials_kms_key_arn)]

    content {
      sid       = "DecryptRagCredentials"
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role" "rag_chat_lambda" {
  name               = "${local.resource_name_prefix}-rag-chat-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "rag_chat_lambda" {
  name   = "RagChatPolicy"
  role   = aws_iam_role.rag_chat_lambda.id
  policy = data.aws_iam_policy_document.rag_chat_lambda.json
}

resource "aws_lambda_function" "rag_indexer" {
  function_name    = "${local.resource_name_prefix}-rag-indexer"
  role             = aws_iam_role.rag_indexer_lambda.arn
  runtime          = "python3.13"
  handler          = "index_handler.lambda_handler"
  architectures    = ["x86_64"]
  memory_size      = 512
  timeout          = var.rag_indexer_timeout_seconds
  filename         = data.archive_file.rag_lambda_source.output_path
  source_code_hash = data.archive_file.rag_lambda_source.output_base64sha256

  environment {
    variables = {
      CHAT_HISTORY_TABLE         = aws_dynamodb_table.chat_history.name
      DISHES_TABLE               = aws_dynamodb_table.dishes.name
      OPENAI_CHAT_MODEL          = var.rag_openai_chat_model
      RAG_CANDIDATE_LIMIT        = tostring(var.rag_candidate_limit)
      RAG_CONTEXT_DISH_LIMIT     = tostring(var.rag_context_dish_limit)
      RAG_CREDENTIALS_SECRET_ARN = local.rag_credentials_secret_arn
      RAG_HTTP_TIMEOUT_SECONDS   = tostring(var.rag_indexer_http_timeout_seconds)
      STAGE                      = local.stage
      WEAVIATE_COLLECTION        = local.rag_collection_name
      WEAVIATE_URL               = var.rag_weaviate_url
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.rag_indexer,
    aws_iam_role_policy.rag_indexer_lambda,
  ]
}

resource "aws_lambda_function" "rag_chat" {
  function_name    = "${local.resource_name_prefix}-rag-chat"
  role             = aws_iam_role.rag_chat_lambda.arn
  runtime          = "python3.13"
  handler          = "chat_handler.lambda_handler"
  architectures    = ["x86_64"]
  memory_size      = 512
  timeout          = 28
  filename         = data.archive_file.rag_lambda_source.output_path
  source_code_hash = data.archive_file.rag_lambda_source.output_base64sha256

  environment {
    variables = {
      CHAT_HISTORY_LIMIT            = tostring(var.rag_chat_history_message_limit)
      CHAT_HISTORY_TABLE            = aws_dynamodb_table.chat_history.name
      CHAT_RETENTION_DAYS           = tostring(var.rag_chat_retention_days)
      CORS_ALLOWED_ORIGIN           = var.cors_allowed_origin
      DISHES_TABLE                  = aws_dynamodb_table.dishes.name
      OPENAI_CHAT_MODEL             = var.rag_openai_chat_model
      RAG_CANDIDATE_LIMIT           = tostring(var.rag_candidate_limit)
      RAG_CONTEXT_DISH_LIMIT        = tostring(var.rag_context_dish_limit)
      RAG_CREDENTIALS_SECRET_ARN    = local.rag_credentials_secret_arn
      RAG_HTTP_TIMEOUT_SECONDS      = tostring(var.rag_chat_http_timeout_seconds)
      RAG_LOG_OPENAI_CONTEXT_DISHES = tostring(var.rag_log_openai_context_dishes)
      RAG_LOG_RETRIEVED_CANDIDATES  = tostring(var.rag_log_retrieved_candidates)
      RAG_LOG_SELECTED_CHUNKS       = tostring(var.rag_log_selected_chunks)
      RAG_LOG_USER_QUESTIONS        = tostring(var.rag_log_user_questions)
      RAG_MIN_RERANK_SCORE          = tostring(var.rag_min_rerank_score)
      STAGE                         = local.stage
      WEAVIATE_COLLECTION           = local.rag_collection_name
      WEAVIATE_URL                  = var.rag_weaviate_url
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.rag_chat,
    aws_iam_role_policy.rag_chat_lambda,
  ]

  lifecycle {
    precondition {
      condition = local.stage != "prod" || (
        !var.rag_log_selected_chunks &&
        !var.rag_log_retrieved_candidates &&
        !var.rag_log_openai_context_dishes &&
        !var.rag_log_user_questions
      )
      error_message = "RAG context diagnostics must remain false in production."
    }
  }
}

resource "aws_lambda_event_source_mapping" "dish_index_updates" {
  event_source_arn        = aws_sqs_queue.dish_index_updates.arn
  function_name           = aws_lambda_function.rag_indexer.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  enabled                 = true

  scaling_config {
    maximum_concurrency = 2
  }

  depends_on = [aws_iam_role_policy.rag_indexer_lambda]
}

resource "aws_api_gateway_resource" "chat" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "chat"
}

resource "aws_api_gateway_resource" "chat_sessions" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.chat.id
  path_part   = "sessions"
}

resource "aws_api_gateway_resource" "chat_session_by_id" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.chat_sessions.id
  path_part   = "{chatId}"
}

resource "aws_api_gateway_resource" "chat_session_messages" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.chat_session_by_id.id
  path_part   = "messages"
}

resource "aws_api_gateway_method" "create_chat_session" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.chat_sessions.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "create_chat_session" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.chat_sessions.id
  http_method             = aws_api_gateway_method.create_chat_session.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.rag_chat.invoke_arn
}

resource "aws_api_gateway_method" "get_chat_session" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.chat_session_by_id.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "get_chat_session" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.chat_session_by_id.id
  http_method             = aws_api_gateway_method.get_chat_session.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.rag_chat.invoke_arn
}

resource "aws_api_gateway_method" "send_chat_message" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.chat_session_messages.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "send_chat_message" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.chat_session_messages.id
  http_method             = aws_api_gateway_method.send_chat_message.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.rag_chat.invoke_arn
}

resource "aws_api_gateway_method" "chat_sessions_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.chat_sessions.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "chat_sessions_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.chat_sessions.id
  http_method = aws_api_gateway_method.chat_sessions_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "chat_sessions_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.chat_sessions.id
  http_method = aws_api_gateway_method.chat_sessions_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "chat_sessions_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.chat_sessions.id
  http_method = aws_api_gateway_method.chat_sessions_options.http_method
  status_code = aws_api_gateway_method_response.chat_sessions_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,POST'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.chat_sessions_options]
}

resource "aws_api_gateway_method" "chat_session_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.chat_session_by_id.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "chat_session_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.chat_session_by_id.id
  http_method = aws_api_gateway_method.chat_session_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "chat_session_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.chat_session_by_id.id
  http_method = aws_api_gateway_method.chat_session_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "chat_session_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.chat_session_by_id.id
  http_method = aws_api_gateway_method.chat_session_options.http_method
  status_code = aws_api_gateway_method_response.chat_session_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,GET'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.chat_session_options]
}

resource "aws_api_gateway_method" "chat_messages_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.chat_session_messages.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "chat_messages_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.chat_session_messages.id
  http_method = aws_api_gateway_method.chat_messages_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "chat_messages_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.chat_session_messages.id
  http_method = aws_api_gateway_method.chat_messages_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "chat_messages_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.chat_session_messages.id
  http_method = aws_api_gateway_method.chat_messages_options.http_method
  status_code = aws_api_gateway_method_response.chat_messages_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,POST'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.chat_messages_options]
}

resource "aws_lambda_permission" "allow_rag_chat_from_api_gateway" {
  statement_id  = "AllowRagChatFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.rag_chat.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/*${aws_api_gateway_resource.chat.path}/*"
}

resource "aws_api_gateway_method_settings" "send_chat_message" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  stage_name  = aws_api_gateway_stage.stage.stage_name
  method_path = "${trimprefix(aws_api_gateway_resource.chat_session_messages.path, "/")}/${aws_api_gateway_method.send_chat_message.http_method}"

  settings {
    metrics_enabled        = true
    throttling_burst_limit = var.rag_chat_message_throttling_burst_limit
    throttling_rate_limit  = var.rag_chat_message_throttling_rate_limit
  }
}
