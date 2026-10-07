"""Cognito-authenticated chat-session API Lambda."""

from __future__ import annotations

import base64
from datetime import datetime, timezone
import json
import logging
import os
from typing import Any, Callable
import uuid

from .dynamodb import ChatRepository, MenuRepository
from .errors import (
    ConfigurationError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
    UpstreamError,
    ValidationError,
)
from .openai_chat import OpenAIChatClient
from .secrets import RagCredentials, SecretsManagerProvider
from .settings import Settings, validate_https_url
from .weaviate import WeaviateClient


MAX_MESSAGE_LENGTH = 1000
LOGGED_CHUNK_CONTENT_MAX_LENGTH = 500
NO_RELEVANT_MENU_ANSWER = (
    "I couldn't find relevant information in the current menu."
)
CONTEXT_DISH_FIELDS = (
    "id",
    "category",
    "name",
    "description",
    "price",
    "allergens",
    "fullDishInfo",
    "availability",
)
_LOGGER = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")


def _claims(event: dict[str, Any]) -> dict[str, Any]:
    request_context = event.get("requestContext")
    if not isinstance(request_context, dict):
        return {}
    authorizer = request_context.get("authorizer")
    if not isinstance(authorizer, dict):
        return {}
    claims = authorizer.get("claims")
    if isinstance(claims, dict):
        return claims
    jwt = authorizer.get("jwt")
    if isinstance(jwt, dict) and isinstance(jwt.get("claims"), dict):
        return jwt["claims"]
    return {}


def _method(event: dict[str, Any]) -> str:
    method = event.get("httpMethod")
    if isinstance(method, str):
        return method.upper()
    request_context = event.get("requestContext")
    http = (
        request_context.get("http")
        if isinstance(request_context, dict)
        else None
    )
    return (
        str(http.get("method", "")).upper()
        if isinstance(http, dict)
        else ""
    )


def _path(event: dict[str, Any]) -> str:
    for candidate in (
        event.get("resource"),
        event.get("rawPath"),
        event.get("path"),
    ):
        if isinstance(candidate, str) and candidate:
            return candidate.rstrip("/") or "/"
    return ""


def _chat_id(event: dict[str, Any]) -> str:
    parameters = event.get("pathParameters")
    value = parameters.get("chatId") if isinstance(parameters, dict) else None
    return value.strip() if isinstance(value, str) else ""


def _json_body(event: dict[str, Any]) -> dict[str, Any]:
    body = event.get("body")
    if event.get("isBase64Encoded") and isinstance(body, str):
        try:
            body = base64.b64decode(body, validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as error:
            raise ValidationError("The request body is invalid") from error
    if isinstance(body, dict):
        result = body
    elif isinstance(body, str):
        try:
            result = json.loads(body)
        except json.JSONDecodeError as error:
            raise ValidationError("The request body must be valid JSON") from error
    else:
        raise ValidationError("A JSON request body is required")
    if not isinstance(result, dict):
        raise ValidationError("The request body must be a JSON object")
    return result


def _response(
    status_code: int, payload: dict[str, Any], allowed_origin: str
) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Origin": allowed_origin,
            "Content-Type": "application/json",
        },
        "body": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    }


def _error(
    status_code: int,
    code: str,
    message: str,
    allowed_origin: str,
) -> dict[str, Any]:
    return _response(
        status_code, {"error": {"code": code, "message": message}}, allowed_origin
    )


