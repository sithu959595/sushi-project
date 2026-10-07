"""AWS Lambda handler shim for the authenticated chat API."""

from rag_app.chat_handler import create_handler, lambda_handler

__all__ = ["create_handler", "lambda_handler"]
