output "deployment_stage" {
  description = "Stage selected by the current Terraform workspace."
  value       = local.stage
}

output "terraform_workspace" {
  description = "Terraform workspace that owns this deployment's state."
  value       = terraform.workspace
}

output "resource_name_prefix" {
  description = "Stage-qualified prefix used by globally named AWS resources."
  value       = local.resource_name_prefix
}

output "api_base_url" {
  description = "Base URL for the API Gateway stage."
  value       = aws_api_gateway_stage.stage.invoke_url
}

output "create_dish_url" {
  description = "URL for POST requests that create dishes."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/dishes"
}

output "get_dishes_url" {
  description = "Public URL for GET requests that return all dishes."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/dishes"
}

output "get_private_dishes_url" {
  description = "Admin URL for GET requests that return full dish metadata."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/dishes/private"
}

output "replace_dishes_url" {
  description = "Admin URL for PUT requests that replace the complete menu."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/dishes"
}

output "dish_image_upload_url" {
  description = "Admin URL for requesting a short-lived dish-image upload URL."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/dish-images/upload-url"
}

output "create_order_url" {
  description = "Authenticated customer URL for creating pickup orders."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/orders"
}

output "list_orders_url" {
  description = "Admin-only URL for listing pickup orders newest first."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/orders"
}

output "list_my_orders_url" {
  description = "Authenticated customer URL for listing that customer's pickup orders newest first."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/orders/mine"
}

output "update_order_status_url" {
  description = "Admin-only URL template for updating an order's restaurant status; replace {orderId} with the order ID."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/orders/{orderId}/status"
}

output "get_customer_pickup_failures_url" {
  description = "Admin-only URL template for reading a customer's pickup-failure summary and history through an order; replace {orderId} with the order ID."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/admin/orders/{orderId}/customer/pickup-failures"
}

output "public_announcements_url" {
  description = "Public URL for reading currently active announcements."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/announcements"
}

output "admin_announcements_url" {
  description = "Admin-only URL for listing announcements, including drafts and scheduled announcements."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/announcements/private"
}

output "admin_announcement_url" {
  description = "Admin-only URL template for updating or deleting one announcement; replace {announcementId} with the announcement ID. POST requests create announcements at the public_announcements_url path."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/announcements/{announcementId}"
}

output "dish_images_bucket_name" {
  description = "S3 bucket that stores dish images."
  value       = aws_s3_bucket.dish_images.id
}

output "dish_images_base_url" {
  description = "Base URL used by the frontend to render published dish images before CloudFront is added."
  value       = "https://${aws_s3_bucket.dish_images.bucket_regional_domain_name}"
}

output "frontend_bucket_name" {
  description = "Private S3 bucket containing the React production build, or null when frontend hosting is not configured for this workspace."
  value       = try(aws_s3_bucket.frontend["current"].id, null)
}

output "frontend_cloudfront_distribution_id" {
  description = "CloudFront distribution ID for the React application, or null when frontend hosting is not configured for this workspace."
  value       = try(aws_cloudfront_distribution.frontend["current"].id, null)
}

output "frontend_cloudfront_domain_name" {
  description = "AWS-generated CloudFront hostname for the React application, or null when frontend hosting is not configured for this workspace."
  value       = try(aws_cloudfront_distribution.frontend["current"].domain_name, null)
}

output "frontend_url" {
  description = "Canonical custom-domain URL for the React application, or null when frontend hosting is not configured for this workspace."
  value       = try("https://${local.frontend_sites["current"].domain_name}", null)
}

output "dynamodb_table_name" {
  description = "DynamoDB table used to store dishes."
  value       = aws_dynamodb_table.dishes.name
}

output "orders_table_name" {
  description = "DynamoDB table used to store orders and idempotency markers."
  value       = aws_dynamodb_table.orders.name
}

output "customer_pickup_failures_table_name" {
  description = "DynamoDB table used to store customer pickup-failure summaries and history."
  value       = aws_dynamodb_table.customer_pickup_failures.name
}

