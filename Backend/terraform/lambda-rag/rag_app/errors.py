"""Shared application errors.

The public handlers translate these errors to deliberately small API responses.
No exception in this module carries prompts, retrieved menu context, or secrets.
"""


class ConfigurationError(RuntimeError):
    """Required runtime configuration is missing or unsafe."""


class ValidationError(ValueError):
    """A caller supplied an invalid request."""


class NotFoundError(LookupError):
    """A requested resource does not exist."""


class ForbiddenError(PermissionError):
    """The authenticated principal does not own the resource."""


class UpstreamError(RuntimeError):
    """A required external service was unavailable or returned bad data."""


class HttpStatusError(UpstreamError):
    """An upstream HTTP service returned a non-success status."""

    def __init__(self, status_code: int) -> None:
        super().__init__(f"An upstream service returned HTTP {status_code}")
        self.status_code = status_code


class ConflictError(RuntimeError):
    """A conditional write lost a race with an equivalent request."""
