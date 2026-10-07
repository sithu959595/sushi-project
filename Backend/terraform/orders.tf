locals {
  orders_table_name_base              = var.orders_table_name != "" ? var.orders_table_name : "orders-table"
  orders_table_name                   = "${local.orders_table_name_base}-${local.stage}"
  orders_list_index_name              = "entityType-createdAt-index"
  customer_orders_index_name          = "customerOrderKey-createdAt-index"
  customer_pickup_failures_table_name = "${local.resource_name_prefix}-customer-pickup-failures"
}

resource "aws_dynamodb_table" "orders" {
  name         = local.orders_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "orderId"

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "orderId"
    type = "S"
  }

  attribute {
    name = "entityType"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  attribute {
    name = "customerOrderKey"
    type = "S"
  }

  global_secondary_index {
    name            = local.orders_list_index_name
    hash_key        = "entityType"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = local.customer_orders_index_name
    hash_key        = "customerOrderKey"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = var.orders_point_in_time_recovery_enabled
  }

  server_side_encryption {
    enabled = true
  }
}

resource "aws_dynamodb_table" "customer_pickup_failures" {
  name         = local.customer_pickup_failures_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "customerId"
  range_key    = "recordKey"

  attribute {
    name = "customerId"
    type = "S"
  }

  attribute {
    name = "recordKey"
    type = "S"
  }

  point_in_time_recovery {
    enabled = var.orders_point_in_time_recovery_enabled
  }

  server_side_encryption {
    enabled = true
  }
}

resource "aws_sqs_queue" "order_notifications_dlq" {
  name                      = "${local.resource_name_prefix}-order-notifications-dlq"
  message_retention_seconds = var.order_dlq_message_retention_seconds
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "order_notifications" {
  name                       = "${local.resource_name_prefix}-order-notifications"
  message_retention_seconds  = var.order_queue_message_retention_seconds
  visibility_timeout_seconds = 180
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.order_notifications_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "order_notifications_dlq" {
  queue_url = aws_sqs_queue.order_notifications_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.order_notifications.arn]
  })
}

resource "aws_sqs_queue" "customer_status_notifications_dlq" {
  name                      = "${local.resource_name_prefix}-customer-status-notifications-dlq"
  message_retention_seconds = var.order_dlq_message_retention_seconds
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "customer_status_notifications" {
  name                       = "${local.resource_name_prefix}-customer-status-notifications"
  message_retention_seconds  = var.order_queue_message_retention_seconds
  visibility_timeout_seconds = 180
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.customer_status_notifications_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "customer_status_notifications_dlq" {
  queue_url = aws_sqs_queue.customer_status_notifications_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.customer_status_notifications.arn]
  })
}

resource "aws_pipes_pipe" "order_created" {
  name     = "${local.resource_name_prefix}-order-created"
  role_arn = aws_iam_role.order_created_pipe.arn
  source   = aws_dynamodb_table.orders.stream_arn
  target   = aws_sqs_queue.order_notifications.arn

  source_parameters {
    dynamodb_stream_parameters {
      batch_size                         = 10
      maximum_batching_window_in_seconds = 1
      maximum_record_age_in_seconds      = 82800
      maximum_retry_attempts             = -1
      on_partial_batch_item_failure      = "AUTOMATIC_BISECT"
      starting_position                  = "TRIM_HORIZON"
    }

    filter_criteria {
      filter {
        pattern = jsonencode({
          eventName = ["INSERT"]
          dynamodb = {
            NewImage = {
              entityType = {
                S = ["ORDER"]
              }
            }
          }
        })
      }
    }
  }

  target_parameters {
    input_template = "{\"eventType\":\"ORDER_CREATED\",\"version\":1,\"orderId\":\"<$.dynamodb.NewImage.orderId.S>\"}"
  }

  depends_on = [aws_iam_role_policy.order_created_pipe]
}

