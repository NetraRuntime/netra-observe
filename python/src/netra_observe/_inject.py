from __future__ import annotations

import logging
from typing import Optional

import httpx
from opentelemetry import propagate
from opentelemetry import trace as trace_api

logger = logging.getLogger("netra_observe")

_original_send = None
_original_async_send = None
_gateway_host: Optional[str] = None


def _current_context():
    """Injection context, best source first (never raises):
    1. The OpenInference span for the LLM run recorded by our run-holder
       callback — exact in both bare-invoke and in-chain shapes.
    2. OpenInference's get_current_span() — inside a parent runnable this is
       the surrounding run's span (right trace, coarser node).
    3. None => propagate.inject falls back to ambient context.
    OpenInference keeps its spans OUT of ambient context by design, which is
    why 1 and 2 exist at all."""
    try:
        from openinference.instrumentation.langchain import (
            LangChainInstrumentor,
            get_current_span,
        )

        from ._runholder import current_llm_run_id

        run_id = current_llm_run_id()
        if run_id is not None:
            span = LangChainInstrumentor().get_span(run_id)
            if span is not None:
                return trace_api.set_span_in_context(span)
        span = get_current_span()
        if span is not None:
            return trace_api.set_span_in_context(span)
    except Exception:  # pragma: no cover - defensive
        logger.debug("injection context resolution failed", exc_info=True)
    return None  # None => propagate.inject uses ambient context


def _inject(request: httpx.Request) -> None:
    try:
        if _gateway_host is None or request.url.netloc.decode() != _gateway_host:
            return
        ctx = _current_context()
        if ctx is None and not trace_api.get_current_span().get_span_context().is_valid:
            return  # nothing to propagate
        carrier: dict = {}
        propagate.inject(carrier, context=ctx)
        for k, v in carrier.items():
            request.headers[k] = v
    except Exception:  # never break the host app
        logger.debug("traceparent injection failed", exc_info=True)


def install(gateway_host: str) -> None:
    global _original_send, _original_async_send, _gateway_host
    _gateway_host = gateway_host
    if _original_send is not None:
        return  # already installed; just retarget the host above

    _original_send = httpx.Client.send
    _original_async_send = httpx.AsyncClient.send

    def send(self, request, **kwargs):
        _inject(request)
        return _original_send(self, request, **kwargs)

    async def async_send(self, request, **kwargs):
        _inject(request)
        return await _original_async_send(self, request, **kwargs)

    httpx.Client.send = send
    httpx.AsyncClient.send = async_send


def uninstall() -> None:
    global _original_send, _original_async_send, _gateway_host
    if _original_send is not None:
        httpx.Client.send = _original_send
        httpx.AsyncClient.send = _original_async_send
        _original_send = _original_async_send = None
    _gateway_host = None
