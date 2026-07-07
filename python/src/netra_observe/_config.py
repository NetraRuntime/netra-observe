from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

DEFAULT_ENDPOINT = "https://api.netraruntime.com/v1/otel"


class NetraConfigError(ValueError):
    """Raised for unusable configuration (e.g. no API key anywhere)."""


@dataclass(frozen=True)
class Config:
    api_key: str
    endpoint: str
    gateway_host: str
    project: Optional[str]
    environment: Optional[str]


def resolve(
    api_key: Optional[str] = None,
    project: Optional[str] = None,
    environment: Optional[str] = None,
    endpoint: Optional[str] = None,
) -> Config:
    key = api_key or os.environ.get("NETRA_API_KEY")
    if not key:
        raise NetraConfigError(
            "netra-observe needs an API key: pass instrument(api_key=...) "
            "or set NETRA_API_KEY"
        )
    ep = (endpoint or os.environ.get("NETRA_OTEL_ENDPOINT") or DEFAULT_ENDPOINT).rstrip("/")
    host = urlparse(ep).netloc
    if not host:
        raise NetraConfigError(f"invalid OTLP endpoint: {ep!r}")
    return Config(
        api_key=key,
        endpoint=ep,
        gateway_host=host,
        project=project or os.environ.get("NETRA_PROJECT"),
        environment=environment or os.environ.get("NETRA_ENVIRONMENT"),
    )