resource "aws_pipes_pipe" "order_status_changed" {
  name     = "${local.resource_name_prefix}-order-status-changed"
  role_arn = aws_iam_role.order_status_changed_pipe.arn
  source   = aws_dynamodb_table.orders.stream_arn
  target   = aws_sqs_queue.customer_status_notifications.arn

  source_parameters {
    dynamodb_stream_parameters {
      batch_size                         = 10
      maximum_batching_window_in_seconds = 1
      maximum_record_age_in_seconds      = 82800
      maximum_retry_attempts             = -1
      on_partial_batch_item_failure      = "AUTOMATIC_BISECT"
      starting_position                  = "TRIM_HORIZON"
    }

    filter_criteria {
      filter {
        pattern = jsonencode({
          eventName = ["MODIFY"]
          dynamodb = {
            OldImage = {
              entityType = {
                S = ["ORDER"]
              }
            }
            NewImage = {
              entityType = {
                S = ["ORDER"]
              }
              status = {
                S = [
                  "CONFIRMED",
                  "CANCELLED",
                  "REJECTED",
                  "FAILED_TO_PICKUP",
                ]
              }
            }
          }
        })
      }
    }
  }

  target_parameters {
    # Pipes requires literal angle brackets around input-transform paths.
    # Terraform's jsonencode escapes them as \u003c and \u003e, which prevents
    # EventBridge from substituting the DynamoDB values.
    input_template = <<-JSON
      {"eventType":"ORDER_STATUS_CHANGED","version":1,"eventId":"<$.eventID>","orderId":"<$.dynamodb.NewImage.orderId.S>","previousStatus":"<$.dynamodb.OldImage.status.S>","status":"<$.dynamodb.NewImage.status.S>","changedAt":"<$.dynamodb.NewImage.statusUpdatedAt.S>"}
    JSON
  }

  depends_on = [aws_iam_role_policy.order_status_changed_pipe]
}

