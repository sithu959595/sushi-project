"""Dish chunk creation using the original RAG project's chunking logic."""

from __future__ import annotations

import math
from typing import Any

from .errors import ValidationError


MAX_RERANK_TEXT_LENGTH = 7000


def get_chunks_fixed_size_with_overlap(
    text: str,
    chunk_size: int,
    overlap_fraction: float,
) -> list[str]:
    text_words = text.split()
    overlap_int = int(chunk_size * overlap_fraction)
    chunks = []

    for index in range(0, len(text_words), chunk_size):
        chunk_words = text_words[
            max(index - overlap_int, 0) : index + chunk_size
        ]
        chunk = " ".join(chunk_words)
        chunks.append(chunk)

    return chunks


def mixed_chunking(
    source_text: str,
    min_length: int = 25,
    max_length: int = 100,
) -> list[str]:
    chunks = source_text.split("\n\n")
    new_chunks = []
    chunk_buffer = ""

    for chunk in chunks:
        new_buffer = chunk_buffer + chunk
        new_buffer_words = new_buffer.split(" ")

        if len(new_buffer_words) < min_length:
            chunk_buffer = new_buffer
        elif len(new_buffer_words) > max_length:
            devisor = math.ceil(len(new_buffer_words) / max_length)
            chunk_size = math.ceil(len(new_buffer_words) / devisor)
            print(chunk_size)
            result = get_chunks_fixed_size_with_overlap(
                new_buffer,
                chunk_size,
                0.2,
            )
            new_chunks = new_chunks[:] + result[:]
        else:
            new_chunks.append(new_buffer)
            chunk_buffer = ""

    if len(chunk_buffer) > 0:
        new_chunks.append(chunk_buffer)

    return new_chunks


def chunk_text(
    text: str,
    *,
    min_words: int = 40,
    max_words: int = 150,
) -> list[str]:
    """Call the original mixed chunker with the menu's original limits."""
    return mixed_chunking(
        text,
        min_length=min_words,
        max_length=max_words,
    )


def _string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _single_line(value: str) -> str:
    return " ".join(value.split())


def _build_rerank_text(
    *,
    content: str,
    name: str,
    category: str,
    description: str,
    price: str,
    allergens: list[str],
    availability: str,
) -> str:
    """Build the one stored text property that Cohere reranks."""
    normalized_allergens = [
        _single_line(allergen) for allergen in allergens if allergen.strip()
    ]
    lines = [
        f"Name: {_single_line(name)}",
        f"Category: {_single_line(category)}",
        f"Description: {_single_line(description)}",
        f"Price: {_single_line(price)}",
        f"Allergens: {', '.join(normalized_allergens)}".rstrip(),
        f"Availability: {_single_line(availability)}",
        "Content:",
        content.strip(),
    ]
    return "\n".join(lines)[:MAX_RERANK_TEXT_LENGTH]


def create_dish_chunks(
    dish: dict[str, Any],
    *,
    min_words: int = 40,
    max_words: int = 150,
) -> list[dict[str, Any]]:
    if not isinstance(dish, dict):
        raise TypeError("dish must be a dictionary")
    dish_id = _string(dish.get("id"))
    if not dish_id:
        raise ValidationError("A dish must have a non-empty id")

    full_dish_info = dish.get("fullDishInfo", "")
    chunks = mixed_chunking(
        full_dish_info,
        min_length=min_words,
        max_length=max_words,
    )
    allergens = dish.get("allergens")
    normalized_allergens = (
        [
            value.strip()
            for value in allergens
            if isinstance(value, str) and value.strip()
        ]
        if isinstance(allergens, list)
        else []
    )
    name = _string(dish.get("name"))
    category = _string(dish.get("category"))
    description = _string(dish.get("description"))
    raw_price = dish.get("price", "")
    price = str(raw_price).strip() if raw_price is not None else ""
    availability = (
        "out" if dish.get("availability") == "out" else "available"
    )

    return [
        {
            "content": content,
            "rerank_text": _build_rerank_text(
                content=content,
                name=name,
                category=category,
                description=description,
                price=price,
                allergens=normalized_allergens,
                availability=availability,
            ),
            "dish_id": dish_id,
            "name": name,
            "category": category,
            "description": description,
            "price": price,
            "allergens": normalized_allergens,
            "availability": availability,
            "chunk_index": index,
        }
        for index, content in enumerate(chunks)
    ]


def create_chunks(dishes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(dishes, list):
        raise TypeError("dishes must be a list")
    result: list[dict[str, Any]] = []
    for dish in dishes:
        result.extend(create_dish_chunks(dish))
    return result
