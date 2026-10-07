"""Runtime configuration loaded from Lambda environment variables."""

from __future__ import annotations

from dataclasses import dataclass
import math
import os
import re
from typing import Mapping
from urllib.parse import urlsplit

from .errors import ConfigurationError


_COLLECTION_PART_PATTERN = re.compile(r"[^A-Za-z0-9]+")
_COLLECTION_PATTERN = re.compile(r"^[A-Z][A-Za-z0-9_]*$")


def _required(env: Mapping[str, str], name: str) -> str:
    value = env.get(name, "").strip()
    if not value:
        raise ConfigurationError(f"{name} is required")
    return value


def _first_value(
    env: Mapping[str, str], names: tuple[str, ...], default: str = ""
) -> str:
    for name in names:
        value = env.get(name, "").strip()
        if value:
            return value
    return default


def _positive_int(
    env: Mapping[str, str],
    names: str | tuple[str, ...],
    default: int,
    *,
    minimum: int = 1,
    maximum: int | None = None,
) -> int:
    candidates = (names,) if isinstance(names, str) else names
    name = candidates[0]
    raw = _first_value(env, candidates)
    try:
        value = int(raw) if raw else default
    except ValueError as error:
        raise ConfigurationError(f"{name} must be an integer") from error
    if value < minimum or (maximum is not None and value > maximum):
        suffix = f" through {maximum}" if maximum is not None else " or greater"
        raise ConfigurationError(f"{name} must be {minimum}{suffix}")
    return value


def _bounded_float(
    env: Mapping[str, str],
    name: str,
    default: float,
    *,
    minimum: float,
    maximum: float,
) -> float:
    raw = env.get(name, "").strip()
    try:
        value = float(raw) if raw else default
    except ValueError as error:
        raise ConfigurationError(f"{name} must be a number") from error
    if not math.isfinite(value) or value < minimum or value > maximum:
        raise ConfigurationError(
            f"{name} must be between {minimum} and {maximum}"
        )
    return value


def _boolean(
    env: Mapping[str, str],
    name: str,
    default: bool,
) -> bool:
    raw = env.get(name, "").strip().lower()
    if not raw:
        return default
    if raw == "true":
        return True
    if raw == "false":
        return False
    raise ConfigurationError(f"{name} must be true or false")


def _collection_part(value: str, *, field_name: str) -> str:
    words = [part for part in _COLLECTION_PART_PATTERN.split(value) if part]
    if not words:
        raise ConfigurationError(f"{field_name} must contain a letter or number")
    result = "".join(word[:1].upper() + word[1:] for word in words)
    if result[0].isdigit():
        result = f"S{result}"
    return result


def build_collection_name(prefix: str, stage: str) -> str:
    """Build a valid, stage-isolated Weaviate collection name."""

    collection = (
        _collection_part(prefix, field_name="WEAVIATE_COLLECTION_PREFIX")
        + _collection_part(stage, field_name="STAGE")
    )
    if len(collection) > 200 or not _COLLECTION_PATTERN.fullmatch(collection):
        raise ConfigurationError("The derived Weaviate collection name is invalid")
    return collection


def validate_https_url(value: str, *, field_name: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ConfigurationError(f"{field_name} must be an HTTPS URL")
    return value.rstrip("/")


@dataclass(frozen=True)
class Settings:
    stage: str
    menu_table_name: str
    chat_table_name: str
    credentials_secret_arn: str
    weaviate_url: str
    weaviate_collection: str
    openai_chat_model: str
    cors_allowed_origin: str = "*"
    chat_ttl_days: int = 30
    retrieval_candidate_limit: int = 15
    retrieval_dish_limit: int = 3
    retrieval_min_rerank_score: float = 0.1
    chat_history_limit: int = 12
    openai_max_tokens: int = 500
    http_timeout_seconds: int = 20
    secret_cache_seconds: int = 300
    log_selected_chunks: bool = False
    log_retrieved_candidates: bool = False
    log_openai_context_dishes: bool = False
    log_user_questions: bool = False

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        values = os.environ if env is None else env
        stage = _required(values, "STAGE")
        configured_collection = values.get("WEAVIATE_COLLECTION", "").strip()
        if configured_collection:
            if (
                len(configured_collection) > 200
                or not _COLLECTION_PATTERN.fullmatch(configured_collection)
            ):
                raise ConfigurationError("WEAVIATE_COLLECTION is invalid")
            collection_name = configured_collection
        else:
            collection_prefix = values.get(
                "WEAVIATE_COLLECTION_PREFIX", "MenuChunks"
            ).strip()
            if not collection_prefix:
                raise ConfigurationError(
                    "WEAVIATE_COLLECTION_PREFIX cannot be empty"
                )
            collection_name = build_collection_name(collection_prefix, stage)

        raw_weaviate_url = values.get("WEAVIATE_URL", "").strip()
        weaviate_url = (
            validate_https_url(raw_weaviate_url, field_name="WEAVIATE_URL")
            if raw_weaviate_url
            else ""
        )

        settings = cls(
            stage=stage,
            menu_table_name=_required(values, "DISHES_TABLE"),
            chat_table_name=_required(values, "CHAT_HISTORY_TABLE"),
            credentials_secret_arn=_required(
                values, "RAG_CREDENTIALS_SECRET_ARN"
            ),
            weaviate_url=weaviate_url,
            weaviate_collection=collection_name,
            openai_chat_model=_required(values, "OPENAI_CHAT_MODEL"),
            cors_allowed_origin=values.get("CORS_ALLOWED_ORIGIN", "*").strip()
            or "*",
            chat_ttl_days=_positive_int(
                values,
                ("CHAT_RETENTION_DAYS", "CHAT_TTL_DAYS"),
                30,
                maximum=365,
            ),
            retrieval_candidate_limit=_positive_int(
                values, "RAG_CANDIDATE_LIMIT", 15, maximum=50
            ),
            retrieval_dish_limit=_positive_int(
                values,
                ("RAG_CONTEXT_DISH_LIMIT", "RAG_DISH_LIMIT"),
                3,
                maximum=20,
            ),
            retrieval_min_rerank_score=_bounded_float(
                values,
                "RAG_MIN_RERANK_SCORE",
                0.1,
                minimum=0.0,
                maximum=1.0,
            ),
            chat_history_limit=_positive_int(
                values, "CHAT_HISTORY_LIMIT", 12, maximum=50
            ),
            openai_max_tokens=_positive_int(
                values, "OPENAI_MAX_TOKENS", 500, maximum=4000
            ),
            http_timeout_seconds=_positive_int(
                values, "RAG_HTTP_TIMEOUT_SECONDS", 20, maximum=60
            ),
            secret_cache_seconds=_positive_int(
                values, "SECRET_CACHE_SECONDS", 300, maximum=3600
            ),
            log_selected_chunks=_boolean(
                values, "RAG_LOG_SELECTED_CHUNKS", False
            ),
            log_retrieved_candidates=_boolean(
                values, "RAG_LOG_RETRIEVED_CANDIDATES", False
            ),
            log_openai_context_dishes=_boolean(
                values, "RAG_LOG_OPENAI_CONTEXT_DISHES", False
            ),
            log_user_questions=_boolean(
                values, "RAG_LOG_USER_QUESTIONS", False
            ),
        )
        if settings.retrieval_candidate_limit < settings.retrieval_dish_limit:
            raise ConfigurationError(
                "RAG_CANDIDATE_LIMIT must be at least RAG_DISH_LIMIT"
            )
        return settings