resource "aws_cloudwatch_log_group" "create_order" {
  name              = "/aws/lambda/${local.resource_name_prefix}-create-order"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "ordering_status" {
  name              = "/aws/lambda/${local.resource_name_prefix}-ordering-status"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "notify_order" {
  name              = "/aws/lambda/${local.resource_name_prefix}-notify-order"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "notify_customer_status" {
  name              = "/aws/lambda/${local.resource_name_prefix}-notify-customer-status"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "list_orders" {
  name              = "/aws/lambda/${local.resource_name_prefix}-list-orders"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "list_my_orders" {
  name              = "/aws/lambda/${local.resource_name_prefix}-list-my-orders"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "update_order_status" {
  name              = "/aws/lambda/${local.resource_name_prefix}-update-order-status"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "get_customer_pickup_failures" {
  name              = "/aws/lambda/${local.resource_name_prefix}-get-customer-pickup-failures"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "create_order" {
  function_name    = "${local.resource_name_prefix}-create-order"
  role             = aws_iam_role.create_order_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/create-order.fn"
  memory_size      = 256
  timeout          = 15
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      CORS_ALLOWED_ORIGIN = var.cors_allowed_origin
      DISHES_TABLE        = aws_dynamodb_table.dishes.name
      ORDERS_TABLE        = aws_dynamodb_table.orders.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.create_order,
    aws_iam_role_policy.create_order_lambda,
  ]
}

resource "aws_lambda_function" "ordering_status" {
  function_name    = "${local.resource_name_prefix}-ordering-status"
  role             = aws_iam_role.ordering_status_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/ordering-status.fn"
  memory_size      = 256
  timeout          = 15
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      ADMIN_GROUP_NAME    = aws_cognito_user_group.admins.name
      CORS_ALLOWED_ORIGIN = var.cors_allowed_origin
      ORDERS_TABLE        = aws_dynamodb_table.orders.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.ordering_status,
    aws_iam_role_policy.ordering_status_lambda,
  ]
}

resource "aws_lambda_function" "notify_order" {
  function_name    = "${local.resource_name_prefix}-notify-order"
  role             = aws_iam_role.notify_order_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/notify-order.fn"
  memory_size      = 256
  timeout          = 30
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      ADMIN_ORDER_EMAIL = var.admin_order_email
      ORDERS_TABLE      = aws_dynamodb_table.orders.name
      SES_FROM_EMAIL    = var.ses_sender_email
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.notify_order,
    aws_iam_role_policy.notify_order_lambda,
  ]
}

resource "aws_lambda_function" "notify_customer_status" {
  function_name    = "${local.resource_name_prefix}-notify-customer-status"
  role             = aws_iam_role.notify_customer_status_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/notify-customer-status.fn"
  memory_size      = 256
  timeout          = 30
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      ORDERS_TABLE   = aws_dynamodb_table.orders.name
      SES_FROM_EMAIL = var.ses_sender_email
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.notify_customer_status,
    aws_iam_role_policy.notify_customer_status_lambda,
  ]
}

resource "aws_lambda_function" "list_orders" {
  function_name    = "${local.resource_name_prefix}-list-orders"
  role             = aws_iam_role.list_orders_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/list-orders.fn"
  memory_size      = 256
  timeout          = 15
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      ADMIN_GROUP_NAME    = aws_cognito_user_group.admins.name
      CORS_ALLOWED_ORIGIN = var.cors_allowed_origin
      ORDERS_LIST_INDEX   = local.orders_list_index_name
      ORDERS_TABLE        = aws_dynamodb_table.orders.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.list_orders,
    aws_iam_role_policy.list_orders_lambda,
  ]
}

resource "aws_lambda_function" "list_my_orders" {
  function_name    = "${local.resource_name_prefix}-list-my-orders"
  role             = aws_iam_role.list_my_orders_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/list-my-orders.fn"
  memory_size      = 256
  timeout          = 15
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      CORS_ALLOWED_ORIGIN   = var.cors_allowed_origin
      CUSTOMER_ORDERS_INDEX = local.customer_orders_index_name
      ORDERS_TABLE          = aws_dynamodb_table.orders.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.list_my_orders,
    aws_iam_role_policy.list_my_orders_lambda,
  ]
}

resource "aws_lambda_function" "update_order_status" {
  function_name    = "${local.resource_name_prefix}-update-order-status"
  role             = aws_iam_role.update_order_status_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/update-order-status.fn"
  memory_size      = 256
  timeout          = 15
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      ADMIN_GROUP_NAME               = aws_cognito_user_group.admins.name
      CORS_ALLOWED_ORIGIN            = var.cors_allowed_origin
      CUSTOMER_PICKUP_FAILURES_TABLE = aws_dynamodb_table.customer_pickup_failures.name
      ORDERS_TABLE                   = aws_dynamodb_table.orders.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.update_order_status,
    aws_iam_role_policy.update_order_status_lambda,
  ]
}

resource "aws_lambda_function" "get_customer_pickup_failures" {
  function_name    = "${local.resource_name_prefix}-get-customer-pickup-failures"
  role             = aws_iam_role.get_customer_pickup_failures_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "handler/get-customer-pickup-failures.fn"
  memory_size      = 256
  timeout          = 15
  filename         = data.archive_file.lambda_source.output_path
  source_code_hash = data.archive_file.lambda_source.output_base64sha256

  environment {
    variables = {
      ADMIN_GROUP_NAME               = aws_cognito_user_group.admins.name
      CORS_ALLOWED_ORIGIN            = var.cors_allowed_origin
      CUSTOMER_PICKUP_FAILURES_TABLE = aws_dynamodb_table.customer_pickup_failures.name
      ORDERS_TABLE                   = aws_dynamodb_table.orders.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.get_customer_pickup_failures,
    aws_iam_role_policy.get_customer_pickup_failures_lambda,
  ]
}

resource "aws_lambda_event_source_mapping" "order_notifications" {
  event_source_arn                   = aws_sqs_queue.order_notifications.arn
  function_name                      = aws_lambda_function.notify_order.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 1
  function_response_types            = ["ReportBatchItemFailures"]
  enabled                            = true

  depends_on = [aws_iam_role_policy.notify_order_lambda]
}

resource "aws_lambda_event_source_mapping" "customer_status_notifications" {
  event_source_arn                   = aws_sqs_queue.customer_status_notifications.arn
  function_name                      = aws_lambda_function.notify_customer_status.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 1
  function_response_types            = ["ReportBatchItemFailures"]
  enabled                            = true

  depends_on = [aws_iam_role_policy.notify_customer_status_lambda]
}

resource "aws_api_gateway_resource" "orders" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "orders"
}

resource "aws_api_gateway_resource" "ordering_status" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "ordering-status"
}

