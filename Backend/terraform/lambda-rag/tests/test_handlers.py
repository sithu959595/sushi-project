from __future__ import annotations

from datetime import datetime, timezone
from dataclasses import replace
import json
import unittest
import uuid

from rag_app.chat_handler import (
    LOGGED_CHUNK_CONTENT_MAX_LENGTH,
    NO_RELEVANT_MENU_ANSWER,
    ChatService,
    create_handler as create_chat_handler,
)
from rag_app.errors import UpstreamError
from rag_app.index_handler import (
    _new_vector_client,
    create_handler as create_index_handler,
)
from rag_app.secrets import RagCredentials
from rag_app.settings import Settings


def settings():
    return Settings(
        stage="staging",
        menu_table_name="menu-table",
        chat_table_name="chat-table",
        credentials_secret_arn="arn:secret",
        weaviate_url="https://weaviate.example",
        weaviate_collection="MenuChunksStaging",
        openai_chat_model="configured-model",
        cors_allowed_origin="https://frontend.example",
    )


class FakeIndexService:
    def __init__(self):
        self.refreshed = []
        self.rebuilds = 0

    def refresh_dish(self, dish_id):
        if dish_id == "fail":
            raise RuntimeError("failed")
        self.refreshed.append(dish_id)
        return {"dishId": dish_id}

    def rebuild(self):
        self.rebuilds += 1
        return {"rebuild": True, "dishCount": 2, "chunkCount": 3}


class IndexHandlerTests(unittest.TestCase):
    def test_sqs_returns_only_failed_record_ids(self):
        service = FakeIndexService()
        handler = create_index_handler(service=service)
        result = handler(
            {
                "Records": [
                    {"messageId": "one", "body": '{"dishId":"akami"}'},
                    {"messageId": "two", "body": '{"dishId":"fail"}'},
                    {"messageId": "three", "body": "not-json"},
                ]
            },
            None,
        )

        self.assertEqual(service.refreshed, ["akami"])
        self.assertEqual(
            result,
            {
                "batchItemFailures": [
                    {"itemIdentifier": "two"},
                    {"itemIdentifier": "three"},
                ]
            },
        )

    def test_direct_rebuild(self):
        service = FakeIndexService()
        result = create_index_handler(service=service)({"rebuild": True}, None)
        self.assertEqual(result["chunkCount"], 3)
        self.assertEqual(service.rebuilds, 1)

    def test_rotated_cached_credentials_rebuild_client_between_invocations(self):
        credentials = [
            RagCredentials("openai-1", "weaviate-1", "cohere-1"),
            RagCredentials("openai-2", "weaviate-2", "cohere-2"),
        ]

        class Provider:
            calls = 0

            def get(self):
                value = credentials[min(self.calls, 1)]
                self.calls += 1
                return value

        class Menu:
            def load_dishes(self):
                return [{"id": "akami", "description": "Tuna"}]

        used_keys = []

        class Vector:
            def __init__(self, key):
                self.key = key

            def replace_dish(self, _dish):
                used_keys.append(self.key)
                return 1

        handler = create_index_handler(
            settings=settings(),
            menu_repository=Menu(),
            secret_provider=Provider(),
            vector_client_factory=lambda _settings, value: Vector(
                value.weaviate_api_key
            ),
        )

        handler({"dishId": "akami"}, None)
        handler({"dishId": "akami"}, None)

        self.assertEqual(used_keys, ["weaviate-1", "weaviate-2"])

    def test_vector_client_uses_secret_url_when_environment_url_is_empty(self):
        value = _new_vector_client(
            replace(settings(), weaviate_url=""),
            RagCredentials(
                "openai",
                "weaviate",
                "cohere",
                "https://secret-cluster.example",
            ),
        )
        self.assertEqual(value.base_url, "https://secret-cluster.example")


class FakeChatRepository:
    def __init__(self):
        self.saved = None

    def create_session(self, **values):
        return {
            "chatId": values["chat_id"],
            "createdAt": values["created_at"],
        }

    def get_session(self, **_values):
        return {"chatId": "chat-1", "createdAt": "earlier"}

    def get_history(self, **_values):
        return {
            "chatId": "chat-1",
            "createdAt": "earlier",
            "messages": [],
        }

    def validate_request_id(self, value):
        return value

    def get_completed_request(self, **_values):
        return None

    def list_messages(self, **_values):
        return [
            {
                "messageId": "prior",
                "role": "user",
                "content": "Prior question",
                "createdAt": "earlier",
            }
        ]

    def save_exchange(self, **values):
        self.saved = values
        return {
            "chatId": values["chat_id"],
            "userMessage": values["user_message"],
            "assistantMessage": values["assistant_message"],
        }


