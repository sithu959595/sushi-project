data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "create_dish_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.create_dish.arn}:*"]
  }

  statement {
    sid       = "CreateDish"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.dishes.arn]
  }
}

resource "aws_iam_role" "create_dish_lambda" {
  name               = "${local.resource_name_prefix}-create-dish-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "create_dish_lambda" {
  name   = "CreateDishPolicy"
  role   = aws_iam_role.create_dish_lambda.id
  policy = data.aws_iam_policy_document.create_dish_lambda.json
}

data "aws_iam_policy_document" "get_dishes_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.get_dishes.arn}:*"]
  }

  statement {
    sid       = "ReadDishes"
    actions   = ["dynamodb:GetItem", "dynamodb:Scan"]
    resources = [aws_dynamodb_table.dishes.arn]
  }
}

resource "aws_iam_role" "get_dishes_lambda" {
  name               = "${local.resource_name_prefix}-get-dishes-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "get_dishes_lambda" {
  name   = "GetDishesPolicy"
  role   = aws_iam_role.get_dishes_lambda.id
  policy = data.aws_iam_policy_document.get_dishes_lambda.json
}

data "aws_iam_policy_document" "replace_dishes_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.replace_dishes.arn}:*"]
  }

  statement {
    sid       = "ReplaceMenu"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.dishes.arn]
  }
}

resource "aws_iam_role" "replace_dishes_lambda" {
  name               = "${local.resource_name_prefix}-replace-dishes-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "replace_dishes_lambda" {
  name   = "ReplaceDishesPolicy"
  role   = aws_iam_role.replace_dishes_lambda.id
  policy = data.aws_iam_policy_document.replace_dishes_lambda.json
}