resource "aws_api_gateway_resource" "my_orders" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.orders.id
  path_part   = "mine"
}

resource "aws_api_gateway_resource" "order_by_id" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.orders.id
  path_part   = "{orderId}"
}

resource "aws_api_gateway_resource" "order_status" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.order_by_id.id
  path_part   = "status"
}

resource "aws_api_gateway_resource" "admin" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "admin"
}

resource "aws_api_gateway_resource" "admin_ordering_status" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.admin.id
  path_part   = "ordering-status"
}

resource "aws_api_gateway_resource" "admin_orders" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.admin.id
  path_part   = "orders"
}

resource "aws_api_gateway_resource" "admin_order_by_id" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.admin_orders.id
  path_part   = "{orderId}"
}

resource "aws_api_gateway_resource" "admin_order_customer" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.admin_order_by_id.id
  path_part   = "customer"
}

resource "aws_api_gateway_resource" "admin_order_customer_pickup_failures" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.admin_order_customer.id
  path_part   = "pickup-failures"
}

resource "aws_api_gateway_method" "get_ordering_status" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.ordering_status.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "get_ordering_status" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.ordering_status.id
  http_method             = aws_api_gateway_method.get_ordering_status.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.ordering_status.invoke_arn
}

resource "aws_api_gateway_method" "update_ordering_status" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.admin_ordering_status.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "update_ordering_status" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.admin_ordering_status.id
  http_method             = aws_api_gateway_method.update_ordering_status.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.ordering_status.invoke_arn
}

resource "aws_api_gateway_method" "create_order" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.orders.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "create_order" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.orders.id
  http_method             = aws_api_gateway_method.create_order.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.create_order.invoke_arn
}

resource "aws_api_gateway_method" "list_orders" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.orders.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "list_orders" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.orders.id
  http_method             = aws_api_gateway_method.list_orders.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.list_orders.invoke_arn
}

resource "aws_api_gateway_method" "list_my_orders" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.my_orders.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "list_my_orders" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.my_orders.id
  http_method             = aws_api_gateway_method.list_my_orders.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.list_my_orders.invoke_arn
}

resource "aws_api_gateway_method" "update_order_status" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.order_status.id
  http_method   = "PATCH"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "update_order_status" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.order_status.id
  http_method             = aws_api_gateway_method.update_order_status.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.update_order_status.invoke_arn
}

resource "aws_api_gateway_method" "get_customer_pickup_failures" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.admin_order_customer_pickup_failures.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "get_customer_pickup_failures" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.admin_order_customer_pickup_failures.id
  http_method             = aws_api_gateway_method.get_customer_pickup_failures.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.get_customer_pickup_failures.invoke_arn
}

resource "aws_api_gateway_method" "ordering_status_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.ordering_status.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "ordering_status_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.ordering_status.id
  http_method = aws_api_gateway_method.ordering_status_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "ordering_status_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.ordering_status.id
  http_method = aws_api_gateway_method.ordering_status_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "ordering_status_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.ordering_status.id
  http_method = aws_api_gateway_method.ordering_status_options.http_method
  status_code = aws_api_gateway_method_response.ordering_status_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,GET'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.ordering_status_options]
}

resource "aws_api_gateway_method" "admin_ordering_status_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.admin_ordering_status.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "admin_ordering_status_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.admin_ordering_status.id
  http_method = aws_api_gateway_method.admin_ordering_status_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "admin_ordering_status_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.admin_ordering_status.id
  http_method = aws_api_gateway_method.admin_ordering_status_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "admin_ordering_status_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.admin_ordering_status.id
  http_method = aws_api_gateway_method.admin_ordering_status_options.http_method
  status_code = aws_api_gateway_method_response.admin_ordering_status_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,PUT'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.admin_ordering_status_options]
}

