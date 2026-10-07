"""Small JSON-over-HTTPS transport built on the Python standard library."""

from __future__ import annotations

import json
import ssl
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .errors import HttpStatusError, UpstreamError


class JsonHttpTransport:
    def __init__(self, *, timeout_seconds: int = 20) -> None:
        self.timeout_seconds = timeout_seconds
        self._ssl_context = ssl.create_default_context()

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        payload: Any | None = None,
    ) -> Any:
        request_headers = {
            "Accept": "application/json",
            **(headers or {}),
        }
        data = None
        if payload is not None:
            data = json.dumps(
                payload, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            request_headers["Content-Type"] = "application/json"

        request = Request(
            url,
            data=data,
            headers=request_headers,
            method=method.upper(),
        )
        try:
            with urlopen(
                request,
                timeout=self.timeout_seconds,
                context=self._ssl_context,
            ) as response:
                body = response.read()
        except HTTPError as error:
            # Do not propagate an upstream response body. Some providers echo
            # user input in validation errors.
            try:
                error.read()
            finally:
                raise HttpStatusError(error.code) from error
        except (URLError, TimeoutError, OSError) as error:
            raise UpstreamError("An upstream service could not be reached") from error

        if not body:
            return None
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise UpstreamError(
                "An upstream service returned invalid JSON"
            ) from error
