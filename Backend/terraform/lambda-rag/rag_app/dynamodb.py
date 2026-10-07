"""DynamoDB repositories using only the low-level boto3 client."""

from __future__ import annotations

from decimal import Decimal
import re
import time
from typing import Any, Callable

from .errors import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    UpstreamError,
    ValidationError,
)


MENU_RECORD_ID = "MENU#CURRENT"
_ATTRIBUTE_TYPES = frozenset(
    {"S", "N", "B", "BOOL", "NULL", "L", "M", "SS", "NS", "BS"}
)
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$")


def encode_attribute(value: Any) -> dict[str, Any]:
    if value is None:
        return {"NULL": True}
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, (int, Decimal)):
        return {"N": str(value)}
    if isinstance(value, float):
        return {"N": str(Decimal(str(value)))}
    if isinstance(value, bytes):
        return {"B": value}
    if isinstance(value, (list, tuple)):
        return {"L": [encode_attribute(item) for item in value]}
    if isinstance(value, dict):
        return {
            "M": {str(key): encode_attribute(item) for key, item in value.items()}
        }
    raise TypeError(f"Unsupported DynamoDB value type: {type(value).__name__}")


def decode_attribute(value: Any) -> Any:
    if not isinstance(value, dict) or len(value) != 1:
        return value
    kind = next(iter(value))
    if kind not in _ATTRIBUTE_TYPES:
        return value
    encoded = value[kind]
    if kind == "S":
        return encoded
    if kind == "N":
        number = Decimal(encoded)
        return int(number) if number == number.to_integral() else number
    if kind == "B":
        return encoded
    if kind == "BOOL":
        return bool(encoded)
    if kind == "NULL":
        return None
    if kind == "L":
        return [decode_attribute(item) for item in encoded]
    if kind == "M":
        return {key: decode_attribute(item) for key, item in encoded.items()}
    if kind in {"SS", "BS"}:
        return list(encoded)
    if kind == "NS":
        return [decode_attribute({"N": item}) for item in encoded]
    return encoded