class FakeMenuRepository:
    def __init__(self):
        self.calls = 0

    def load_dishes(self):
        self.calls += 1
        return [
            {
                "id": "akami",
                "name": "Akami",
                "availability": "out",
                "allergens": ["fish", "wheat"],
                "fullDishInfo": "Normally offered nightly.",
                "image": {"key": "dishes/akami/internal-key.webp"},
            }
        ]


class FakeVectorClient:
    def retrieve(self, query, *, limit):
        return [
            {
                "dish_id": "akami",
                "availability": "available",
                "allergens": [],
                "content": "stale chunk",
                "rerank_score": 0.1,
            }
        ]


class FakeOpenAIClient:
    def __init__(self):
        self.call = None

    def generate(self, **values):
        self.call = values
        return "Akami is currently out."


class CapturingInfoLogger:
    def __init__(self):
        self.entries = []

    def info(self, *values):
        self.entries.append(values)


class ChatServiceTests(unittest.TestCase):
    def test_message_uses_fresh_dynamodb_dish_not_stale_vector_metadata(self):
        chat_repository = FakeChatRepository()
        menu_repository = FakeMenuRepository()
        openai = FakeOpenAIClient()
        service = ChatService(
            settings=settings(),
            menu_repository=menu_repository,
            chat_repository=chat_repository,
            vector_client=FakeVectorClient(),
            openai_client=openai,
            clock=lambda: datetime(2026, 7, 30, tzinfo=timezone.utc),
            uuid_factory=lambda: uuid.UUID("00000000-0000-4000-8000-000000000001"),
        )

        result = service.send_message(
            owner_sub="owner",
            chat_id="chat-1",
            message="Can I order akami?",
            request_id="request-1",
        )

        context = openai.call["context_dishes"]
        self.assertEqual(context[0]["availability"], "out")
        self.assertEqual(context[0]["allergens"], ["fish", "wheat"])
        self.assertNotIn("image", context[0])
        self.assertNotIn("stale chunk", json.dumps(context))
        self.assertEqual(result["assistantMessage"]["role"], "assistant")
        self.assertEqual(menu_repository.calls, 1)

    def test_selected_chunk_logging_is_disabled_by_default(self):
        logger = CapturingInfoLogger()
        service = ChatService(
            settings=settings(),
            menu_repository=FakeMenuRepository(),
            chat_repository=FakeChatRepository(),
            vector_client=FakeVectorClient(),
            openai_client=FakeOpenAIClient(),
            logger=logger,
        )

        service.send_message(
            owner_sub="owner",
            chat_id="chat-1",
            message="Can I order akami?",
            request_id="request-1",
        )

        self.assertEqual(logger.entries, [])

    def test_low_rerank_score_skips_openai_and_saves_no_match_answer(self):
        class LowScoreVectorClient:
            def retrieve(self, _query, *, limit):
                return [{"dish_id": "akami", "rerank_score": 0.09}]

        chat_repository = FakeChatRepository()
        openai = FakeOpenAIClient()
        service = ChatService(
            settings=settings(),
            menu_repository=FakeMenuRepository(),
            chat_repository=chat_repository,
            vector_client=LowScoreVectorClient(),
            openai_client=openai,
        )

        result = service.send_message(
            owner_sub="owner",
            chat_id="chat-1",
            message="What is tomorrow's weather?",
            request_id="request-1",
        )

        self.assertIsNone(openai.call)
        self.assertEqual(
            result["assistantMessage"]["content"],
            NO_RELEVANT_MENU_ANSWER,
        )
        self.assertEqual(
            chat_repository.saved["assistant_message"]["content"],
            NO_RELEVANT_MENU_ANSWER,
        )

    def test_selection_ignores_stale_low_and_duplicate_candidates(self):
        class SelectionMenuRepository:
            def load_dishes(self):
                return [
                    {"id": "akami", "name": "Akami"},
                    {"id": "avocado", "name": "Avocado maki"},
                ]

        class SelectionVectorClient:
            def retrieve(self, _query, *, limit):
                return [
                    {"dish_id": "deleted", "rerank_score": 0.99},
                    {"dish_id": "akami", "rerank_score": 0.8},
                    {"dish_id": "akami", "rerank_score": 0.7},
                    {"dish_id": "below", "rerank_score": 0.09},
                    {"dish_id": "avocado", "rerank_score": 0.1},
                ]

        openai = FakeOpenAIClient()
        service = ChatService(
            settings=replace(settings(), retrieval_dish_limit=2),
            menu_repository=SelectionMenuRepository(),
            chat_repository=FakeChatRepository(),
            vector_client=SelectionVectorClient(),
            openai_client=openai,
        )

        service.send_message(
            owner_sub="owner",
            chat_id="chat-1",
            message="What can I order?",
            request_id="request-1",
        )

        self.assertEqual(
            [dish["id"] for dish in openai.call["context_dishes"]],
            ["akami", "avocado"],
        )

    def test_selected_chunk_log_contains_only_accepted_bounded_previews(self):
        class SelectionMenuRepository:
            def load_dishes(self):
                return [
                    {"id": "akami", "name": "Akami"},
                    {"id": "avocado", "name": "Avocado maki"},
                ]

        selected_content = "x" * (
            LOGGED_CHUNK_CONTENT_MAX_LENGTH + 25
        ) + "credential-secret"

        class SelectionVectorClient:
            def retrieve(self, _query, *, limit):
                return [
                    {
                        "dish_id": "deleted",
                        "chunk_index": 8,
                        "rerank_score": 0.99,
                        "content": "deleted-sentinel",
                    },
                    {
                        "dish_id": "akami",
                        "chunk_index": 4,
                        "rerank_score": 0.8,
                        "content": selected_content,
                        "api_key": "must-never-be-serialized",
                    },
                    {
                        "dish_id": "akami",
                        "chunk_index": 5,
                        "rerank_score": 0.7,
                        "content": "duplicate-sentinel",
                    },
                    {
                        "dish_id": "avocado",
                        "chunk_index": 1,
                        "rerank_score": 0.09,
                        "content": "low-score-sentinel",
                    },
                    {
                        "dish_id": "avocado",
                        "chunk_index": 2,
                        "rerank_score": 0.6,
                        "content": "Avocado chunk\nprivate details",
                    },
                ]

        logger = CapturingInfoLogger()
        service = ChatService(
            settings=replace(
                settings(),
                retrieval_dish_limit=2,
                log_selected_chunks=True,
                log_user_questions=True,
            ),
            menu_repository=SelectionMenuRepository(),
            chat_repository=FakeChatRepository(),
            vector_client=SelectionVectorClient(),
            openai_client=FakeOpenAIClient(),
            logger=logger,
        )

        service.send_message(
            owner_sub="owner-secret",
            chat_id="chat-secret",
            message="USER-QUESTION-SECRET",
            request_id="request-secret",
        )

        self.assertEqual(len(logger.entries), 1)
        template, serialized = logger.entries[0]
        self.assertEqual(template, "RAG_SELECTED_CHUNKS %s")
        payload = json.loads(serialized)
        self.assertEqual(payload["retrievedCandidateCount"], 5)
        self.assertEqual(payload["selectedChunkCount"], 2)
        self.assertEqual(payload["minimumRerankScore"], 0.1)
        self.assertEqual(payload["question"], "USER-QUESTION-SECRET")

        chunks = payload["selectedChunks"]
        self.assertEqual([chunk["rank"] for chunk in chunks], [2, 5])
        self.assertEqual(
            [chunk["dishId"] for chunk in chunks], ["akami", "avocado"]
        )
        self.assertEqual([chunk["chunkIndex"] for chunk in chunks], [4, 2])
        self.assertEqual(len(chunks[0]["contentPreview"]), 500)
        self.assertEqual(chunks[0]["contentLength"], len(selected_content))
        self.assertTrue(chunks[0]["contentTruncated"])
        self.assertEqual(
            chunks[1]["contentPreview"], "Avocado chunk\nprivate details"
        )
        self.assertFalse(chunks[1]["contentTruncated"])

        for excluded in (
            "credential-secret",
            "must-never-be-serialized",
            "deleted-sentinel",
            "duplicate-sentinel",
            "low-score-sentinel",
            "Prior question",
            "owner-secret",
            "chat-secret",
            "request-secret",
        ):
            self.assertNotIn(excluded, serialized)

    def test_retrieved_candidate_log_exposes_bounded_chunks_and_outcomes(self):
        class CandidateMenuRepository:
            def load_dishes(self):
                return [
                    {"id": "akami", "name": "Akami"},
                    {"id": "avocado", "name": "Avocado maki"},
                    {"id": "salmon", "name": "Salmon nigiri"},
                ]

        long_rejected_content = "r" * (
            LOGGED_CHUNK_CONTENT_MAX_LENGTH + 25
        ) + "hidden-tail"

        class CandidateVectorClient:
            def retrieve(self, _query, *, limit):
                return [
                    {
                        "dish_id": "deleted",
                        "chunk_index": 8,
                        "rerank_score": 0.99,
                        "content": long_rejected_content,
                        "api_key": "must-never-be-serialized",
                    },
                    {
                        "dish_id": None,
                        "chunk_index": 7,
                        "rerank_score": 0.98,
                        "content": "invalid-id-visible",
                    },
                    {
                        "dish_id": "akami",
                        "chunk_index": 4,
                        "rerank_score": 0.8,
                        "content": "selected-akami-visible",
                    },
                    {
                        "dish_id": "akami",
                        "chunk_index": 5,
                        "rerank_score": 0.7,
                        "content": "duplicate-visible",
                    },
                    {
                        "dish_id": "avocado",
                        "chunk_index": 1,
                        "rerank_score": 0.09,
                        "content": "low-score-visible",
                    },
                    {
                        "dish_id": "avocado",
                        "chunk_index": 2,
                        "rerank_score": 0.6,
                        "content": "selected-avocado-visible",
                    },
                    {
                        "dish_id": "salmon",
                        "chunk_index": 3,
                        "rerank_score": 0.95,
                        "content": "after-limit-visible",
                    },
                ]

        logger = CapturingInfoLogger()
        openai = FakeOpenAIClient()
        service = ChatService(
            settings=replace(
                settings(),
                retrieval_dish_limit=2,
                log_retrieved_candidates=True,
                log_user_questions=True,
            ),
            menu_repository=CandidateMenuRepository(),
            chat_repository=FakeChatRepository(),
            vector_client=CandidateVectorClient(),
            openai_client=openai,
            logger=logger,
        )

        service.send_message(
            owner_sub="owner-secret",
            chat_id="chat-secret",
            message="USER-QUESTION-SECRET",
            request_id="request-secret",
        )

        self.assertEqual(len(logger.entries), 1)
        template, serialized = logger.entries[0]
        self.assertEqual(template, "RAG_RETRIEVED_CANDIDATES %s")
        payload = json.loads(serialized)
        self.assertEqual(payload["retrievedCandidateCount"], 7)
        self.assertEqual(payload["selectedChunkCount"], 2)
        self.assertEqual(payload["minimumRerankScore"], 0.1)
        self.assertEqual(payload["question"], "USER-QUESTION-SECRET")

        candidates = payload["candidates"]
        self.assertEqual([item["rank"] for item in candidates], list(range(1, 8)))
        self.assertEqual(
            [item["selected"] for item in candidates],
            [False, False, True, False, False, True, False],
        )
        self.assertEqual(
            [item["rejectionReason"] for item in candidates],
            [
                "dishNotInCurrentMenu",
                "invalidDishId",
                None,
                "duplicateDish",
                "belowMinimumRerankScore",
                None,
                "contextDishLimitReached",
            ],
        )
        self.assertEqual(
            [dish["id"] for dish in openai.call["context_dishes"]],
            ["akami", "avocado"],
        )
        self.assertEqual(
            len(candidates[0]["contentPreview"]),
            LOGGED_CHUNK_CONTENT_MAX_LENGTH,
        )
        self.assertTrue(candidates[0]["contentTruncated"])
        self.assertIn("duplicate-visible", serialized)
        self.assertIn("low-score-visible", serialized)

        for excluded in (
            "hidden-tail",
            "must-never-be-serialized",
            "Prior question",
            "owner-secret",
            "chat-secret",
            "request-secret",
            "Akami is currently out.",
        ):
            self.assertNotIn(excluded, serialized)

    def test_retrieved_candidate_log_shows_candidates_when_none_are_selected(self):
        class NoMatchVectorClient:
            def retrieve(self, _query, *, limit):
                return [
                    {
                        "dish_id": "akami",
                        "chunk_index": 0,
                        "rerank_score": 0.09,
                        "content": "below threshold",
                    },
                    {
                        "dish_id": "deleted",
                        "chunk_index": 1,
                        "rerank_score": 0.8,
                        "content": "no longer in the menu",
                    },
                ]

        logger = CapturingInfoLogger()
        openai = FakeOpenAIClient()
        service = ChatService(
            settings=replace(settings(), log_retrieved_candidates=True),
            menu_repository=FakeMenuRepository(),
            chat_repository=FakeChatRepository(),
            vector_client=NoMatchVectorClient(),
            openai_client=openai,
            logger=logger,
        )

        service.send_message(
            owner_sub="owner",
            chat_id="chat-1",
            message="What can I order?",
            request_id="request-1",
        )

        self.assertIsNone(openai.call)
        template, serialized = logger.entries[0]
        self.assertEqual(template, "RAG_RETRIEVED_CANDIDATES %s")
        payload = json.loads(serialized)
        self.assertNotIn("question", payload)
        self.assertEqual(payload["retrievedCandidateCount"], 2)
        self.assertEqual(payload["selectedChunkCount"], 0)
        self.assertEqual(
            [item["rejectionReason"] for item in payload["candidates"]],
            ["belowMinimumRerankScore", "dishNotInCurrentMenu"],
        )
        self.assertIn("below threshold", serialized)
        self.assertIn("no longer in the menu", serialized)

    def test_openai_context_log_matches_exact_dishes_sent_to_openai(self):
        logger = CapturingInfoLogger()
        openai = FakeOpenAIClient()
        service = ChatService(
            settings=replace(
                settings(),
                log_openai_context_dishes=True,
                log_user_questions=True,
            ),
            menu_repository=FakeMenuRepository(),
            chat_repository=FakeChatRepository(),
            vector_client=FakeVectorClient(),
            openai_client=openai,
            logger=logger,
        )

        service.send_message(
            owner_sub="owner-secret",
            chat_id="chat-secret",
            message="USER-QUESTION-SECRET",
            request_id="request-secret",
        )

        self.assertEqual(len(logger.entries), 1)
        template, serialized = logger.entries[0]
        self.assertEqual(template, "OPENAI_CONTEXT_DISHES %s")
        payload = json.loads(serialized)
        self.assertEqual(payload["question"], "USER-QUESTION-SECRET")
        self.assertTrue(payload["openaiRequestSent"])
        self.assertEqual(payload["contextDishCount"], 1)
        self.assertEqual(
            payload["contextDishes"], openai.call["context_dishes"]
        )
        self.assertEqual(payload["contextDishes"][0]["id"], "akami")
        self.assertEqual(payload["contextDishes"][0]["availability"], "out")
        self.assertEqual(
            payload["contextDishes"][0]["fullDishInfo"],
            "Normally offered nightly.",
        )
        self.assertNotIn("image", payload["contextDishes"][0])
        for excluded in (
            "stale chunk",
            "Prior question",
            "owner-secret",
            "chat-secret",
            "request-secret",
            "credential-secret",
            "Akami is currently out.",
        ):
            self.assertNotIn(excluded, serialized)

    def test_get_history_is_bounded_by_settings(self):
        class HistoryRepository(FakeChatRepository):
            def __init__(self):
                super().__init__()
                self.history_args = None

            def get_history(self, **values):
                self.history_args = values
                return {
                    "chatId": values["chat_id"],
                    "createdAt": "earlier",
                    "messages": [],
                }

        repository = HistoryRepository()
        service = ChatService(
            settings=settings(),
            menu_repository=FakeMenuRepository(),
            chat_repository=repository,
            vector_client=FakeVectorClient(),
            openai_client=FakeOpenAIClient(),
        )

        service.get_history("owner", "chat-1")

        self.assertEqual(
            repository.history_args["limit"], settings().chat_history_limit
        )