output "restaurant_content_table_name" {
  description = "DynamoDB table used to store restaurant announcements and other restaurant content."
  value       = aws_dynamodb_table.restaurant_content.name
}

output "orders_list_index_name" {
  description = "Orders-table GSI used to list real orders by creation time."
  value       = local.orders_list_index_name
}

output "customer_orders_index_name" {
  description = "Orders-table GSI used to list one authenticated customer's orders by creation time."
  value       = local.customer_orders_index_name
}

output "order_notifications_queue_url" {
  description = "SQS queue consumed by the order-notification Lambda."
  value       = aws_sqs_queue.order_notifications.url
}

output "order_notifications_dlq_url" {
  description = "Dead-letter queue containing order notifications that exhausted their retries."
  value       = aws_sqs_queue.order_notifications_dlq.url
}

output "customer_status_notifications_queue_url" {
  description = "SQS queue consumed by the customer status-notification Lambda."
  value       = aws_sqs_queue.customer_status_notifications.url
}

output "customer_status_notifications_dlq_url" {
  description = "Dead-letter queue containing customer status notifications that exhausted their retries."
  value       = aws_sqs_queue.customer_status_notifications_dlq.url
}

output "order_created_pipe_name" {
  description = "EventBridge Pipe that sends newly inserted orders from DynamoDB Streams to SQS."
  value       = aws_pipes_pipe.order_created.name
}

output "order_status_changed_pipe_name" {
  description = "EventBridge Pipe that sends customer-visible order status changes from DynamoDB Streams to SQS."
  value       = aws_pipes_pipe.order_status_changed.name
}

output "create_order_lambda_name" {
  description = "Lambda function that validates and stores customer orders."
  value       = aws_lambda_function.create_order.function_name
}

output "notify_order_lambda_name" {
  description = "Lambda function that emails the administrator for queued orders."
  value       = aws_lambda_function.notify_order.function_name
}

output "notify_customer_status_lambda_name" {
  description = "Lambda function that emails customers about queued order status changes."
  value       = aws_lambda_function.notify_customer_status.function_name
}

output "list_orders_lambda_name" {
  description = "Lambda function that lists orders for administrators."
  value       = aws_lambda_function.list_orders.function_name
}

output "list_my_orders_lambda_name" {
  description = "Lambda function that lists orders for the authenticated customer."
  value       = aws_lambda_function.list_my_orders.function_name
}

output "update_order_status_lambda_name" {
  description = "Lambda function that updates an order's restaurant status for administrators."
  value       = aws_lambda_function.update_order_status.function_name
}

output "get_customer_pickup_failures_lambda_name" {
  description = "Lambda function that returns a customer's pickup-failure summary and history to administrators."
  value       = aws_lambda_function.get_customer_pickup_failures.function_name
}

output "get_announcements_lambda_name" {
  description = "Lambda function that returns public or administrator announcement lists."
  value       = aws_lambda_function.get_announcements.function_name
}

output "manage_announcements_lambda_name" {
  description = "Lambda function that creates, updates, and deletes announcements for administrators."
  value       = aws_lambda_function.manage_announcements.function_name
}

output "create_order_log_group_name" {
  description = "CloudWatch log group for the create-order Lambda."
  value       = aws_cloudwatch_log_group.create_order.name
}

output "notify_order_log_group_name" {
  description = "CloudWatch log group for the notify-order Lambda."
  value       = aws_cloudwatch_log_group.notify_order.name
}

output "notify_customer_status_log_group_name" {
  description = "CloudWatch log group for the notify-customer-status Lambda."
  value       = aws_cloudwatch_log_group.notify_customer_status.name
}

output "list_orders_log_group_name" {
  description = "CloudWatch log group for the list-orders Lambda."
  value       = aws_cloudwatch_log_group.list_orders.name
}

output "list_my_orders_log_group_name" {
  description = "CloudWatch log group for the list-my-orders Lambda."
  value       = aws_cloudwatch_log_group.list_my_orders.name
}

output "update_order_status_log_group_name" {
  description = "CloudWatch log group for the update-order-status Lambda."
  value       = aws_cloudwatch_log_group.update_order_status.name
}

