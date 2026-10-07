variable "aws_region" {
  description = "AWS region where the stack will be deployed."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Optional local AWS CLI profile used by Terraform. Leave null for the default credential chain."
  type        = string
  default     = null
  nullable    = true
}

variable "service_name" {
  description = "Base name used for AWS resources. The workspace stage is appended automatically."
  type        = string
  default     = "sushi-menu-api"
}

variable "table_name" {
  description = "Base DynamoDB table name. The workspace stage is always appended; leave empty to use dishes-table-<stage>."
  type        = string
  default     = ""

  validation {
    condition = var.table_name == "" || (
      length(var.table_name) <= 230 &&
      can(regex("^[A-Za-z0-9_.-]+$", var.table_name))
    )
    error_message = "table_name must be empty or a valid DynamoDB table-name base using letters, numbers, underscores, periods, or hyphens."
  }
}

variable "orders_table_name" {
  description = "Base DynamoDB orders table name. The workspace stage is always appended; leave empty to use orders-table-<stage>."
  type        = string
  default     = ""

  validation {
    condition = var.orders_table_name == "" || (
      length(var.orders_table_name) <= 230 &&
      can(regex("^[A-Za-z0-9_.-]+$", var.orders_table_name))
    )
    error_message = "orders_table_name must be empty or a valid DynamoDB table-name base using letters, numbers, underscores, periods, or hyphens."
  }
}

variable "orders_point_in_time_recovery_enabled" {
  description = "Enable point-in-time recovery for the orders, pickup-failure, and restaurant-content tables."
  type        = bool
  default     = true
}

variable "cors_allowed_origin" {
  description = "Origin allowed to call the API from a browser. Use the exact frontend origin in production."
  type        = string
  default     = "*"
}

variable "frontend_cloudfront_price_class" {
  description = "CloudFront edge-location price class used by the React application distribution."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition = contains([
      "PriceClass_100",
      "PriceClass_200",
      "PriceClass_All",
    ], var.frontend_cloudfront_price_class)
    error_message = "frontend_cloudfront_price_class must be PriceClass_100, PriceClass_200, or PriceClass_All."
  }
}

variable "frontend_root_domain_name" {
  description = "Public Route 53 root domain used for frontend hosting. Set it with TF_VAR_frontend_root_domain_name."
  type        = string
  nullable    = false

  validation {
    condition = (
      var.frontend_root_domain_name == lower(trimspace(var.frontend_root_domain_name)) &&
      can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.frontend_root_domain_name)) &&
      strcontains(var.frontend_root_domain_name, ".") &&
      !strcontains(var.frontend_root_domain_name, "..")
    )
    error_message = "frontend_root_domain_name must be a lowercase root domain such as snowfoxcorvallis.com, without a scheme, path, or trailing dot."
  }
}

variable "order_queue_message_retention_seconds" {
  description = "How long order-notification messages remain in the main SQS queue."
  type        = number
  default     = 345600

  validation {
    condition = (
      var.order_queue_message_retention_seconds >= 60 &&
      var.order_queue_message_retention_seconds <= 1209600
    )
    error_message = "order_queue_message_retention_seconds must be between 60 seconds and 14 days."
  }
}

variable "order_dlq_message_retention_seconds" {
  description = "How long failed order-notification messages remain in the dead-letter queue."
  type        = number
  default     = 1209600

  validation {
    condition = (
      var.order_dlq_message_retention_seconds >= 60 &&
      var.order_dlq_message_retention_seconds <= 1209600
    )
    error_message = "order_dlq_message_retention_seconds must be between 60 seconds and 14 days."
  }
}

variable "ses_sender_email" {
  description = "Verified Amazon SES email identity used as the From address for order notifications."
  type        = string

  validation {
    condition     = can(regex("^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$", var.ses_sender_email))
    error_message = "ses_sender_email must be a valid email address."
  }
}

variable "admin_order_email" {
  description = "Restaurant administrator email address that receives new-order notifications."
  type        = string

  validation {
    condition     = can(regex("^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$", var.admin_order_email))
    error_message = "admin_order_email must be a valid email address."
  }
}

variable "dish_images_public_read_enabled" {
  description = "Allow public reads from the dishes/ S3 prefix until CloudFront with Origin Access Control is added. Uploads always require an admin presigned URL."
  type        = bool
  default     = true
}