class FakeChatService:
    def __init__(self):
        self.settings = settings()
        self.calls = []

    def create_session(self, owner_sub):
        self.calls.append(("create", owner_sub))
        return {
            "chatId": "server-chat-id",
            "createdAt": "2026-07-30T00:00:00.000Z",
            "messages": [],
        }

    def get_history(self, owner_sub, chat_id):
        self.calls.append(("get", owner_sub, chat_id))
        return {
            "chatId": chat_id,
            "createdAt": "2026-07-30T00:00:00.000Z",
            "messages": [
                {
                    "messageId": "m-1",
                    "role": "user",
                    "content": "Hello",
                    "createdAt": "2026-07-30T00:00:01.000Z",
                }
            ],
        }

    def send_message(self, **values):
        self.calls.append(("send", values))
        return {
            "chatId": values["chat_id"],
            "userMessage": {
                "messageId": "u-1",
                "role": "user",
                "content": values["message"],
                "createdAt": "now",
            },
            "assistantMessage": {
                "messageId": "a-1",
                "role": "assistant",
                "content": "Answer",
                "createdAt": "now",
            },
        }


def api_event(method, resource, *, chat_id=None, body=None, sub="owner-1"):
    event = {
        "httpMethod": method,
        "resource": resource,
        "requestContext": {"authorizer": {"claims": {"sub": sub}}},
    }
    if chat_id is not None:
        event["pathParameters"] = {"chatId": chat_id}
    if body is not None:
        event["body"] = json.dumps(body)
    return event


