from __future__ import annotations

import json
import unittest

from rag_app.chunking import (
    chunk_text,
    create_dish_chunks,
    get_chunks_fixed_size_with_overlap,
    mixed_chunking,
)
from rag_app.errors import ConfigurationError
from rag_app.secrets import RagCredentials, SecretsManagerProvider
from rag_app.settings import Settings, build_collection_name, validate_https_url


class ChunkingTests(unittest.TestCase):
    def test_fixed_size_overlap_matches_the_original_helper(self):
        chunks = get_chunks_fixed_size_with_overlap(
            " ".join(f"w{index}" for index in range(10)),
            4,
            0.25,
        )

        self.assertEqual(
            chunks,
            [
                "w0 w1 w2 w3",
                "w3 w4 w5 w6 w7",
                "w7 w8 w9",
            ],
        )

    def test_oversized_paragraph_matches_the_original_dynamic_split(self):
        text = " ".join(f"word-{index}" for index in range(301))

        first = chunk_text(text, min_words=40, max_words=100)
        second = chunk_text(text, min_words=40, max_words=100)

        self.assertEqual(first, second)
        self.assertEqual([len(chunk.split()) for chunk in first], [76, 91, 91, 88])
        self.assertEqual(first[0].split()[61], first[1].split()[0])
        self.assertEqual(first[-1].split()[-1], "word-300")

    def test_original_overlap_can_exceed_the_requested_maximum(self):
        chunks = chunk_text(
            " ".join(f"w{index}" for index in range(190)),
            min_words=40,
            max_words=100,
        )

        self.assertEqual([len(chunk.split()) for chunk in chunks], [95, 114])

    def test_dynamic_split_avoids_a_tiny_final_tail(self):
        chunks = chunk_text(
            " ".join(f"w{index}" for index in range(151)),
            min_words=40,
            max_words=150,
        )

        self.assertEqual(len(chunks), 2)
        self.assertEqual([len(chunk.split()) for chunk in chunks], [76, 90])
        self.assertEqual(chunks[0].split()[61], chunks[1].split()[0])
        self.assertEqual(chunks[-1].split()[-1], "w150")
        self.assertNotEqual(chunks[0], chunks[1])

    def test_short_paragraphs_match_the_original_buffer_behavior(self):
        first = " ".join(f"first-{index}" for index in range(20))
        second = " ".join(f"second-{index}" for index in range(25))
        third = " ".join(f"third-{index}" for index in range(55))
        final = " ".join(f"final-{index}" for index in range(10))

        chunks = mixed_chunking(
            "\n\n".join([first, second, third, final]),
            min_length=40,
            max_length=100,
        )

        self.assertEqual([len(chunk.split()) for chunk in chunks], [44, 55, 10])
        self.assertEqual(chunks[0], first + second)
        self.assertEqual(chunks[1], third)
        self.assertEqual(chunks[2], final)

    def test_literal_space_counting_matches_the_original(self):
        chunks = mixed_chunking(
            "a  b\n\nc",
            min_length=3,
            max_length=10,
        )

        self.assertEqual(chunks, ["a  b", "c"])

    def test_crlf_input_matches_the_original_lf_only_split(self):
        first = " ".join(f"first-{index}" for index in range(40))
        second = " ".join(f"second-{index}" for index in range(40))

        chunks = mixed_chunking(
            f"{first}\r\n \r\n{second}",
            min_length=40,
            max_length=100,
        )

        self.assertEqual(chunks, [f"{first}\r\n \r\n{second}"])
        self.assertEqual(len(chunks[0].split()), 80)

    def test_oversized_emission_matches_the_original_retained_buffer(self):
        short = " ".join(f"short-{index}" for index in range(20))
        oversized = " ".join(f"large-{index}" for index in range(190))
        trailing = " ".join(f"trailing-{index}" for index in range(50))

        chunks = mixed_chunking(
            "\n\n".join([short, oversized, trailing]),
            min_length=40,
            max_length=100,
        )

        self.assertEqual([len(chunk.split()) for chunk in chunks], [70, 84, 83, 69])
        self.assertEqual(
            sum(chunk.split().count("short-0") for chunk in chunks),
            2,
        )
        self.assertEqual(chunks[-1], short + trailing)

    def test_dish_chunk_uses_full_info_unchanged_and_includes_metadata(self):
        full_dish_info = "  Avocado, rice, and nori.  "
        chunks = create_dish_chunks(
            {
                "id": "avocado-roll",
                "name": "Avocado roll",
                "category": "Maki",
                "description": "Avocado, rice, and nori.",
                "fullDishInfo": full_dish_info,
                "price": "9",
                "allergens": [],
                "availability": "out",
            }
        )

        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["content"], full_dish_info)
        self.assertEqual(
            chunks[0]["rerank_text"],
            "\n".join(
                [
                    "Name: Avocado roll",
                    "Category: Maki",
                    "Description: Avocado, rice, and nori.",
                    "Price: 9",
                    "Allergens:",
                    "Availability: out",
                    "Content:",
                    "Avocado, rice, and nori.",
                ]
            ),
        )
        self.assertEqual(chunks[0]["dish_id"], "avocado-roll")
        self.assertEqual(chunks[0]["availability"], "out")

    def test_each_chunk_has_composite_metadata_and_its_own_content(self):
        full_dish_info = " ".join(f"word-{index}" for index in range(160))

        chunks = create_dish_chunks(
            {
                "id": "akami",
                "name": "  Akami   Tuna  ",
                "category": " Nigiri ",
                "description": " Tuna   and\n rice ",
                "fullDishInfo": full_dish_info,
                "price": " 14 ",
                "allergens": [" fish ", "", "contains   wheat"],
                "availability": "available",
            }
        )

        self.assertEqual(len(chunks), 2)
        expected_prefix = "\n".join(
            [
                "Name: Akami Tuna",
                "Category: Nigiri",
                "Description: Tuna and rice",
                "Price: 14",
                "Allergens: fish, contains wheat",
                "Availability: available",
            ]
        )
        for chunk in chunks:
            with self.subTest(chunk_index=chunk["chunk_index"]):
                self.assertEqual(
                    chunk["rerank_text"],
                    f"{expected_prefix}\nContent:\n{chunk['content'].strip()}",
                )
        self.assertNotEqual(chunks[0]["content"], chunks[1]["content"])
        self.assertNotEqual(
            chunks[0]["rerank_text"], chunks[1]["rerank_text"]
        )

    def test_dish_without_full_info_creates_no_chunks(self):
        chunks = create_dish_chunks(
            {
                "id": "avocado-roll",
                "description": "This is not used by the original chunker.",
            }
        )

        self.assertEqual(chunks, [])