variable "admin_group_name" {
  description = "Cognito group whose members may create dishes."
  type        = string
  default     = "admin"

  validation {
    condition     = length(trimspace(var.admin_group_name)) > 0
    error_message = "admin_group_name must not be empty."
  }
}

variable "log_retention_days" {
  description = "Number of days to retain Lambda logs."
  type        = number
  default     = 14

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a retention period supported by CloudWatch Logs."
  }
}

variable "rag_credentials_secret_arn" {
  description = "ARN of an existing Secrets Manager JSON secret containing OPENAI_API_KEY, WEAVIATE_API_KEY, and COHERE_API_KEY. Leave empty to let Terraform create an empty secret container, then enter the values in the AWS console."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.rag_credentials_secret_arn) == "" ||
      can(regex("^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+$", trimspace(var.rag_credentials_secret_arn)))
    )
    error_message = "rag_credentials_secret_arn must be empty or a Secrets Manager secret ARN."
  }
}

variable "rag_credentials_kms_key_arn" {
  description = "Optional customer-managed KMS key ARN used by the RAG credentials secret. Leave empty when the secret uses the default Secrets Manager key."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.rag_credentials_kms_key_arn) == "" ||
      can(regex("^arn:[^:]+:kms:[^:]+:[0-9]{12}:key/.+$", trimspace(var.rag_credentials_kms_key_arn)))
    )
    error_message = "rag_credentials_kms_key_arn must be empty or a KMS key ARN."
  }
}

variable "rag_weaviate_url" {
  description = "Weaviate Cloud HTTPS endpoint. It may instead be stored as WEAVIATE_URL in the RAG credentials secret."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.rag_weaviate_url) == "" ||
      can(regex("^https://[^[:space:]]+$", trimspace(var.rag_weaviate_url)))
    )
    error_message = "rag_weaviate_url must be empty or an HTTPS URL."
  }
}

variable "rag_collection_name_prefix" {
  description = "Weaviate collection prefix. Terraform appends the deployment stage to isolate environments."
  type        = string
  default     = "MenuChunks"

  validation {
    condition     = can(regex("^[A-Z][A-Za-z0-9_]{0,100}$", var.rag_collection_name_prefix))
    error_message = "rag_collection_name_prefix must begin with an uppercase letter and contain only letters, numbers, or underscores."
  }
}

variable "rag_openai_chat_model" {
  description = "Explicit OpenAI Chat Completions model used for grounded menu answers."
  type        = string
  default     = "gpt-4o-mini"

  validation {
    condition     = length(trimspace(var.rag_openai_chat_model)) > 0
    error_message = "rag_openai_chat_model must not be empty."
  }
}

variable "rag_candidate_limit" {
  description = "Number of Weaviate chunks retrieved and reranked for each chat question."
  type        = number
  default     = 15

  validation {
    condition     = var.rag_candidate_limit >= 1 && var.rag_candidate_limit <= 50
    error_message = "rag_candidate_limit must be between 1 and 50."
  }
}

variable "rag_context_dish_limit" {
  description = "Maximum number of authoritative full dish records supplied to OpenAI."
  type        = number
  default     = 3

  validation {
    condition = (
      var.rag_context_dish_limit >= 1 &&
      var.rag_context_dish_limit <= var.rag_candidate_limit
    )
    error_message = "rag_context_dish_limit must be between 1 and rag_candidate_limit."
  }
}

variable "rag_min_rerank_score" {
  description = "Minimum Cohere rerank score required before a menu chunk can be used as chat context."
  type        = number
  default     = 0.1

  validation {
    condition     = var.rag_min_rerank_score >= 0 && var.rag_min_rerank_score <= 1
    error_message = "rag_min_rerank_score must be between 0 and 1."
  }
}

variable "rag_log_selected_chunks" {
  description = "Log bounded text and ranking metadata for RAG chunks that select chat context. Enable only temporarily for debugging."
  type        = bool
  default     = false
}

variable "rag_log_retrieved_candidates" {
  description = "Log bounded text, ranking metadata, and selection outcomes for every retrieved RAG candidate. Enable only temporarily for non-production debugging."
  type        = bool
  default     = false
}

