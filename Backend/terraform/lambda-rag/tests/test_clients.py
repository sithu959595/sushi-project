from __future__ import annotations

import math
import unittest

from rag_app.errors import UpstreamError
from rag_app.openai_chat import OpenAIChatClient
from rag_app.weaviate import WeaviateClient


class ScriptedTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, *, headers=None, payload=None):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": headers,
                "payload": payload,
            }
        )
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def client(transport, collection="MenuChunksStaging"):
    return WeaviateClient(
        base_url="https://weaviate.example",
        api_key="weaviate-key",
        openai_api_key="openai-key",
        cohere_api_key="cohere-key",
        collection_name=collection,
        transport=transport,
    )


def compatible_collection_schema(collection="MenuChunksStaging"):
    return {
        "class": collection,
        "vectorizer": "text2vec-openai",
        "moduleConfig": {"reranker-cohere": {}},
        "properties": [
            {
                "name": "rerank_text",
                "dataType": ["text"],
                "moduleConfig": {
                    "text2vec-openai": {
                        "skip": True,
                        "vectorizePropertyName": False,
                    }
                },
                "indexFilterable": False,
                "indexSearchable": False,
            }
        ],
    }


def legacy_collection_schema():
    schema = compatible_collection_schema()
    schema["properties"] = [{"name": "content", "dataType": ["text"]}]
    return schema