def encode_item(item: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {key: encode_attribute(value) for key, value in item.items()}


def decode_item(item: dict[str, Any] | None) -> dict[str, Any] | None:
    if not item:
        return None
    return {key: decode_attribute(value) for key, value in item.items()}


def _dynamodb_client(client: Any | None) -> Any:
    if client is not None:
        return client
    try:
        import boto3  # type: ignore
    except ImportError as error:  # pragma: no cover - Lambda supplies it
        raise RuntimeError("boto3 is required in AWS Lambda") from error
    return boto3.client("dynamodb")


def _error_code(error: Exception) -> str:
    response = getattr(error, "response", None)
    if not isinstance(response, dict):
        return ""
    detail = response.get("Error")
    return str(detail.get("Code", "")) if isinstance(detail, dict) else ""


def _transaction_failure_detail(error: Exception) -> str:
    """Return only DynamoDB error codes, never item data or provider messages."""
    error_code = _error_code(error) or type(error).__name__
    response = getattr(error, "response", None)
    reasons = response.get("CancellationReasons") if isinstance(response, dict) else None
    if not isinstance(reasons, list):
        return error_code
    reason_codes = [
        (
            str(reason.get("Code", "Unknown"))
            if isinstance(reason, dict)
            else "Unknown"
        )
        for reason in reasons
    ]
    return f"{error_code}[{','.join(reason_codes)}]"


def _normalize_dish(item: dict[str, Any]) -> dict[str, Any]:
    dish_id = item.get("id")
    if not isinstance(dish_id, str) or not dish_id.strip():
        raise UpstreamError("The menu contains a dish without an id")
    full_dish_info = item.get(
        "fullDishInfo", item.get("ragInfo", "")
    )
    allergens = item.get("allergens", [])
    normalized = {
        "id": dish_id.strip(),
        "category": item.get("category", ""),
        "name": item.get("name", ""),
        "description": item.get("description", ""),
        "price": str(item.get("price", "")),
        "allergens": list(allergens) if isinstance(allergens, list) else [],
        "fullDishInfo": (
            full_dish_info if isinstance(full_dish_info, str) else ""
        ),
        "availability": (
            "out" if item.get("availability") == "out" else "available"
        ),
    }
    if "image" in item:
        normalized["image"] = item["image"]
    return normalized


def _normalize_menu(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        raise UpstreamError("The aggregate menu item has no items list")
    dishes = [_normalize_dish(item) for item in items if isinstance(item, dict)]
    if len(dishes) != len(items):
        raise UpstreamError("The aggregate menu contains an invalid dish")
    ids = [dish["id"] for dish in dishes]
    if len(set(ids)) != len(ids):
        raise UpstreamError("The menu contains duplicate dish ids")
    return dishes


class MenuRepository:
    """Load the authoritative aggregate menu, with legacy row fallback."""

    def __init__(self, table_name: str, *, client: Any | None = None) -> None:
        self.table_name = table_name
        self.client = _dynamodb_client(client)

    def load_dishes(self) -> list[dict[str, Any]]:
        try:
            response = self.client.get_item(
                TableName=self.table_name,
                Key=encode_item({"id": MENU_RECORD_ID}),
                ConsistentRead=True,
            )
            aggregate = decode_item(response.get("Item"))
            if aggregate is not None:
                return _normalize_menu(aggregate.get("items"))

            dishes: list[dict[str, Any]] = []
            start_key = None
            while True:
                request: dict[str, Any] = {
                    "TableName": self.table_name,
                    "ConsistentRead": True,
                }
                if start_key:
                    request["ExclusiveStartKey"] = start_key
                page = self.client.scan(**request)
                for raw_item in page.get("Items", []):
                    item = decode_item(raw_item)
                    if item and item.get("id") != MENU_RECORD_ID:
                        dishes.append(_normalize_dish(item))
                start_key = page.get("LastEvaluatedKey")
                if not start_key:
                    break
        except UpstreamError:
            raise
        except Exception as error:
            raise UpstreamError("The menu could not be loaded") from error

        dishes.sort(key=lambda dish: dish["id"])
        ids = [dish["id"] for dish in dishes]
        if len(set(ids)) != len(ids):
            raise UpstreamError("The menu contains duplicate dish ids")
        return dishes

    def get_dish(self, dish_id: str) -> dict[str, Any] | None:
        wanted = dish_id.strip()
        return next(
            (dish for dish in self.load_dishes() if dish["id"] == wanted),
            None,
        )


class ChatRepository:
    """Persist private chat sessions and idempotent message pairs."""

    def __init__(
        self,
        table_name: str,
        *,
        client: Any | None = None,
        epoch_clock: Callable[[], float] = time.time,
    ) -> None:
        self.table_name = table_name
        self.client = _dynamodb_client(client)
        self.epoch_clock = epoch_clock

    @staticmethod
    def _pk(chat_id: str) -> str:
        return f"CHAT#{chat_id}"

    def _is_expired(self, item: dict[str, Any]) -> bool:
        expires_at = item.get("expiresAt")
        return isinstance(expires_at, (int, Decimal)) and expires_at <= int(
            self.epoch_clock()
        )

    def create_session(
        self,
        *,
        chat_id: str,
        owner_sub: str,
        created_at: str,
        expires_at: int,
    ) -> dict[str, Any]:
        item = {
            "PK": self._pk(chat_id),
            "SK": "META",
            "entityType": "CHAT_SESSION",
            "chatId": chat_id,
            "ownerSub": owner_sub,
            "createdAt": created_at,
            "expiresAt": expires_at,
        }
        try:
            self.client.put_item(
                TableName=self.table_name,
                Item=encode_item(item),
                ConditionExpression="attribute_not_exists(PK)",
            )
        except Exception as error:
            if _error_code(error) == "ConditionalCheckFailedException":
                raise ConflictError("Chat id already exists") from error
            raise UpstreamError("The chat session could not be created") from error
        return {"chatId": chat_id, "createdAt": created_at}

    def get_session(self, *, chat_id: str, owner_sub: str) -> dict[str, Any]:
        try:
            response = self.client.get_item(
                TableName=self.table_name,
                Key=encode_item({"PK": self._pk(chat_id), "SK": "META"}),
                ConsistentRead=True,
            )
        except Exception as error:
            raise UpstreamError("The chat session could not be loaded") from error
        item = decode_item(response.get("Item"))
        if not item:
            raise NotFoundError("Chat session not found")
        if self._is_expired(item):
            raise NotFoundError("Chat session has expired")
        if item.get("ownerSub") != owner_sub:
            raise ForbiddenError("The chat session belongs to another user")
        return item

    def list_messages(
        self, *, chat_id: str, limit: int | None = None
    ) -> list[dict[str, Any]]:
        request: dict[str, Any] = {
            "TableName": self.table_name,
            "KeyConditionExpression": (
                "#pk = :pk AND begins_with(#sk, :messagePrefix)"
            ),
            "ExpressionAttributeNames": {"#pk": "PK", "#sk": "SK"},
            "ExpressionAttributeValues": {
                ":pk": encode_attribute(self._pk(chat_id)),
                ":messagePrefix": encode_attribute("MESSAGE#"),
            },
            "ConsistentRead": True,
        }
        if limit is not None:
            request["Limit"] = limit
            request["ScanIndexForward"] = False
        try:
            response = self.client.query(**request)
        except Exception as error:
            raise UpstreamError("Chat messages could not be loaded") from error
        messages = [
            self._public_message(item)
            for raw in response.get("Items", [])
            if (item := decode_item(raw)) is not None
            and not self._is_expired(item)
        ]
        if limit is not None:
            messages.reverse()
        return messages

    def get_history(
        self,
        *,
        chat_id: str,
        owner_sub: str,
        limit: int | None = None,
    ) -> dict[str, Any]:
        session = self.get_session(chat_id=chat_id, owner_sub=owner_sub)
        return {
            "chatId": chat_id,
            "createdAt": session["createdAt"],
            "messages": self.list_messages(chat_id=chat_id, limit=limit),
        }

    @staticmethod
    def validate_request_id(request_id: Any) -> str:
        if not isinstance(request_id, str):
            raise ValidationError("requestId must be a string")
        request_id = request_id.strip()
        if not _REQUEST_ID_PATTERN.fullmatch(request_id):
            raise ValidationError(
                "requestId must be 1-100 URL-safe characters"
            )
        return request_id

    def get_completed_request(
        self, *, chat_id: str, request_id: str
    ) -> dict[str, Any] | None:
        try:
            response = self.client.get_item(
                TableName=self.table_name,
                Key=encode_item(
                    {
                        "PK": self._pk(chat_id),
                        "SK": f"REQUEST#{request_id}",
                    }
                ),
                ConsistentRead=True,
            )
        except Exception as error:
            raise UpstreamError("The prior chat request could not be loaded") from error
        item = decode_item(response.get("Item"))
        if not item or self._is_expired(item):
            return None
        user_message = item.get("userMessage")
        assistant_message = item.get("assistantMessage")
        if not isinstance(user_message, dict) or not isinstance(
            assistant_message, dict
        ):
            raise UpstreamError("The prior chat request is incomplete")
        return {
            "chatId": chat_id,
            "userMessage": self._public_message(user_message),
            "assistantMessage": self._public_message(assistant_message),
        }

    def save_exchange(
        self,
        *,
        chat_id: str,
        owner_sub: str,
        request_id: str,
        user_message: dict[str, Any],
        assistant_message: dict[str, Any],
        expires_at: int,
    ) -> dict[str, Any]:
        request_id = self.validate_request_id(request_id)
        pk = self._pk(chat_id)

        def message_item(message: dict[str, Any], sequence: int) -> dict[str, Any]:
            return {
                "PK": pk,
                "SK": (
                    f"MESSAGE#{message['createdAt']}#{sequence}"
                    f"#{message['messageId']}"
                ),
                "entityType": "CHAT_MESSAGE",
                **message,
                "expiresAt": expires_at,
            }

        user_item = message_item(user_message, 0)
        assistant_item = message_item(assistant_message, 1)
        request_item = {
            "PK": pk,
            "SK": f"REQUEST#{request_id}",
            "entityType": "CHAT_REQUEST",
            "requestId": request_id,
            "userMessage": user_message,
            "assistantMessage": assistant_message,
            "expiresAt": expires_at,
        }
        transaction = [
            {
                "Put": {
                    "TableName": self.table_name,
                    "Item": encode_item(user_item),
                    "ConditionExpression": "attribute_not_exists(PK)",
                }
            },
            {
                "Put": {
                    "TableName": self.table_name,
                    "Item": encode_item(assistant_item),
                    "ConditionExpression": "attribute_not_exists(PK)",
                }
            },
            {
                "Put": {
                    "TableName": self.table_name,
                    "Item": encode_item(request_item),
                    "ConditionExpression": "attribute_not_exists(PK)",
                }
            },
            {
                "Update": {
                    "TableName": self.table_name,
                    "Key": encode_item({"PK": pk, "SK": "META"}),
                    "UpdateExpression": "SET expiresAt = :ttl",
                    "ConditionExpression": "#owner = :owner",
                    "ExpressionAttributeNames": {"#owner": "ownerSub"},
                    "ExpressionAttributeValues": {
                        ":ttl": encode_attribute(expires_at),
                        ":owner": encode_attribute(owner_sub),
                    },
                }
            },
        ]
        try:
            self.client.transact_write_items(TransactItems=transaction)
        except Exception as error:
            if _error_code(error) in {
                "ConditionalCheckFailedException",
                "TransactionCanceledException",
            }:
                completed = self.get_completed_request(
                    chat_id=chat_id, request_id=request_id
                )
                if completed is not None:
                    return completed
                # The session condition can fail if it was deleted or changed.
                self.get_session(chat_id=chat_id, owner_sub=owner_sub)
                detail = _transaction_failure_detail(error)
                raise UpstreamError(
                    f"The chat messages could not be saved ({detail})"
                ) from error
            detail = _transaction_failure_detail(error)
            raise UpstreamError(
                f"The chat messages could not be saved ({detail})"
            ) from error

        return {
            "chatId": chat_id,
            "userMessage": self._public_message(user_message),
            "assistantMessage": self._public_message(assistant_message),
        }

    @staticmethod
    def _public_message(message: dict[str, Any]) -> dict[str, Any]:
        return {
            "messageId": message.get("messageId", ""),
            "role": message.get("role", ""),
            "content": message.get("content", ""),
            "createdAt": message.get("createdAt", ""),
        }