variable "rag_log_openai_context_dishes" {
  description = "Log the authoritative DynamoDB dish objects supplied to OpenAI. Enable only temporarily for non-production debugging."
  type        = bool
  default     = false
}

variable "rag_log_user_questions" {
  description = "Include the exact user question in enabled RAG diagnostic events. Enable only temporarily for non-production debugging."
  type        = bool
  default     = false
}

variable "rag_chat_history_message_limit" {
  description = "Maximum number of recent messages loaded as conversational context."
  type        = number
  default     = 12

  validation {
    condition     = var.rag_chat_history_message_limit >= 1 && var.rag_chat_history_message_limit <= 30
    error_message = "rag_chat_history_message_limit must be between 1 and 30."
  }
}

variable "rag_chat_retention_days" {
  description = "DynamoDB TTL retention period for chat sessions and messages."
  type        = number
  default     = 30

  validation {
    condition     = var.rag_chat_retention_days >= 1 && var.rag_chat_retention_days <= 365
    error_message = "rag_chat_retention_days must be between 1 and 365."
  }
}

variable "rag_chat_point_in_time_recovery_enabled" {
  description = "Enable point-in-time recovery for the chat ownership and history table."
  type        = bool
  default     = true
}

variable "rag_indexer_timeout_seconds" {
  description = "Lambda timeout for incremental and full Weaviate index reconciliation. Queue visibility is derived from this value."
  type        = number
  default     = 180

  validation {
    condition     = var.rag_indexer_timeout_seconds >= 150 && var.rag_indexer_timeout_seconds <= 900
    error_message = "rag_indexer_timeout_seconds must be between 150 and 900."
  }
}

variable "rag_indexer_http_timeout_seconds" {
  description = "Per-request timeout for Weaviate calls made by the indexer."
  type        = number
  default     = 20

  validation {
    condition     = var.rag_indexer_http_timeout_seconds >= 5 && var.rag_indexer_http_timeout_seconds <= 20
    error_message = "rag_indexer_http_timeout_seconds must be between 5 and 20."
  }
}

variable "rag_chat_http_timeout_seconds" {
  description = "Per-request timeout for sequential Weaviate and OpenAI calls made inside API Gateway's request window."
  type        = number
  default     = 9

  validation {
    condition     = var.rag_chat_http_timeout_seconds >= 3 && var.rag_chat_http_timeout_seconds <= 10
    error_message = "rag_chat_http_timeout_seconds must be between 3 and 10."
  }
}

variable "rag_chat_message_throttling_rate_limit" {
  description = "Aggregate API Gateway steady-state requests per second target for the cost-bearing chat message route."
  type        = number
  default     = 1

  validation {
    condition     = var.rag_chat_message_throttling_rate_limit > 0 && var.rag_chat_message_throttling_rate_limit <= 10
    error_message = "rag_chat_message_throttling_rate_limit must be greater than 0 and at most 10."
  }
}

variable "rag_chat_message_throttling_burst_limit" {
  description = "Aggregate API Gateway burst target for the cost-bearing chat message route."
  type        = number
  default     = 3

  validation {
    condition     = var.rag_chat_message_throttling_burst_limit >= 1 && var.rag_chat_message_throttling_burst_limit <= 20 && floor(var.rag_chat_message_throttling_burst_limit) == var.rag_chat_message_throttling_burst_limit
    error_message = "rag_chat_message_throttling_burst_limit must be a whole number between 1 and 20."
  }
}

variable "rag_queue_message_retention_seconds" {
  description = "How long dish-index refresh messages remain in the FIFO queue."
  type        = number
  default     = 345600

  validation {
    condition = (
      var.rag_queue_message_retention_seconds >= 60 &&
      var.rag_queue_message_retention_seconds <= 1209600
    )
    error_message = "rag_queue_message_retention_seconds must be between 60 seconds and 14 days."
  }
}

variable "rag_dlq_message_retention_seconds" {
  description = "How long failed dish-index refresh messages remain in the dead-letter queue."
  type        = number
  default     = 1209600

  validation {
    condition = (
      var.rag_dlq_message_retention_seconds >= 60 &&
      var.rag_dlq_message_retention_seconds <= 1209600
    )
    error_message = "rag_dlq_message_retention_seconds must be between 60 seconds and 14 days."
  }
}