class WeaviateClientTests(unittest.TestCase):
    def test_replace_creates_required_collection_deletes_then_uses_stable_uuid(self):
        transport = ScriptedTransport(
            [
                {"classes": []},
                {"class": "MenuChunksStaging"},
                {"results": {"successful": 2}},
                [{"result": {"status": "SUCCESS"}}],
            ]
        )
        vector = client(transport)
        dish = {
            "id": "akami",
            "name": "Akami",
            "category": "Nigiri",
            "description": "Tuna and rice",
            "price": "14",
            "allergens": ["fish"],
            "fullDishInfo": "Raw tuna with aged soy.",
            "availability": "available",
        }

        count = vector.replace_dish(dish)

        self.assertEqual(count, 1)
        schema = transport.calls[1]["payload"]
        self.assertEqual(schema["vectorizer"], "text2vec-openai")
        self.assertIn("reranker-cohere", schema["moduleConfig"])
        dish_id_property = next(
            item for item in schema["properties"] if item["name"] == "dish_id"
        )
        self.assertEqual(dish_id_property["tokenization"], "field")
        self.assertTrue(
            dish_id_property["moduleConfig"]["text2vec-openai"]["skip"]
        )
        rerank_text_property = next(
            item
            for item in schema["properties"]
            if item["name"] == "rerank_text"
        )
        self.assertEqual(rerank_text_property["dataType"], ["text"])
        self.assertTrue(
            rerank_text_property["moduleConfig"]["text2vec-openai"]["skip"]
        )
        self.assertFalse(rerank_text_property["indexFilterable"])
        self.assertFalse(rerank_text_property["indexSearchable"])
        self.assertEqual(transport.calls[2]["method"], "DELETE")
        inserted = transport.calls[3]["payload"]["objects"][0]
        self.assertEqual(
            inserted["id"], vector.deterministic_chunk_uuid("akami", 0)
        )
        self.assertEqual(inserted["properties"]["dish_id"], "akami")
        self.assertEqual(
            inserted["properties"]["rerank_text"],
            "\n".join(
                [
                    "Name: Akami",
                    "Category: Nigiri",
                    "Description: Tuna and rice",
                    "Price: 14",
                    "Allergens: fish",
                    "Availability: available",
                    "Content:",
                    "Raw tuna with aged soy.",
                ]
            ),
        )

    def test_retrieve_uses_hybrid_and_cohere_rerank(self):
        transport = ScriptedTransport(
            [
                {
                    "classes": [compatible_collection_schema()]
                },
                {
                    "data": {
                        "Get": {
                            "MenuChunksStaging": [
                                {
                                    "content": "Contains fish.",
                                    "dish_id": "akami",
                                    "name": "Akami",
                                    "chunk_index": 0,
                                    "_additional": {
                                        "rerank": [{"score": 0.83}]
                                    },
                                }
                            ]
                        }
                    }
                },
            ]
        )

        results = client(transport).retrieve("Does it contain fish?", limit=7)

        query = transport.calls[-1]["payload"]["query"]
        self.assertIn("hybrid:", query)
        self.assertIn("alpha: 0.5", query)
        self.assertNotIn("rerank:", query)
        self.assertIn("_additional {", query)
        self.assertIn(
            'rerank(property: "rerank_text", query: "Does it contain fish?")'
            " { score }",
            query,
        )
        self.assertNotIn('rerank(property: "content"', query)
        self.assertNotIn("\n      rerank_text\n", query)
        self.assertIn("limit: 7", query)
        self.assertEqual(results[0]["dish_id"], "akami")
        self.assertEqual(results[0]["rerank_score"], 0.83)
        self.assertNotIn("rerank_text", results[0])

    def test_retrieve_rejects_invalid_rerank_scores(self):
        for score in (None, True, "0.8", math.nan, -0.1, 1.1):
            with self.subTest(score=score):
                transport = ScriptedTransport(
                    [
                        {
                            "classes": [compatible_collection_schema()]
                        },
                        {
                            "data": {
                                "Get": {
                                    "MenuChunksStaging": [
                                        {
                                            "dish_id": "akami",
                                            "_additional": {
                                                "rerank": [{"score": score}]
                                            },
                                        }
                                    ]
                                }
                            }
                        },
                    ]
                )

                with self.assertRaisesRegex(
                    UpstreamError, "invalid rerank score"
                ):
                    client(transport).retrieve("Akami?", limit=1)

    def test_uuid_changes_with_stage_collection(self):
        first = client(ScriptedTransport([]), "MenuChunksStaging")
        second = client(ScriptedTransport([]), "MenuChunksProd")
        self.assertNotEqual(
            first.deterministic_chunk_uuid("akami", 0),
            second.deterministic_chunk_uuid("akami", 0),
        )

    def test_delete_rejects_partial_failures(self):
        transport = ScriptedTransport(
            [
                {
                    "classes": [compatible_collection_schema()]
                },
                {"results": {"successful": 1, "failed": 1}},
            ]
        )

        with self.assertRaisesRegex(
            UpstreamError, "delete every stale menu chunk"
        ):
            client(transport).delete_dish("akami")

    def test_legacy_collection_without_rerank_text_requires_full_rebuild(self):
        transport = ScriptedTransport(
            [{"classes": [legacy_collection_schema()]}]
        )

        with self.assertRaisesRegex(UpstreamError, "full rebuild"):
            client(transport).retrieve("Akami?", limit=1)

        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(transport.calls[0]["method"], "GET")
        self.assertTrue(transport.calls[0]["url"].endswith("/v1/schema"))

    def test_searchable_rerank_text_property_requires_full_rebuild(self):
        incompatible = compatible_collection_schema()
        incompatible["properties"][0]["indexSearchable"] = True
        transport = ScriptedTransport([{"classes": [incompatible]}])

        with self.assertRaisesRegex(UpstreamError, "full rebuild"):
            client(transport).retrieve("Akami?", limit=1)

        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(transport.calls[0]["method"], "GET")

    def test_incremental_replace_does_not_delete_from_legacy_collection(self):
        transport = ScriptedTransport(
            [{"classes": [legacy_collection_schema()]}]
        )

        with self.assertRaisesRegex(UpstreamError, "full rebuild"):
            client(transport).replace_dish(
                {
                    "id": "akami",
                    "name": "Akami",
                    "fullDishInfo": "Raw tuna.",
                }
            )

        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(transport.calls[0]["method"], "GET")

    def test_full_rebuild_replaces_even_an_incompatible_stage_collection(self):
        transport = ScriptedTransport(
            [
                {
                    "classes": [
                        {
                            "class": "MenuChunksStaging",
                            "vectorizer": "different-vectorizer",
                            "moduleConfig": {},
                        }
                    ]
                },
                None,
                {"classes": []},
                {"class": "MenuChunksStaging"},
                [{"result": {"status": "SUCCESS"}}],
            ]
        )
        vector = client(transport)

        count = vector.rebuild(
            [
                {
                    "id": "akami",
                    "name": "Akami",
                    "description": "Tuna and rice",
                    "fullDishInfo": "Raw tuna.",
                }
            ]
        )

        self.assertEqual(count, 1)
        self.assertEqual(transport.calls[1]["method"], "DELETE")
        self.assertTrue(
            transport.calls[1]["url"].endswith(
                "/v1/schema/MenuChunksStaging"
            )
        )
        self.assertEqual(transport.calls[3]["method"], "POST")
        self.assertTrue(transport.calls[3]["url"].endswith("/v1/schema"))

    def test_full_rebuild_migrates_legacy_collection_to_rerank_text(self):
        transport = ScriptedTransport(
            [
                {"classes": [legacy_collection_schema()]},
                None,
                {"classes": []},
                {"class": "MenuChunksStaging"},
                [{"result": {"status": "SUCCESS"}}],
            ]
        )
        vector = client(transport)

        count = vector.rebuild(
            [
                {
                    "id": "akami",
                    "name": "Akami",
                    "category": "Nigiri",
                    "description": "Tuna and rice",
                    "price": "14",
                    "allergens": ["fish"],
                    "availability": "available",
                    "fullDishInfo": "Raw tuna.",
                }
            ]
        )

        self.assertEqual(count, 1)
        self.assertEqual(
            [call["method"] for call in transport.calls],
            ["GET", "DELETE", "GET", "POST", "POST"],
        )
        self.assertTrue(
            transport.calls[1]["url"].endswith(
                "/v1/schema/MenuChunksStaging"
            )
        )
        new_schema = transport.calls[3]["payload"]
        rerank_text_property = next(
            item
            for item in new_schema["properties"]
            if item["name"] == "rerank_text"
        )
        self.assertEqual(rerank_text_property["dataType"], ["text"])
        self.assertEqual(
            rerank_text_property["moduleConfig"]["text2vec-openai"],
            {"skip": True, "vectorizePropertyName": False},
        )
        self.assertFalse(rerank_text_property["indexFilterable"])
        self.assertFalse(rerank_text_property["indexSearchable"])
        inserted = transport.calls[4]["payload"]["objects"][0]
        self.assertEqual(
            inserted["id"], vector.deterministic_chunk_uuid("akami", 0)
        )
        self.assertEqual(
            inserted["properties"]["rerank_text"],
            "\n".join(
                [
                    "Name: Akami",
                    "Category: Nigiri",
                    "Description: Tuna and rice",
                    "Price: 14",
                    "Allergens: fish",
                    "Availability: available",
                    "Content:",
                    "Raw tuna.",
                ]
            ),
        )


class OpenAIClientTests(unittest.TestCase):
    def test_explicit_model_and_authoritative_context_are_sent(self):
        transport = ScriptedTransport(
            [{"choices": [{"message": {"content": "It is out today."}}]}]
        )
        openai = OpenAIChatClient(
            api_key="openai-key",
            model="configured-model",
            transport=transport,
        )

        answer = openai.generate(
            question="Can I order it?",
            context_dishes=[
                {
                    "id": "akami",
                    "availability": "out",
                    "allergens": ["fish"],
                    "fullDishInfo": "Normally offered nightly.",
                }
            ],
            history=[],
        )

        request = transport.calls[0]
        self.assertEqual(request["payload"]["model"], "configured-model")
        system = request["payload"]["messages"][0]["content"]
        self.assertIn('"availability": "out"', system)
        self.assertIn('"allergens": [', system)
        self.assertEqual(answer, "It is out today.")


if __name__ == "__main__":
    unittest.main()
