"""Minimal Weaviate REST/GraphQL client for menu chunks."""

from __future__ import annotations

import json
import math
from typing import Any, Iterable
from urllib.parse import quote
import uuid

from .chunking import create_dish_chunks
from .errors import UpstreamError, ValidationError
from .http_json import JsonHttpTransport


_CHUNK_UUID_NAMESPACE = uuid.UUID("42baa5fc-12e0-53d8-9cee-58ac56d11f88")
_RERANK_TEXT_PROPERTY = "rerank_text"


class WeaviateClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        openai_api_key: str,
        cohere_api_key: str,
        collection_name: str,
        transport: Any | None = None,
        timeout_seconds: int = 20,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.collection_name = collection_name
        self.transport = transport or JsonHttpTransport(
            timeout_seconds=timeout_seconds
        )
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "X-OpenAI-Api-Key": openai_api_key,
            "X-Cohere-Api-Key": cohere_api_key,
        }
        self._ensured = False

    def _request(
        self, method: str, path: str, payload: Any | None = None
    ) -> Any:
        return self.transport.request(
            method,
            f"{self.base_url}{path}",
            headers=self.headers,
            payload=payload,
        )

    @staticmethod
    def _has_expected_vectorizer(schema: dict[str, Any]) -> bool:
        if schema.get("vectorizer") == "text2vec-openai":
            return True
        vector_config = schema.get("vectorConfig")
        if not isinstance(vector_config, dict):
            return False
        return any(
            isinstance(config, dict)
            and isinstance(config.get("vectorizer"), dict)
            and "text2vec-openai" in config["vectorizer"]
            for config in vector_config.values()
        )

    @staticmethod
    def _has_expected_reranker(schema: dict[str, Any]) -> bool:
        module_config = schema.get("moduleConfig")
        return isinstance(module_config, dict) and (
            "reranker-cohere" in module_config
        )

    @staticmethod
    def _has_expected_rerank_text_property(schema: dict[str, Any]) -> bool:
        properties = schema.get("properties")
        if not isinstance(properties, list):
            return False
        prop = next(
            (
                item
                for item in properties
                if isinstance(item, dict)
                and item.get("name") == _RERANK_TEXT_PROPERTY
            ),
            None,
        )
        if not isinstance(prop, dict) or prop.get("dataType") != ["text"]:
            return False
        module_config = prop.get("moduleConfig")
        vectorizer_config = (
            module_config.get("text2vec-openai")
            if isinstance(module_config, dict)
            else None
        )
        return (
            isinstance(vectorizer_config, dict)
            and vectorizer_config.get("skip") is True
            and vectorizer_config.get("vectorizePropertyName") is False
            and prop.get("indexSearchable") is False
            and prop.get("indexFilterable") is False
        )

    def ensure_collection(self) -> None:
        if self._ensured:
            return
        response = self._request("GET", "/v1/schema")
        classes = response.get("classes", []) if isinstance(response, dict) else []
        existing = next(
            (
                item
                for item in classes
                if isinstance(item, dict)
                and item.get("class") == self.collection_name
            ),
            None,
        )
        if existing is not None:
            if not self._has_expected_vectorizer(
                existing
            ) or not self._has_expected_reranker(existing):
                raise UpstreamError(
                    "The existing menu collection has incompatible modules"
                )
            if not self._has_expected_rerank_text_property(existing):
                raise UpstreamError(
                    "The existing menu collection requires a full rebuild"
                )
            self._ensured = True
            return

        schema = {
            "class": self.collection_name,
            "description": "Stage-isolated Snowfox menu RAG chunks",
            "vectorizer": "text2vec-openai",
            "moduleConfig": {
                "text2vec-openai": {"vectorizeClassName": False},
                "reranker-cohere": {},
            },
            "properties": [
                self._property("content", ["text"]),
                self._property(
                    "dish_id",
                    ["text"],
                    skip_vectorization=True,
                    tokenization="field",
                ),
                self._property("name", ["text"]),
                self._property("category", ["text"]),
                self._property("description", ["text"]),
                self._property("price", ["text"]),
                self._property("allergens", ["text[]"]),
                self._property("availability", ["text"]),
                # This composite is for Cohere only. Excluding it from both
                # vectorization and BM25 preserves the hybrid candidate pool.
                self._property(
                    _RERANK_TEXT_PROPERTY,
                    ["text"],
                    skip_vectorization=True,
                    index_filterable=False,
                    index_searchable=False,
                ),
                self._property("chunk_index", ["int"], skip_vectorization=True),
            ],
        }
        created = self._request("POST", "/v1/schema", schema)
        if not isinstance(created, dict):
            raise UpstreamError("Weaviate did not create the menu collection")
        self._ensured = True

    @staticmethod
    def _property(
        name: str,
        data_type: list[str],
        *,
        skip_vectorization: bool = False,
        tokenization: str | None = None,
        index_filterable: bool | None = None,
        index_searchable: bool | None = None,
    ) -> dict[str, Any]:
        result = {
            "name": name,
            "dataType": data_type,
            "moduleConfig": {
                "text2vec-openai": {
                    "skip": skip_vectorization,
                    "vectorizePropertyName": not skip_vectorization,
                }
            },
        }
        if tokenization is not None:
            result["tokenization"] = tokenization
        if index_filterable is not None:
            result["indexFilterable"] = index_filterable
        if index_searchable is not None:
            result["indexSearchable"] = index_searchable
        return result

    def deterministic_chunk_uuid(self, dish_id: str, chunk_index: int) -> str:
        value = f"{self.collection_name}:{dish_id}:{chunk_index}"
        return str(uuid.uuid5(_CHUNK_UUID_NAMESPACE, value))

    def _objects_for_chunks(
        self, chunks: Iterable[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        result = []
        for chunk in chunks:
            dish_id = chunk.get("dish_id")
            chunk_index = chunk.get("chunk_index")
            if not isinstance(dish_id, str) or not isinstance(chunk_index, int):
                raise ValidationError("A menu chunk has invalid identity fields")
            result.append(
                {
                    "class": self.collection_name,
                    "id": self.deterministic_chunk_uuid(
                        dish_id, chunk_index
                    ),
                    "properties": chunk,
                }
            )
        return result

    def add_chunks(self, chunks: Iterable[dict[str, Any]]) -> int:
        self.ensure_collection()
        objects = self._objects_for_chunks(chunks)
        if not objects:
            return 0
        response = self._request(
            "POST", "/v1/batch/objects", {"objects": objects}
        )
        if not isinstance(response, list):
            raise UpstreamError("Weaviate returned an invalid batch response")
        failed = [
            item
            for item in response
            if not isinstance(item, dict)
            or str(item.get("result", {}).get("status", "")).upper()
            not in {"SUCCESS", "PENDING"}
        ]
        if failed:
            raise UpstreamError("Weaviate rejected one or more menu chunks")
        return len(objects)

    def delete_dish(self, dish_id: str) -> int:
        dish_id = dish_id.strip() if isinstance(dish_id, str) else ""
        if not dish_id:
            raise ValidationError("dishId must be a non-empty string")
        self.ensure_collection()
        response = self._request(
            "DELETE",
            "/v1/batch/objects",
            {
                "match": {
                    "class": self.collection_name,
                    "where": {
                        "operator": "Equal",
                        "path": ["dish_id"],
                        "valueText": dish_id,
                    },
                },
                "output": "minimal",
                "dryRun": False,
            },
        )
        if not isinstance(response, dict) or not isinstance(
            response.get("results"), dict
        ):
            raise UpstreamError("Weaviate returned an invalid delete response")
        results = response["results"]
        failed = results.get("failed", 0)
        if not isinstance(failed, (int, float)) or isinstance(failed, bool):
            raise UpstreamError("Weaviate returned an invalid delete response")
        if failed > 0:
            raise UpstreamError("Weaviate could not delete every stale menu chunk")
        successful = results.get("successful", 0)
        if not isinstance(successful, (int, float)) or isinstance(
            successful, bool
        ):
            raise UpstreamError("Weaviate returned an invalid delete response")
        return int(successful)

    def replace_dish(self, dish: dict[str, Any]) -> int:
        # Build and validate first; a malformed update must not erase a
        # previously searchable dish.
        chunks = create_dish_chunks(dish)
        self.delete_dish(str(dish.get("id", "")))
        return self.add_chunks(chunks)

    def delete_collection(self) -> None:
        response = self._request("GET", "/v1/schema")
        classes = response.get("classes", []) if isinstance(response, dict) else []
        exists = any(
            isinstance(item, dict)
            and item.get("class") == self.collection_name
            for item in classes
        )
        if exists:
            encoded = quote(self.collection_name, safe="")
            self._request("DELETE", f"/v1/schema/{encoded}")
        self._ensured = False

    def rebuild(self, dishes: list[dict[str, Any]]) -> int:
        # Chunk before deleting the collection so invalid source data leaves
        # the existing index intact.
        all_chunks: list[dict[str, Any]] = []
        for dish in dishes:
            all_chunks.extend(create_dish_chunks(dish))
        self.delete_collection()
        self.ensure_collection()
        return self.add_chunks(all_chunks)

    def retrieve(
        self, query: str, *, limit: int = 15
    ) -> list[dict[str, Any]]:
        if not isinstance(query, str) or not query.strip():
            raise ValidationError("The search query cannot be empty")
        if limit < 1 or limit > 100:
            raise ValidationError("The retrieval limit is invalid")
        self.ensure_collection()
        query_literal = json.dumps(query.strip(), ensure_ascii=False)
        graph_query = f"""
query MenuChunkSearch {{
  Get {{
    {self.collection_name}(
      hybrid: {{query: {query_literal}, alpha: 0.5}}
      limit: {int(limit)}
    ) {{
      content
      dish_id
      name
      category
      description
      price
      allergens
      availability
      chunk_index
      _additional {{
        id
        rerank(property: "rerank_text", query: {query_literal}) {{ score }}
      }}
    }}
  }}
}}
""".strip()
        response = self._request(
            "POST", "/v1/graphql", {"query": graph_query}
        )
        if not isinstance(response, dict) or response.get("errors"):
            raise UpstreamError("Weaviate could not retrieve menu context")
        data = response.get("data")
        get_data = data.get("Get") if isinstance(data, dict) else None
        objects = (
            get_data.get(self.collection_name)
            if isinstance(get_data, dict)
            else None
        )
        if objects is None:
            return []
        if not isinstance(objects, list):
            raise UpstreamError("Weaviate returned invalid retrieval data")
        results: list[dict[str, Any]] = []
        for item in objects:
            if not isinstance(item, dict):
                continue
            additional = item.get("_additional")
            rerank = (
                additional.get("rerank")
                if isinstance(additional, dict)
                else None
            )
            rerank_item = (
                rerank[0]
                if isinstance(rerank, list) and rerank
                else rerank
            )
            score = (
                rerank_item.get("score")
                if isinstance(rerank_item, dict)
                else None
            )
            if (
                isinstance(score, bool)
                or not isinstance(score, (int, float))
                or not math.isfinite(score)
                or score < 0
                or score > 1
            ):
                raise UpstreamError(
                    "Weaviate returned an invalid rerank score"
                )
            result = {
                key: item.get(key)
                for key in (
                    "content",
                    "dish_id",
                    "name",
                    "category",
                    "description",
                    "price",
                    "allergens",
                    "availability",
                    "chunk_index",
                )
            }
            result["rerank_score"] = float(score)
            results.append(result)
        return results