class ChatService:
    def __init__(
        self,
        *,
        settings: Settings,
        menu_repository: MenuRepository,
        chat_repository: ChatRepository,
        vector_client: WeaviateClient,
        openai_client: OpenAIChatClient,
        logger: Any = None,
        clock: Callable[[], datetime] = _utc_now,
        uuid_factory: Callable[[], uuid.UUID] = uuid.uuid4,
    ) -> None:
        self.settings = settings
        self.menu_repository = menu_repository
        self.chat_repository = chat_repository
        self.vector_client = vector_client
        self.openai_client = openai_client
        self.logger = logger or _LOGGER
        if (
            self.settings.log_selected_chunks
            or self.settings.log_retrieved_candidates
            or self.settings.log_openai_context_dishes
        ) and isinstance(self.logger, logging.Logger):
            self.logger.setLevel(logging.INFO)
        self.clock = clock
        self.uuid_factory = uuid_factory

    def _expiry(self, now: datetime) -> int:
        return int(now.timestamp()) + self.settings.chat_ttl_days * 86400

    def create_session(self, owner_sub: str) -> dict[str, Any]:
        now = self.clock()
        created_at = _timestamp(now)
        for _attempt in range(3):
            chat_id = str(self.uuid_factory())
            try:
                session = self.chat_repository.create_session(
                    chat_id=chat_id,
                    owner_sub=owner_sub,
                    created_at=created_at,
                    expires_at=self._expiry(now),
                )
                return {**session, "messages": []}
            except ConflictError:
                continue
        raise UpstreamError("A unique chat session could not be created")

    def get_history(self, owner_sub: str, chat_id: str) -> dict[str, Any]:
        return self.chat_repository.get_history(
            chat_id=chat_id,
            owner_sub=owner_sub,
            limit=self.settings.chat_history_limit,
        )

    @staticmethod
    def _message_value(value: Any) -> str:
        if not isinstance(value, str):
            raise ValidationError("message must be a string")
        message = value.strip()
        if not message:
            raise ValidationError("message cannot be empty")
        if len(message) > MAX_MESSAGE_LENGTH:
            raise ValidationError(
                f"message cannot exceed {MAX_MESSAGE_LENGTH} characters"
            )
        return message

    def send_message(
        self,
        *,
        owner_sub: str,
        chat_id: str,
        message: Any,
        request_id: Any,
    ) -> dict[str, Any]:
        question = self._message_value(message)
        request_id = self.chat_repository.validate_request_id(request_id)

        # Ownership is checked before idempotency data is accessed.
        self.chat_repository.get_session(
            chat_id=chat_id, owner_sub=owner_sub
        )
        completed = self.chat_repository.get_completed_request(
            chat_id=chat_id, request_id=request_id
        )
        if completed is not None:
            return completed

        history = self.chat_repository.list_messages(
            chat_id=chat_id, limit=self.settings.chat_history_limit
        )
        retrieved = self.vector_client.retrieve(
            question, limit=self.settings.retrieval_candidate_limit
        )
        diagnostic_question = (
            {"question": question}
            if self.settings.log_user_questions
            else {}
        )
        # Weaviate identifies candidates only. This fresh, consistent
        # DynamoDB read supplies the actual context and current availability.
        current_dishes = self.menu_repository.load_dishes()
        dishes_by_id = {dish["id"]: dish for dish in current_dishes}

        relevant_ids: list[str] = []
        selected_chunks: list[dict[str, Any]] = []
        retrieved_candidates: list[dict[str, Any]] = []
        for rank, chunk in enumerate(retrieved, start=1):
            score = chunk.get("rerank_score", -1)
            dish_id = chunk.get("dish_id")
            content = chunk.get("content")
            logged_chunk = {
                "rank": rank,
                "dishId": (
                    dish_id[:100] if isinstance(dish_id, str) else None
                ),
                "chunkIndex": (
                    chunk.get("chunk_index")
                    if isinstance(chunk.get("chunk_index"), int)
                    and not isinstance(chunk.get("chunk_index"), bool)
                    else None
                ),
                "rerankScore": score,
                "contentPreview": (
                    content[:LOGGED_CHUNK_CONTENT_MAX_LENGTH]
                    if isinstance(content, str)
                    else ""
                ),
                "contentLength": (
                    len(content) if isinstance(content, str) else 0
                ),
                "contentTruncated": (
                    isinstance(content, str)
                    and len(content) > LOGGED_CHUNK_CONTENT_MAX_LENGTH
                ),
            }

            rejection_reason: str | None = None
            if len(relevant_ids) >= self.settings.retrieval_dish_limit:
                rejection_reason = "contextDishLimitReached"
            elif score < self.settings.retrieval_min_rerank_score:
                rejection_reason = "belowMinimumRerankScore"
            elif not isinstance(dish_id, str) or not dish_id:
                rejection_reason = "invalidDishId"
            elif dish_id not in dishes_by_id:
                rejection_reason = "dishNotInCurrentMenu"
            elif dish_id in relevant_ids:
                rejection_reason = "duplicateDish"
            else:
                relevant_ids.append(dish_id)
                selected_chunks.append(logged_chunk)

            retrieved_candidates.append(
                {
                    **logged_chunk,
                    "selected": rejection_reason is None,
                    "rejectionReason": rejection_reason,
                }
            )

        if self.settings.log_retrieved_candidates:
            self.logger.info(
                "RAG_RETRIEVED_CANDIDATES %s",
                json.dumps(
                    {
                        **diagnostic_question,
                        "retrievedCandidateCount": len(retrieved_candidates),
                        "selectedChunkCount": len(selected_chunks),
                        "minimumRerankScore": (
                            self.settings.retrieval_min_rerank_score
                        ),
                        "candidates": retrieved_candidates,
                    },
                    ensure_ascii=True,
                    separators=(",", ":"),
                ),
            )

        if self.settings.log_selected_chunks:
            self.logger.info(
                "RAG_SELECTED_CHUNKS %s",
                json.dumps(
                    {
                        **diagnostic_question,
                        "retrievedCandidateCount": len(retrieved),
                        "selectedChunkCount": len(selected_chunks),
                        "minimumRerankScore": (
                            self.settings.retrieval_min_rerank_score
                        ),
                        "selectedChunks": selected_chunks,
                    },
                    ensure_ascii=True,
                    separators=(",", ":"),
                ),
            )

        authoritative_context = [
            {
                field: dishes_by_id[dish_id].get(field)
                for field in CONTEXT_DISH_FIELDS
            }
            for dish_id in relevant_ids
        ]
        if self.settings.log_openai_context_dishes:
            self.logger.info(
                "OPENAI_CONTEXT_DISHES %s",
                json.dumps(
                    {
                        **diagnostic_question,
                        "openaiRequestSent": bool(authoritative_context),
                        "contextDishCount": len(authoritative_context),
                        "contextDishes": authoritative_context,
                    },
                    ensure_ascii=True,
                    separators=(",", ":"),
                ),
            )
        answer = (
            self.openai_client.generate(
                question=question,
                context_dishes=authoritative_context,
                history=history,
            )
            if authoritative_context
            else NO_RELEVANT_MENU_ANSWER
        )

        now = self.clock()
        created_at = _timestamp(now)
        user_message = {
            "messageId": str(self.uuid_factory()),
            "role": "user",
            "content": question,
            "createdAt": created_at,
        }
        assistant_message = {
            "messageId": str(self.uuid_factory()),
            "role": "assistant",
            "content": answer,
            "createdAt": created_at,
        }
        return self.chat_repository.save_exchange(
            chat_id=chat_id,
            owner_sub=owner_sub,
            request_id=request_id,
            user_message=user_message,
            assistant_message=assistant_message,
            expires_at=self._expiry(now),
        )