class ChatHandlerContractTests(unittest.TestCase):
    def setUp(self):
        self.service = FakeChatService()
        self.handler = create_chat_handler(service=self.service)

    def test_create_session_contract(self):
        response = self.handler(api_event("POST", "/chat/sessions"), None)
        self.assertEqual(response["statusCode"], 201)
        self.assertEqual(
            json.loads(response["body"]),
            {
                "chatId": "server-chat-id",
                "createdAt": "2026-07-30T00:00:00.000Z",
                "messages": [],
            },
        )

    def test_get_history_contract(self):
        response = self.handler(
            api_event(
                "GET", "/chat/sessions/{chatId}", chat_id="server-chat-id"
            ),
            None,
        )
        payload = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(payload["messages"][0]["messageId"], "m-1")

    def test_post_message_contract(self):
        response = self.handler(
            api_event(
                "POST",
                "/chat/sessions/{chatId}/messages",
                chat_id="server-chat-id",
                body={"message": "Hello", "requestId": "request-1"},
            ),
            None,
        )
        payload = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(payload["chatId"], "server-chat-id")
        self.assertEqual(payload["userMessage"]["role"], "user")
        self.assertEqual(payload["assistantMessage"]["role"], "assistant")

    def test_missing_cognito_sub_is_rejected(self):
        response = self.handler(
            api_event("POST", "/chat/sessions", sub=""), None
        )
        self.assertEqual(response["statusCode"], 401)
        self.assertEqual(self.service.calls, [])

    def test_upstream_failure_logs_only_the_sanitized_reason(self):
        class FailingService(FakeChatService):
            def send_message(self, **_values):
                raise UpstreamError("The chat messages could not be saved")

        class CapturingLogger:
            def __init__(self):
                self.entry = None

            def error(self, *values):
                self.entry = values

        logger = CapturingLogger()
        handler = create_chat_handler(service=FailingService(), logger=logger)

        response = handler(
            api_event(
                "POST",
                "/chat/sessions/{chatId}/messages",
                chat_id="server-chat-id",
                body={"message": "Hello", "requestId": "request-1"},
            ),
            None,
        )

        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(
            logger.entry[0],
            "Chat request failed errorType=%s reason=%s requestId=%s",
        )
        self.assertEqual(
            logger.entry[1:],
            (
                "UpstreamError",
                "The chat messages could not be saved",
                None,
            ),
        )

    def test_rotated_credentials_rebuild_chat_clients(self):
        values = [
            RagCredentials("openai-1", "weaviate-1", "cohere-1"),
            RagCredentials("openai-2", "weaviate-2", "cohere-2"),
        ]

        class Provider:
            calls = 0

            def get(self):
                value = values[min(self.calls, 1)]
                self.calls += 1
                return value

        vector_keys = []
        openai_keys = []
        handler = create_chat_handler(
            settings=settings(),
            menu_repository=FakeMenuRepository(),
            chat_repository=FakeChatRepository(),
            secret_provider=Provider(),
            vector_client_factory=lambda _settings, credentials: (
                vector_keys.append(credentials.weaviate_api_key)
                or FakeVectorClient()
            ),
            openai_client_factory=lambda _settings, credentials: (
                openai_keys.append(credentials.openai_api_key)
                or FakeOpenAIClient()
            ),
            uuid_factory=lambda: uuid.UUID(
                "00000000-0000-4000-8000-000000000002"
            ),
        )

        handler(api_event("POST", "/chat/sessions"), None)
        handler(api_event("POST", "/chat/sessions"), None)

        self.assertEqual(vector_keys, ["weaviate-1", "weaviate-2"])
        self.assertEqual(openai_keys, ["openai-1", "openai-2"])


if __name__ == "__main__":
    unittest.main()