resource "aws_api_gateway_method" "orders_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.orders.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "orders_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.orders.id
  http_method = aws_api_gateway_method.orders_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "orders_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.orders.id
  http_method = aws_api_gateway_method.orders_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "orders_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.orders.id
  http_method = aws_api_gateway_method.orders_options.http_method
  status_code = aws_api_gateway_method_response.orders_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,GET,POST'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.orders_options]
}

resource "aws_api_gateway_method" "my_orders_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.my_orders.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "my_orders_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.my_orders.id
  http_method = aws_api_gateway_method.my_orders_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "my_orders_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.my_orders.id
  http_method = aws_api_gateway_method.my_orders_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "my_orders_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.my_orders.id
  http_method = aws_api_gateway_method.my_orders_options.http_method
  status_code = aws_api_gateway_method_response.my_orders_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,GET'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.my_orders_options]
}

resource "aws_api_gateway_method" "order_status_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.order_status.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "order_status_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.order_status.id
  http_method = aws_api_gateway_method.order_status_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "order_status_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.order_status.id
  http_method = aws_api_gateway_method.order_status_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "order_status_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.order_status.id
  http_method = aws_api_gateway_method.order_status_options.http_method
  status_code = aws_api_gateway_method_response.order_status_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,PATCH'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.order_status_options]
}

resource "aws_api_gateway_method" "customer_pickup_failures_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.admin_order_customer_pickup_failures.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "customer_pickup_failures_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.admin_order_customer_pickup_failures.id
  http_method = aws_api_gateway_method.customer_pickup_failures_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "customer_pickup_failures_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.admin_order_customer_pickup_failures.id
  http_method = aws_api_gateway_method.customer_pickup_failures_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "customer_pickup_failures_options_200" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.admin_order_customer_pickup_failures.id
  http_method = aws_api_gateway_method.customer_pickup_failures_options.http_method
  status_code = aws_api_gateway_method_response.customer_pickup_failures_options_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,GET'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.cors_allowed_origin}'"
  }

  depends_on = [aws_api_gateway_integration.customer_pickup_failures_options]
}

resource "aws_lambda_permission" "allow_get_ordering_status_from_api_gateway" {
  statement_id  = "AllowGetOrderingStatusFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ordering_status.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.get_ordering_status.http_method}${aws_api_gateway_resource.ordering_status.path}"
}

resource "aws_lambda_permission" "allow_update_ordering_status_from_api_gateway" {
  statement_id  = "AllowUpdateOrderingStatusFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ordering_status.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.update_ordering_status.http_method}${aws_api_gateway_resource.admin_ordering_status.path}"
}

resource "aws_lambda_permission" "allow_create_order_from_api_gateway" {
  statement_id  = "AllowCreateOrderFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.create_order.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.create_order.http_method}${aws_api_gateway_resource.orders.path}"
}

resource "aws_lambda_permission" "allow_list_orders_from_api_gateway" {
  statement_id  = "AllowListOrdersFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.list_orders.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.list_orders.http_method}${aws_api_gateway_resource.orders.path}"
}

resource "aws_lambda_permission" "allow_list_my_orders_from_api_gateway" {
  statement_id  = "AllowListMyOrdersFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.list_my_orders.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.list_my_orders.http_method}${aws_api_gateway_resource.my_orders.path}"
}

resource "aws_lambda_permission" "allow_update_order_status_from_api_gateway" {
  statement_id  = "AllowUpdateOrderStatusFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.update_order_status.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.update_order_status.http_method}${replace(aws_api_gateway_resource.order_status.path, "{orderId}", "*")}"
}

resource "aws_lambda_permission" "allow_get_customer_pickup_failures_from_api_gateway" {
  statement_id  = "AllowGetCustomerPickupFailuresFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_customer_pickup_failures.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.get_customer_pickup_failures.http_method}${replace(aws_api_gateway_resource.admin_order_customer_pickup_failures.path, "{orderId}", "*")}"
}
