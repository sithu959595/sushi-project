"""Cached Secrets Manager JSON retrieval."""

from __future__ import annotations

from dataclasses import dataclass
import base64
import json
import threading
import time
from typing import Any, Callable

from .errors import ConfigurationError, UpstreamError


@dataclass(frozen=True)
class RagCredentials:
    openai_api_key: str
    weaviate_api_key: str
    cohere_api_key: str
    weaviate_url: str | None = None

    @classmethod
    def from_mapping(cls, value: dict[str, Any]) -> "RagCredentials":
        def read(name: str) -> str:
            item = value.get(name)
            if not isinstance(item, str) or not item.strip():
                raise ConfigurationError(
                    f"The RAG credentials secret is missing {name}"
                )
            return item.strip()

        return cls(
            openai_api_key=read("OPENAI_API_KEY"),
            weaviate_api_key=read("WEAVIATE_API_KEY"),
            cohere_api_key=read("COHERE_API_KEY"),
            weaviate_url=(
                value["WEAVIATE_URL"].strip()
                if isinstance(value.get("WEAVIATE_URL"), str)
                and value["WEAVIATE_URL"].strip()
                else None
            ),
        )


class SecretsManagerProvider:
    """Read and cache one credentials document for a warm Lambda container."""

    def __init__(
        self,
        secret_id: str,
        *,
        client: Any | None = None,
        cache_seconds: int = 300,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not secret_id:
            raise ConfigurationError("A Secrets Manager secret ID is required")
        self._secret_id = secret_id
        self._client = client
        self._cache_seconds = cache_seconds
        self._clock = clock
        self._cached: RagCredentials | None = None
        self._expires_at = 0.0
        self._lock = threading.Lock()

    def _get_client(self) -> Any:
        if self._client is None:
            try:
                import boto3  # type: ignore
            except ImportError as error:  # pragma: no cover - Lambda supplies it
                raise ConfigurationError("boto3 is required in AWS Lambda") from error
            self._client = boto3.client("secretsmanager")
        return self._client

    def get(self, *, force_refresh: bool = False) -> RagCredentials:
        now = self._clock()
        if (
            not force_refresh
            and self._cached is not None
            and now < self._expires_at
        ):
            return self._cached

        with self._lock:
            now = self._clock()
            if (
                not force_refresh
                and self._cached is not None
                and now < self._expires_at
            ):
                return self._cached
            try:
                response = self._get_client().get_secret_value(
                    SecretId=self._secret_id
                )
                if isinstance(response.get("SecretString"), str):
                    raw = response["SecretString"]
                elif response.get("SecretBinary") is not None:
                    binary = response["SecretBinary"]
                    if isinstance(binary, str):
                        binary = base64.b64decode(binary)
                    raw = bytes(binary).decode("utf-8")
                else:
                    raise ValueError("Secret has no value")
                decoded = json.loads(raw)
                if not isinstance(decoded, dict):
                    raise ValueError("Secret is not a JSON object")
                credentials = RagCredentials.from_mapping(decoded)
            except ConfigurationError:
                raise
            except Exception as error:
                raise UpstreamError(
                    "The RAG credentials could not be loaded"
                ) from error

            self._cached = credentials
            self._expires_at = now + self._cache_seconds
            return credentials

    def clear(self) -> None:
        with self._lock:
            self._cached = None
            self._expires_at = 0.0
