from __future__ import annotations

import logging
import threading
from typing import Optional

from openinference.instrumentation.langchain import LangChainInstrumentor
from opentelemetry.sdk.trace import TracerProvider

from ._config import Config, NetraConfigError, resolve
from ._inject import install, uninstall
from ._provider import build_processor, build_provider
from ._runholder import activate as _activate_runholder
from ._runholder import deactivate as _deactivate_runholder

__version__ = "0.1.1"
__all__ = ["instrument", "NetraInstrumentation", "NetraConfigError", "__version__"]

logger = logging.getLogger("netra_observe")

_lock = threading.Lock()
_active: Optional["NetraInstrumentation"] = None


class NetraInstrumentation:
    """Handle returned by instrument(). Context-manager friendly."""

    def __init__(
        self,
        provider: TracerProvider,
        owns_provider: bool,
        owns_instrumentation: bool,
        processor=None,
    ) -> None:
        self.provider = provider
        self._owns_provider = owns_provider
        # False when LangChainInstrumentor was already active before us
        # (e.g. Phoenix) — we must not tear down what we didn't set up
        # (post-review S-I2).
        self._owns_instrumentation = owns_instrumentation
        # In attach mode we add our own BatchSpanProcessor to the USER's
        # provider (post-review S-C2); shutdown stops that processor only,
        # never the user's provider.
        self._processor = processor

    def flush(self, timeout_ms: int = 5000) -> None:
        try:
            self.provider.force_flush(timeout_ms)
        except Exception:
            logger.debug("flush failed", exc_info=True)

    def shutdown(self) -> None:
        global _active
        if self._owns_instrumentation:
            try:
                LangChainInstrumentor().uninstrument()
            except Exception:
                logger.debug("uninstrument failed", exc_info=True)
        _deactivate_runholder()
        uninstall()
        self.flush()
        try:
            if self._owns_provider:
                self.provider.shutdown()
            elif self._processor is not None:
                self._processor.shutdown()
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
        processor = None
        if tracer_provider is not None:
            # Attach mode: export to Netra through the USER's provider by
            # adding our processor to it (post-review S-C2 — previously the
            # documented attach mode exported nothing to Netra).
            provider, owns = tracer_provider, False
            processor = build_processor(cfg)
            provider.add_span_processor(processor)
        else:
            provider, owns = build_provider(cfg), True
        li = LangChainInstrumentor()
        owns_instrumentation = not getattr(
            li, "is_instrumented_by_opentelemetry", False
        )
        if owns_instrumentation:
            li.instrument(tracer_provider=provider)
        else:
            # Already instrumented (e.g. Phoenix): LangChain spans keep
            # flowing to the EXISTING provider — pass tracer_provider= to
            # route them through Netra too. We only add propagation.
            logger.info(
                "LangChainInstrumentor already active; netra-observe will "
                "propagate trace context but LangChain spans export via the "
                "pre-existing instrumentation's provider"
            )
        _activate_runholder()
        install(cfg.gateway_host)
        _active = NetraInstrumentation(provider, owns, owns_instrumentation, processor)
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
        _deactivate_runholder()
        uninstall()
