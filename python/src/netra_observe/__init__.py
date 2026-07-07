from __future__ import annotations

import logging
import threading
from typing import Optional

from openinference.instrumentation.langchain import LangChainInstrumentor
from opentelemetry.sdk.trace import TracerProvider

from ._config import Config, NetraConfigError, resolve
from ._inject import install, uninstall
from ._provider import build_provider

__version__ = "0.1.0"
__all__ = ["instrument", "NetraInstrumentation", "NetraConfigError", "__version__"]

logger = logging.getLogger("netra_observe")

_lock = threading.Lock()
_active: Optional["NetraInstrumentation"] = None


class NetraInstrumentation:
    """Handle returned by instrument(). Context-manager friendly."""

    def __init__(self, provider: TracerProvider, owns_provider: bool) -> None:
        self.provider = provider
        self._owns_provider = owns_provider

    def flush(self, timeout_ms: int = 5000) -> None:
        try:
            self.provider.force_flush(timeout_ms)
        except Exception:
            logger.debug("flush failed", exc_info=True)

    def shutdown(self) -> None:
        global _active
        try:
            LangChainInstrumentor().uninstrument()
        except Exception:
            logger.debug("uninstrument failed", exc_info=True)
        uninstall()
        self.flush()
        if self._owns_provider:
            try:
                self.provider.shutdown()
            except Exception:
                logger.debug("provider shutdown failed", exc_info=True)
        with _lock:
            _active = None

    def __enter__(self) -> "NetraInstrumentation":
        return self

    def __exit__(self, *exc) -> None:
        self.shutdown()


def instrument(
    api_key: Optional[str] = None,
    project: Optional[str] = None,
    environment: Optional[str] = None,
    endpoint: Optional[str] = None,
    tracer_provider: Optional[TracerProvider] = None,
) -> NetraInstrumentation:
    """Wire LangChain tracing into Netra. Idempotent; never raises after
    config validation succeeds."""
    global _active
    with _lock:
        if _active is not None:
            return _active
        cfg = resolve(api_key, project, environment, endpoint)
        if tracer_provider is not None:
            provider, owns = tracer_provider, False
        else:
            provider, owns = build_provider(cfg), True
        LangChainInstrumentor().instrument(tracer_provider=provider)
        install(cfg.gateway_host)
        _active = NetraInstrumentation(provider, owns)
        return _active


def _reset_for_tests() -> None:
    """Test hook: tear down whatever instrument() set up."""
    global _active
    handle = _active
    if handle is not None:
        handle.shutdown()
    else:
        try:
            LangChainInstrumentor().uninstrument()
        except Exception:
            pass
        uninstall()
