from __future__ import annotations

import unittest

from rag_app.dynamodb import (
    ChatRepository,
    MenuRepository,
    _transaction_failure_detail,
    decode_item,
    encode_item,
)
from rag_app.errors import NotFoundError


class QueueDynamoClient:
    def __init__(self, *, gets=None, scans=None, queries=None):
        self.gets = list(gets or [])
        self.scans = list(scans or [])
        self.queries = list(queries or [])
        self.calls = []

    def get_item(self, **request):
        self.calls.append(("get_item", request))
        return self.gets.pop(0)

    def scan(self, **request):
        self.calls.append(("scan", request))
        return self.scans.pop(0)

    def query(self, **request):
        self.calls.append(("query", request))
        return self.queries.pop(0)


class MenuRepositoryTests(unittest.TestCase):
    def test_aggregate_menu_is_authoritative_and_maps_legacy_private_field(self):
        client = QueueDynamoClient(
            gets=[
                {
                    "Item": encode_item(
                        {
                            "id": "MENU#CURRENT",
                            "items": [
                                {
                                    "id": "akami",
                                    "category": "Nigiri",
                                    "name": "Akami",
                                    "description": "Tuna and rice",
                                    "price": "14",
                                    "allergens": ["fish"],
                                    "ragInfo": "Legacy details",
                                    "availability": "out",
                                }
                            ],
                        }
                    )
                }
            ]
        )

        dishes = MenuRepository("menu-table", client=client).load_dishes()

        self.assertEqual(dishes[0]["fullDishInfo"], "Legacy details")
        self.assertEqual(dishes[0]["availability"], "out")
        self.assertEqual([call[0] for call in client.calls], ["get_item"])
        self.assertTrue(client.calls[0][1]["ConsistentRead"])

    def test_legacy_rows_are_scanned_across_pages_and_sorted(self):
        client = QueueDynamoClient(
            gets=[{}],
            scans=[
                {
                    "Items": [
                        encode_item(
                            {
                                "id": "z-dish",
                                "name": "Z",
                                "description": "Zed",
                            }
                        )
                    ],
                    "LastEvaluatedKey": encode_item({"id": "z-dish"}),
                },
                {
                    "Items": [
                        encode_item(
                            {
                                "id": "a-dish",
                                "name": "A",
                                "description": "Aye",
                            }
                        )
                    ]
                },
            ],
        )

        dishes = MenuRepository("menu-table", client=client).load_dishes()

        self.assertEqual([dish["id"] for dish in dishes], ["a-dish", "z-dish"])
        self.assertIn("ExclusiveStartKey", client.calls[-1][1])


class TransactionClient:
    def __init__(self):
        self.transaction = None

    def transact_write_items(self, **request):
        self.transaction = request["TransactItems"]
        return {}


class ChatRepositoryTests(unittest.TestCase):
    def test_transaction_failure_detail_contains_only_reason_codes(self):
        class TransactionError(Exception):
            response = {
                "Error": {
                    "Code": "TransactionCanceledException",
                    "Message": "must not be logged",
                },
                "CancellationReasons": [
                    {"Code": "None"},
                    {
                        "Code": "ConditionalCheckFailed",
                        "Message": "must not be logged",
                        "Item": {"secret": {"S": "must not be logged"}},
                    },
                ],
            }

        detail = _transaction_failure_detail(TransactionError("secret"))

        self.assertEqual(
            detail,
            "TransactionCanceledException[None,ConditionalCheckFailed]",
        )
        self.assertNotIn("secret", detail)
        self.assertNotIn("Message", detail)

    def test_expired_messages_are_hidden_before_ttl_deletion(self):
        client = QueueDynamoClient(
            queries=[
                {
                    "Items": [
                        encode_item(
                            {
                                "messageId": "expired",
                                "role": "user",
                                "content": "Old",
                                "createdAt": "earlier",
                                "expiresAt": 999,
                            }
                        ),
                        encode_item(
                            {
                                "messageId": "live",
                                "role": "assistant",
                                "content": "Current",
                                "createdAt": "later",
                                "expiresAt": 1001,
                            }
                        ),
                    ]
                }
            ]
        )
        repository = ChatRepository(
            "chat-table", client=client, epoch_clock=lambda: 1000
        )

        messages = repository.list_messages(chat_id="chat-1")

        self.assertEqual([message["messageId"] for message in messages], ["live"])

    def test_expired_session_is_inaccessible_before_ttl_deletion(self):
        client = QueueDynamoClient(
            gets=[
                {
                    "Item": encode_item(
                        {
                            "PK": "CHAT#chat-1",
                            "SK": "META",
                            "ownerSub": "owner-1",
                            "createdAt": "2026-07-30T12:00:00.000Z",
                            "expiresAt": 999,
                        }
                    )
                }
            ]
        )
        repository = ChatRepository(
            "chat-table", client=client, epoch_clock=lambda: 1000
        )

        with self.assertRaises(NotFoundError):
            repository.get_session(chat_id="chat-1", owner_sub="owner-1")

    def test_save_exchange_is_atomic_idempotent_and_refreshes_ttl(self):
        client = TransactionClient()
        repository = ChatRepository("chat-table", client=client)
        user = {
            "messageId": "u-1",
            "role": "user",
            "content": "What is vegan?",
            "createdAt": "2026-07-30T12:00:00.000Z",
        }
        assistant = {
            "messageId": "a-1",
            "role": "assistant",
            "content": "The avocado roll.",
            "createdAt": "2026-07-30T12:00:00.000Z",
        }

        response = repository.save_exchange(
            chat_id="chat-1",
            owner_sub="owner-1",
            request_id="request-1",
            user_message=user,
            assistant_message=assistant,
            expires_at=999,
        )

        self.assertEqual(response["assistantMessage"], assistant)
        operations = client.transaction
        self.assertEqual(len(operations), 4)
        put_items = [
            decode_item(operation["Put"]["Item"])
            for operation in operations
            if "Put" in operation
        ]
        self.assertEqual(
            {item["entityType"] for item in put_items},
            {"CHAT_MESSAGE", "CHAT_REQUEST"},
        )
        request_item = next(
            item for item in put_items if item["entityType"] == "CHAT_REQUEST"
        )
        self.assertEqual(request_item["requestId"], "request-1")
        update = operations[-1]["Update"]
        self.assertEqual(update["ConditionExpression"], "#owner = :owner")


if __name__ == "__main__":
    unittest.main()
