"""SQS and operator entry point for menu-index reconciliation."""

from __future__ import annotations

import json
import logging
from typing import Any, Callable

from .dynamodb import MenuRepository
from .errors import ConfigurationError, ValidationError
from .secrets import RagCredentials, SecretsManagerProvider
from .settings import Settings, validate_https_url
from .weaviate import WeaviateClient


_LOGGER = logging.getLogger(__name__)


class IndexService:
    def __init__(
        self, *, menu_repository: MenuRepository, vector_client: WeaviateClient
    ) -> None:
        self.menu_repository = menu_repository
        self.vector_client = vector_client

    def refresh_dish(self, dish_id: str) -> dict[str, Any]:
        if not isinstance(dish_id, str) or not dish_id.strip():
            raise ValidationError("dishId must be a non-empty string")
        dish_id = dish_id.strip()
        dishes = self.menu_repository.load_dishes()
        dish = next(
            (candidate for candidate in dishes if candidate["id"] == dish_id),
            None,
        )
        if dish is None:
            deleted = self.vector_client.delete_dish(dish_id)
            return {
                "dishId": dish_id,
                "action": "delete",
                "deletedChunks": deleted,
            }
        chunk_count = self.vector_client.replace_dish(dish)
        return {
            "dishId": dish_id,
            "action": "upsert",
            "indexedChunks": chunk_count,
        }

    def rebuild(self) -> dict[str, Any]:
        dishes = self.menu_repository.load_dishes()
        count = self.vector_client.rebuild(dishes)
        return {"rebuild": True, "dishCount": len(dishes), "chunkCount": count}


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


def _parse_record(record: dict[str, Any]) -> dict[str, Any]:
    body = record.get("body")
    if isinstance(body, dict):
        payload = body
    elif isinstance(body, str):
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as error:
            raise ValidationError("SQS message body must be valid JSON") from error
    else:
        raise ValidationError("SQS message body is required")
    if not isinstance(payload, dict):
        raise ValidationError("SQS message body must be a JSON object")
    return payload


def create_handler(
    *,
    settings: Settings | None = None,
    service: IndexService | None = None,
    menu_repository: MenuRepository | None = None,
    vector_client: WeaviateClient | None = None,
    secret_provider: SecretsManagerProvider | None = None,
    vector_client_factory: Callable[
        [Settings, RagCredentials], WeaviateClient
    ] = _new_vector_client,
    logger: Any = None,
) -> Callable[[dict[str, Any], Any], dict[str, Any]]:
    runtime_settings = settings
    runtime_service = service
    runtime_repository = menu_repository
    runtime_provider = secret_provider
    runtime_credentials: RagCredentials | None = None
    safe_logger = logger or _LOGGER

    def get_service() -> IndexService:
        nonlocal runtime_settings, runtime_service, runtime_repository
        nonlocal runtime_provider, runtime_credentials
        if service is not None:
            return service
        runtime_settings = runtime_settings or Settings.from_env()
        runtime_repository = runtime_repository or MenuRepository(
            runtime_settings.menu_table_name
        )
        if vector_client is not None:
            if runtime_service is None:
                runtime_service = IndexService(
                    menu_repository=runtime_repository,
                    vector_client=vector_client,
                )
            return runtime_service

        runtime_provider = runtime_provider or SecretsManagerProvider(
            runtime_settings.credentials_secret_arn,
            cache_seconds=runtime_settings.secret_cache_seconds,
        )
        credentials = runtime_provider.get()
        if runtime_service is None or credentials != runtime_credentials:
            runtime_service = IndexService(
                menu_repository=runtime_repository,
                vector_client=vector_client_factory(
                    runtime_settings, credentials
                ),
            )
            runtime_credentials = credentials
        return runtime_service

    def handler(event: dict[str, Any] | None, _context: Any = None) -> dict[str, Any]:
        payload = event if isinstance(event, dict) else {}

        if payload.get("rebuild") is True and "Records" not in payload:
            return get_service().rebuild()

        records = payload.get("Records")
        if not isinstance(records, list):
            if "dishId" in payload:
                return get_service().refresh_dish(payload["dishId"])
            raise ValidationError(
                "Expected an SQS event, {dishId}, or {rebuild: true}"
            )

        try:
            index_service = get_service()
        except Exception as error:
            safe_logger.error(
                "Menu index batch failed errorType=%s",
                type(error).__name__,
            )
            return {
                "batchItemFailures": [
                    {
                        "itemIdentifier": (
                            str(record.get("messageId"))
                            if isinstance(record, dict)
                            and record.get("messageId")
                            else f"record-{index}"
                        )
                    }
                    for index, record in enumerate(records)
                ]
            }

        failures: list[dict[str, str]] = []
        for index, record in enumerate(records):
            message_id = (
                str(record.get("messageId"))
                if isinstance(record, dict) and record.get("messageId")
                else f"record-{index}"
            )
            try:
                message = _parse_record(record)
                if message.get("rebuild") is True:
                    index_service.rebuild()
                else:
                    index_service.refresh_dish(message.get("dishId"))
            except Exception as error:
                failures.append({"itemIdentifier": message_id})
                safe_logger.error(
                    "Menu index record failed messageId=%s errorType=%s",
                    message_id,
                    type(error).__name__,
                )
        return {"batchItemFailures": failures}

    return handler


_default_handler: Callable[[dict[str, Any], Any], dict[str, Any]] | None = None


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    global _default_handler
    if _default_handler is None:
        _default_handler = create_handler()
    return _default_handler(event, context)
