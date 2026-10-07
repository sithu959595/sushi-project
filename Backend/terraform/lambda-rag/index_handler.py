"""AWS Lambda handler shim for the menu indexer."""

from rag_app.index_handler import create_handler, lambda_handler

__all__ = ["create_handler", "lambda_handler"]