def _new_vector_client(
    settings: Settings, credentials: RagCredentials
) -> WeaviateClient:
    raw_url = settings.weaviate_url or credentials.weaviate_url or ""
    if not raw_url:
        raise ConfigurationError(
            "WEAVIATE_URL is required in the environment or credentials secret"
        )
    base_url = validate_https_url(raw_url, field_name="WEAVIATE_URL")
    return WeaviateClient(
        base_url=base_url,
        api_key=credentials.weaviate_api_key,
        openai_api_key=credentials.openai_api_key,
        cohere_api_key=credentials.cohere_api_key,
        collection_name=settings.weaviate_collection,
        timeout_seconds=settings.http_timeout_seconds,
    )


def _new_openai_client(
    settings: Settings, credentials: RagCredentials
) -> OpenAIChatClient:
    return OpenAIChatClient(
        api_key=credentials.openai_api_key,
        model=settings.openai_chat_model,
        timeout_seconds=settings.http_timeout_seconds,
        max_tokens=settings.openai_max_tokens,
    )


def create_handler(
    *,
    settings: Settings | None = None,
    service: ChatService | None = None,
    menu_repository: MenuRepository | None = None,
    chat_repository: ChatRepository | None = None,
    vector_client: WeaviateClient | None = None,
    openai_client: OpenAIChatClient | None = None,
    secret_provider: SecretsManagerProvider | None = None,
    vector_client_factory: Callable[
        [Settings, RagCredentials], WeaviateClient
    ] = _new_vector_client,
    openai_client_factory: Callable[
        [Settings, RagCredentials], OpenAIChatClient
    ] = _new_openai_client,
    logger: Any = None,
    clock: Callable[[], datetime] = _utc_now,
    uuid_factory: Callable[[], uuid.UUID] = uuid.uuid4,
) -> Callable[[dict[str, Any], Any], dict[str, Any]]:
    runtime_settings = settings
    runtime_service = service
    runtime_menu_repository = menu_repository
    runtime_chat_repository = chat_repository
    runtime_provider = secret_provider
    runtime_credentials: RagCredentials | None = None
    safe_logger = logger or _LOGGER

    def get_service() -> ChatService:
        nonlocal runtime_settings, runtime_service
        nonlocal runtime_menu_repository, runtime_chat_repository
        nonlocal runtime_provider, runtime_credentials
        if service is not None:
            return service
        runtime_settings = runtime_settings or Settings.from_env()
        runtime_menu_repository = runtime_menu_repository or MenuRepository(
            runtime_settings.menu_table_name
        )
        runtime_chat_repository = runtime_chat_repository or ChatRepository(
            runtime_settings.chat_table_name
        )

        if vector_client is not None and openai_client is not None:
            if runtime_service is None:
                runtime_service = ChatService(
                    settings=runtime_settings,
                    menu_repository=runtime_menu_repository,
                    chat_repository=runtime_chat_repository,
                    vector_client=vector_client,
                    openai_client=openai_client,
                    logger=safe_logger,
                    clock=clock,
                    uuid_factory=uuid_factory,
                )
            return runtime_service

        runtime_provider = runtime_provider or SecretsManagerProvider(
            runtime_settings.credentials_secret_arn,
            cache_seconds=runtime_settings.secret_cache_seconds,
        )
        credentials = runtime_provider.get()
        if runtime_service is None or credentials != runtime_credentials:
            runtime_service = ChatService(
                settings=runtime_settings,
                menu_repository=runtime_menu_repository,
                chat_repository=runtime_chat_repository,
                vector_client=vector_client
                or vector_client_factory(runtime_settings, credentials),
                openai_client=openai_client
                or openai_client_factory(runtime_settings, credentials),
                logger=safe_logger,
                clock=clock,
                uuid_factory=uuid_factory,
            )
            runtime_credentials = credentials
        return runtime_service

    def handler(event: dict[str, Any] | None, context: Any = None) -> dict[str, Any]:
        nonlocal runtime_settings
        payload = event if isinstance(event, dict) else {}
        allowed_origin = (
            runtime_settings.cors_allowed_origin
            if runtime_settings
            else os.environ.get("CORS_ALLOWED_ORIGIN", "*")
        )
        method = _method(payload)
        if method == "OPTIONS":
            return _response(200, {}, allowed_origin)

        owner_sub = _claims(payload).get("sub")
        if not isinstance(owner_sub, str) or not owner_sub.strip():
            return _error(
                401,
                "UNAUTHORIZED",
                "A valid Cognito token is required.",
                allowed_origin,
            )
        owner_sub = owner_sub.strip()

        try:
            chat_service = get_service()
            allowed_origin = chat_service.settings.cors_allowed_origin
            path = _path(payload)
            chat_id = _chat_id(payload)
            is_messages_path = path.endswith("/messages")
            if (
                method == "POST"
                and not chat_id
                and path == "/chat/sessions"
            ):
                return _response(
                    201,
                    chat_service.create_session(owner_sub),
                    allowed_origin,
                )
            if method == "GET" and chat_id and not is_messages_path:
                return _response(
                    200,
                    chat_service.get_history(owner_sub, chat_id),
                    allowed_origin,
                )
            if method == "POST" and chat_id and is_messages_path:
                body = _json_body(payload)
                return _response(
                    200,
                    chat_service.send_message(
                        owner_sub=owner_sub,
                        chat_id=chat_id,
                        message=body.get("message"),
                        request_id=body.get("requestId"),
                    ),
                    allowed_origin,
                )
            return _error(
                404,
                "NOT_FOUND",
                "The requested chat route does not exist.",
                allowed_origin,
            )
        except ValidationError as error:
            return _error(400, "INVALID_REQUEST", str(error), allowed_origin)
        except NotFoundError:
            return _error(
                404, "CHAT_NOT_FOUND", "The chat session was not found.", allowed_origin
            )
        except ForbiddenError:
            return _error(
                403,
                "FORBIDDEN",
                "You cannot access this chat session.",
                allowed_origin,
            )
        except ConflictError:
            return _error(
                409,
                "REQUEST_CONFLICT",
                "The chat request conflicted. Retry with the same requestId.",
                allowed_origin,
            )
        except Exception as error:
            if runtime_settings is not None:
                allowed_origin = runtime_settings.cors_allowed_origin
            safe_reason = (
                str(error)
                if isinstance(error, (ConfigurationError, UpstreamError))
                else "not-recorded"
            )
            safe_logger.error(
                "Chat request failed errorType=%s reason=%s requestId=%s",
                type(error).__name__,
                safe_reason,
                getattr(context, "aws_request_id", None),
            )
            return _error(
                500,
                "CHAT_UNAVAILABLE",
                "The chat service is temporarily unavailable.",
                allowed_origin,
            )

    return handler


_default_handler: Callable[[dict[str, Any], Any], dict[str, Any]] | None = None


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    global _default_handler
    if _default_handler is None:
        _default_handler = create_handler()
    return _default_handler(event, context)