data "aws_iam_policy_document" "create_image_upload_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.create_image_upload.arn}:*"]
  }

  statement {
    sid       = "UploadDishImages"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.dish_images.arn}/dishes/*"]
  }
}

resource "aws_iam_role" "create_image_upload_lambda" {
  name               = "${local.resource_name_prefix}-create-image-upload-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "create_image_upload_lambda" {
  name   = "CreateImageUploadPolicy"
  role   = aws_iam_role.create_image_upload_lambda.id
  policy = data.aws_iam_policy_document.create_image_upload_lambda.json
}

data "aws_iam_policy_document" "dish_stream_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.dish_stream.arn}:*"]
  }

  statement {
    sid = "ReadDishStream"

    actions = [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
    ]

    resources = [aws_dynamodb_table.dishes.stream_arn]
  }

  statement {
    sid       = "ListDynamoDBStreams"
    actions   = ["dynamodb:ListStreams"]
    resources = ["*"]
  }

  statement {
    sid       = "RemoveReplacedDishImages"
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.dish_images.arn}/dishes/*"]
  }

  statement {
    sid       = "EnqueueDishIndexRefresh"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dish_index_updates.arn]
  }
}

resource "aws_iam_role" "dish_stream_lambda" {
  name               = "${local.resource_name_prefix}-dish-stream-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "dish_stream_lambda" {
  name   = "DishStreamReadOnlyPolicy"
  role   = aws_iam_role.dish_stream_lambda.id
  policy = data.aws_iam_policy_document.dish_stream_lambda.json
}

data "aws_iam_policy_document" "create_order_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.create_order.arn}:*"]
  }

  statement {
    sid = "ReadPublishedMenu"

    actions = ["dynamodb:GetItem"]

    resources = [aws_dynamodb_table.dishes.arn]
  }

  statement {
    sid = "CreateOrderAndIdempotencyMarker"

    actions = [
      "dynamodb:ConditionCheckItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
    ]

    resources = [aws_dynamodb_table.orders.arn]
  }
}

resource "aws_iam_role" "create_order_lambda" {
  name               = "${local.resource_name_prefix}-create-order-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "create_order_lambda" {
  name   = "CreateOrderPolicy"
  role   = aws_iam_role.create_order_lambda.id
  policy = data.aws_iam_policy_document.create_order_lambda.json
}

data "aws_iam_policy_document" "ordering_status_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.ordering_status.arn}:*"]
  }

  statement {
    sid = "ReadAndUpdateOrderingStatus"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
    ]

    resources = [aws_dynamodb_table.orders.arn]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["CONFIG#ORDERING"]
    }
  }
}

resource "aws_iam_role" "ordering_status_lambda" {
  name               = "${local.resource_name_prefix}-ordering-status-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "ordering_status_lambda" {
  name   = "OrderingStatusPolicy"
  role   = aws_iam_role.ordering_status_lambda.id
  policy = data.aws_iam_policy_document.ordering_status_lambda.json
}

data "aws_iam_policy_document" "list_orders_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.list_orders.arn}:*"]
  }

  statement {
    sid       = "QueryOrdersByCreationTime"
    actions   = ["dynamodb:Query"]
    resources = ["${aws_dynamodb_table.orders.arn}/index/${local.orders_list_index_name}"]
  }
}

resource "aws_iam_role" "list_orders_lambda" {
  name               = "${local.resource_name_prefix}-list-orders-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "list_orders_lambda" {
  name   = "ListOrdersPolicy"
  role   = aws_iam_role.list_orders_lambda.id
  policy = data.aws_iam_policy_document.list_orders_lambda.json
}

data "aws_iam_policy_document" "list_my_orders_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.list_my_orders.arn}:*"]
  }

  statement {
    sid       = "QueryAuthenticatedCustomerOrders"
    actions   = ["dynamodb:Query"]
    resources = ["${aws_dynamodb_table.orders.arn}/index/${local.customer_orders_index_name}"]
  }
}

resource "aws_iam_role" "list_my_orders_lambda" {
  name               = "${local.resource_name_prefix}-list-my-orders-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "list_my_orders_lambda" {
  name   = "ListMyOrdersPolicy"
  role   = aws_iam_role.list_my_orders_lambda.id
  policy = data.aws_iam_policy_document.list_my_orders_lambda.json
}

data "aws_iam_policy_document" "update_order_status_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.update_order_status.arn}:*"]
  }

  statement {
    sid = "ReadAndUpdateOrderStatus"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
    ]

    resources = [aws_dynamodb_table.orders.arn]
  }

  statement {
    sid = "RecordCustomerPickupFailure"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]

    resources = [aws_dynamodb_table.customer_pickup_failures.arn]
  }
}

resource "aws_iam_role" "update_order_status_lambda" {
  name               = "${local.resource_name_prefix}-update-order-status-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "update_order_status_lambda" {
  name   = "UpdateOrderStatusPolicy"
  role   = aws_iam_role.update_order_status_lambda.id
  policy = data.aws_iam_policy_document.update_order_status_lambda.json
}

data "aws_iam_policy_document" "get_customer_pickup_failures_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.get_customer_pickup_failures.arn}:*"]
  }

  statement {
    sid       = "ReadCustomerOrder"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.orders.arn]
  }

  statement {
    sid = "ReadCustomerPickupFailures"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
    ]

    resources = [aws_dynamodb_table.customer_pickup_failures.arn]
  }
}

resource "aws_iam_role" "get_customer_pickup_failures_lambda" {
  name               = "${local.resource_name_prefix}-get-customer-pickup-failures-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "get_customer_pickup_failures_lambda" {
  name   = "GetCustomerPickupFailuresPolicy"
  role   = aws_iam_role.get_customer_pickup_failures_lambda.id
  policy = data.aws_iam_policy_document.get_customer_pickup_failures_lambda.json
}

data "aws_iam_policy_document" "order_created_pipe_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["pipes.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "order_created_pipe" {
  statement {
    sid = "ReadOrdersStream"

    actions = [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
    ]

    resources = [aws_dynamodb_table.orders.stream_arn]
  }

  statement {
    sid       = "ListDynamoDBStreams"
    actions   = ["dynamodb:ListStreams"]
    resources = ["*"]
  }

  statement {
    sid       = "SendOrderNotificationJob"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.order_notifications.arn]
  }
}

resource "aws_iam_role" "order_created_pipe" {
  name               = "${local.resource_name_prefix}-order-created-pipe-role"
  assume_role_policy = data.aws_iam_policy_document.order_created_pipe_assume_role.json
}

resource "aws_iam_role_policy" "order_created_pipe" {
  name   = "OrderCreatedPipePolicy"
  role   = aws_iam_role.order_created_pipe.id
  policy = data.aws_iam_policy_document.order_created_pipe.json
}

data "aws_iam_policy_document" "order_status_changed_pipe" {
  statement {
    sid = "ReadOrdersStream"

    actions = [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
    ]

    resources = [aws_dynamodb_table.orders.stream_arn]
  }

  statement {
    sid       = "ListDynamoDBStreams"
    actions   = ["dynamodb:ListStreams"]
    resources = ["*"]
  }

  statement {
    sid       = "SendCustomerStatusNotificationJob"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.customer_status_notifications.arn]
  }
}

resource "aws_iam_role" "order_status_changed_pipe" {
  name               = "${local.resource_name_prefix}-order-status-changed-pipe-role"
  assume_role_policy = data.aws_iam_policy_document.order_created_pipe_assume_role.json
}

resource "aws_iam_role_policy" "order_status_changed_pipe" {
  name   = "OrderStatusChangedPipePolicy"
  role   = aws_iam_role.order_status_changed_pipe.id
  policy = data.aws_iam_policy_document.order_status_changed_pipe.json
}

data "aws_iam_policy_document" "notify_order_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.notify_order.arn}:*"]
  }

  statement {
    sid = "ConsumeOrderNotificationJobs"

    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]

    resources = [aws_sqs_queue.order_notifications.arn]
  }

  statement {
    sid = "ReadAndMarkOrderNotification"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
    ]

    resources = [aws_dynamodb_table.orders.arn]
  }

  statement {
    sid       = "EmailRestaurantAdministrator"
    actions   = ["ses:SendEmail"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.ses_sender_email]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "ses:Recipients"
      values   = [var.admin_order_email]
    }
  }
}

resource "aws_iam_role" "notify_order_lambda" {
  name               = "${local.resource_name_prefix}-notify-order-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "notify_order_lambda" {
  name   = "NotifyOrderPolicy"
  role   = aws_iam_role.notify_order_lambda.id
  policy = data.aws_iam_policy_document.notify_order_lambda.json
}

data "aws_iam_policy_document" "notify_customer_status_lambda" {
  statement {
    sid = "WriteLambdaLogs"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.notify_customer_status.arn}:*"]
  }

  statement {
    sid = "ConsumeCustomerStatusNotificationJobs"

    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]

    resources = [aws_sqs_queue.customer_status_notifications.arn]
  }

  statement {
    sid       = "ReadCustomerOrder"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.orders.arn]
  }

  statement {
    sid       = "EmailOrderCustomer"
    actions   = ["ses:SendEmail"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.ses_sender_email]
    }
  }
}

resource "aws_iam_role" "notify_customer_status_lambda" {
  name               = "${local.resource_name_prefix}-notify-customer-status-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "notify_customer_status_lambda" {
  name   = "NotifyCustomerStatusPolicy"
  role   = aws_iam_role.notify_customer_status_lambda.id
  policy = data.aws_iam_policy_document.notify_customer_status_lambda.json
}