class SettingsTests(unittest.TestCase):
    def test_collection_is_stage_specific(self):
        self.assertEqual(
            build_collection_name("Menu-Chunks", "staging-west"),
            "MenuChunksStagingWest",
        )
        self.assertNotEqual(
            build_collection_name("MenuChunks", "staging"),
            build_collection_name("MenuChunks", "prod"),
        )

    def test_required_explicit_model(self):
        environment = {
            "STAGE": "staging",
            "DISHES_TABLE": "dishes-staging",
            "CHAT_HISTORY_TABLE": "chat-staging",
            "RAG_CREDENTIALS_SECRET_ARN": "arn:example",
            "WEAVIATE_URL": "https://cluster.example",
        }
        with self.assertRaises(ConfigurationError):
            Settings.from_env(environment)

    def test_terraform_names_and_secret_url_fallback_are_supported(self):
        configured = Settings.from_env(
            {
                "STAGE": "staging",
                "DISHES_TABLE": "dishes-staging",
                "CHAT_HISTORY_TABLE": "chat-staging",
                "RAG_CREDENTIALS_SECRET_ARN": "arn:example",
                "WEAVIATE_COLLECTION": "SushiMenuChunksStaging",
                "OPENAI_CHAT_MODEL": "explicit-model",
                "RAG_CANDIDATE_LIMIT": "12",
                "RAG_CONTEXT_DISH_LIMIT": "4",
                "RAG_MIN_RERANK_SCORE": "0.42",
                "CHAT_HISTORY_LIMIT": "9",
                "CHAT_RETENTION_DAYS": "45",
            }
        )

        self.assertEqual(configured.weaviate_url, "")
        self.assertEqual(
            configured.weaviate_collection, "SushiMenuChunksStaging"
        )
        self.assertEqual(configured.retrieval_candidate_limit, 12)
        self.assertEqual(configured.retrieval_dish_limit, 4)
        self.assertEqual(configured.retrieval_min_rerank_score, 0.42)
        self.assertEqual(configured.chat_history_limit, 9)
        self.assertEqual(configured.chat_ttl_days, 45)

        credentials = RagCredentials.from_mapping(
            {
                "OPENAI_API_KEY": "openai",
                "WEAVIATE_API_KEY": "weaviate",
                "COHERE_API_KEY": "cohere",
                "WEAVIATE_URL": "https://secret-cluster.example",
            }
        )
        self.assertEqual(
            credentials.weaviate_url, "https://secret-cluster.example"
        )

    def test_rerank_score_threshold_must_be_between_zero_and_one(self):
        environment = {
            "STAGE": "staging",
            "DISHES_TABLE": "dishes-staging",
            "CHAT_HISTORY_TABLE": "chat-staging",
            "RAG_CREDENTIALS_SECRET_ARN": "arn:example",
            "OPENAI_CHAT_MODEL": "explicit-model",
        }
        for value in ("-0.01", "1.01", "nan", "inf", "not-a-number"):
            with self.subTest(value=value), self.assertRaises(ConfigurationError):
                Settings.from_env(
                    {**environment, "RAG_MIN_RERANK_SCORE": value}
                )

    def test_rag_context_logging_is_default_off_and_strictly_boolean(self):
        environment = {
            "STAGE": "staging",
            "DISHES_TABLE": "dishes-staging",
            "CHAT_HISTORY_TABLE": "chat-staging",
            "RAG_CREDENTIALS_SECRET_ARN": "arn:example",
            "OPENAI_CHAT_MODEL": "explicit-model",
        }

        self.assertFalse(Settings.from_env(environment).log_selected_chunks)
        self.assertFalse(
            Settings.from_env(environment).log_retrieved_candidates
        )
        self.assertFalse(
            Settings.from_env(environment).log_openai_context_dishes
        )
        self.assertFalse(Settings.from_env(environment).log_user_questions)
        self.assertTrue(
            Settings.from_env(
                {**environment, "RAG_LOG_SELECTED_CHUNKS": "TRUE"}
            ).log_selected_chunks
        )
        self.assertTrue(
            Settings.from_env(
                {**environment, "RAG_LOG_RETRIEVED_CANDIDATES": "TRUE"}
            ).log_retrieved_candidates
        )
        self.assertTrue(
            Settings.from_env(
                {**environment, "RAG_LOG_OPENAI_CONTEXT_DISHES": "TRUE"}
            ).log_openai_context_dishes
        )
        self.assertTrue(
            Settings.from_env(
                {**environment, "RAG_LOG_USER_QUESTIONS": "TRUE"}
            ).log_user_questions
        )
        for variable_name in (
            "RAG_LOG_SELECTED_CHUNKS",
            "RAG_LOG_RETRIEVED_CANDIDATES",
            "RAG_LOG_OPENAI_CONTEXT_DISHES",
            "RAG_LOG_USER_QUESTIONS",
        ):
            for value in ("yes", "1", "enabled"):
                with self.subTest(
                    variable_name=variable_name, value=value
                ), self.assertRaises(ConfigurationError):
                    Settings.from_env(
                        {**environment, variable_name: value}
                    )

    def test_weaviate_url_rejects_credentials_query_and_fragment(self):
        for value in (
            "https://user@cluster.example",
            "https://:password@cluster.example",
            "https://cluster.example?token=value",
            "https://cluster.example/#fragment",
        ):
            with self.subTest(value=value), self.assertRaises(ConfigurationError):
                validate_https_url(value, field_name="WEAVIATE_URL")


class FakeSecretsClient:
    def __init__(self):
        self.calls = 0

    def get_secret_value(self, **_kwargs):
        self.calls += 1
        return {
            "SecretString": json.dumps(
                {
                    "OPENAI_API_KEY": "openai-value",
                    "WEAVIATE_API_KEY": "weaviate-value",
                    "COHERE_API_KEY": "cohere-value",
                }
            )
        }


class SecretsTests(unittest.TestCase):
    def test_secret_is_cached_and_can_be_refreshed(self):
        client = FakeSecretsClient()
        time_value = [10.0]
        provider = SecretsManagerProvider(
            "secret-id",
            client=client,
            cache_seconds=30,
            clock=lambda: time_value[0],
        )

        first = provider.get()
        time_value[0] = 20.0
        second = provider.get()
        refreshed = provider.get(force_refresh=True)

        self.assertIs(first, second)
        self.assertEqual(first.openai_api_key, "openai-value")
        self.assertEqual(refreshed.cohere_api_key, "cohere-value")
        self.assertEqual(client.calls, 2)


if __name__ == "__main__":
    unittest.main()