output "get_customer_pickup_failures_log_group_name" {
  description = "CloudWatch log group for the get-customer-pickup-failures Lambda."
  value       = aws_cloudwatch_log_group.get_customer_pickup_failures.name
}

output "get_announcements_log_group_name" {
  description = "CloudWatch log group for the get-announcements Lambda."
  value       = aws_cloudwatch_log_group.get_announcements.name
}

output "manage_announcements_log_group_name" {
  description = "CloudWatch log group for the manage-announcements Lambda."
  value       = aws_cloudwatch_log_group.manage_announcements.name
}

output "dynamodb_stream_arn" {
  description = "ARN of the DynamoDB stream that captures old and new dish images."
  value       = aws_dynamodb_table.dishes.stream_arn
}

output "dish_stream_lambda_name" {
  description = "Lambda function that logs DynamoDB stream changes."
  value       = aws_lambda_function.dish_stream.function_name
}

output "dish_stream_log_group_name" {
  description = "CloudWatch log group containing metadata-only per-dish change summaries."
  value       = aws_cloudwatch_log_group.dish_stream.name
}

output "rag_credentials_secret_arn" {
  description = "Secrets Manager ARN read by the RAG Lambdas. Populate its value out-of-band; Terraform does not manage the API keys."
  value       = local.rag_credentials_secret_arn
}

output "rag_collection_name" {
  description = "Stage-specific Weaviate collection used for menu chunks."
  value       = local.rag_collection_name
}

output "dish_index_updates_queue_url" {
  description = "FIFO queue carrying minimal per-dish vector-index refresh requests."
  value       = aws_sqs_queue.dish_index_updates.url
}

output "dish_index_updates_dlq_url" {
  description = "Dead-letter queue containing dish-index updates that exhausted retries."
  value       = aws_sqs_queue.dish_index_updates_dlq.url
}

output "rag_indexer_lambda_name" {
  description = "Lambda that reconciles DynamoDB dish state into Weaviate."
  value       = aws_lambda_function.rag_indexer.function_name
}

output "rag_chat_lambda_name" {
  description = "Lambda that owns chat sessions, performs RAG retrieval, and generates grounded answers."
  value       = aws_lambda_function.rag_chat.function_name
}

output "chat_history_table_name" {
  description = "DynamoDB table containing chat ownership metadata and expiring message history."
  value       = aws_dynamodb_table.chat_history.name
}

output "create_chat_session_url" {
  description = "Authenticated URL for creating a server-owned chat session."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/chat/sessions"
}

output "get_chat_session_url" {
  description = "Authenticated URL template for loading an owned chat session."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/chat/sessions/{chatId}"
}

output "send_chat_message_url" {
  description = "Authenticated URL template for sending a message to an owned chat session."
  value       = "${aws_api_gateway_stage.stage.invoke_url}/chat/sessions/{chatId}/messages"
}

output "cognito_user_pool_id" {
  description = "Cognito user pool ID."
  value       = aws_cognito_user_pool.users.id
}

output "cognito_user_pool_client_id" {
  description = "Cognito user pool app client ID."
  value       = aws_cognito_user_pool_client.app.id
}

output "cognito_admin_group_name" {
  description = "Cognito group whose members may manage menus, announcements, and orders."
  value       = aws_cognito_user_group.admins.name
}

output "cognito_user_pool_arn" {
  description = "Cognito user pool ARN."
  value       = aws_cognito_user_pool.users.arn
}

output "frontend_environment" {
  description = "Frontend environment values for the currently selected deployment."
  value = {
    VITE_API_BASE_URL         = aws_api_gateway_stage.stage.invoke_url
    VITE_COGNITO_USER_POOL_ID = aws_cognito_user_pool.users.id
    VITE_COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.app.id
    VITE_COGNITO_ADMIN_GROUP  = aws_cognito_user_group.admins.name
    VITE_DISH_IMAGES_BASE_URL = "https://${aws_s3_bucket.dish_images.bucket_regional_domain_name}"
  }
}
