"""Inline images never leave the process inside a trace.

A page crop reaches the chat model as a ``data:image/...;base64,...`` URL in a
content block. Wherever that value is copied (a tool result, a model input, a
span attribute, a log line) the megabytes of a customer's drawing go with it.
A trace holds that an image was sent, how large and which one (a short hash),
never its pixels.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

#: One inline image: the data URL, with the payload as JSON may have escaped it (``\/``).
_DATA_URL = re.compile(r"data:image\\?/[A-Za-z0-9.+-]+;base64,((?:[A-Za-z0-9+/=_-]|\\/)+)")


def _placeholder(match: re.Match[str]) -> str:
    digest = hashlib.sha256(match.group(0).encode("utf-8")).hexdigest()[:8]
    return f"[image, {len(match.group(0))} chars, sha256:{digest}]"


def redact_inline_images(value: Any) -> Any:
    """``value`` with every inline image replaced by ``[image, N chars, sha256:<8>]``.

    Takes a string (plain or JSON), or a list or dict of them at any depth, and
    returns the same shape. Anything else, and anything holding no image, comes
    back as it is.
    """
    if isinstance(value, str):
        return _DATA_URL.sub(_placeholder, value) if "data:image" in value else value
    if isinstance(value, list):
        return [redact_inline_images(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_inline_images(item) for item in value)
    if isinstance(value, dict):
        return {key: redact_inline_images(item) for key, item in value.items()}
    return value
