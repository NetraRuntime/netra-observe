from __future__ import annotations

import httpx
import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import netra_observe
from netra_observe import NetraInstrumentation, instrument


@pytest.fixture(autouse=True)
def _teardown():
    yield
    netra_observe._reset_for_tests()


def test_instrument_traces_a_langchain_run():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    handle = instrument(api_key="sk_live_k", tracer_provider=provider)
    assert isinstance(handle, NetraInstrumentation)

    from langchain_core.runnables import RunnableLambda

    RunnableLambda(lambda x: x + 1, name="step").invoke(1)
    handle.flush()
    names = [s.name for s in exporter.get_finished_spans()]
    assert "step" in names  # OpenInference traced the run


def test_instrument_is_idempotent():
    provider = TracerProvider()
    h1 = instrument(api_key="sk_live_k", tracer_provider=provider)
    h2 = instrument(api_key="sk_live_k", tracer_provider=provider)
    assert h1 is h2


def test_shutdown_restores_httpx():
    original = httpx.Client.send
    handle = instrument(api_key="sk_live_k", tracer_provider=TracerProvider())
    assert httpx.Client.send is not original
    handle.shutdown()
    assert httpx.Client.send is original


def test_attach_mode_does_not_own_provider():
    provider = TracerProvider()
    handle = instrument(api_key="sk_live_k", tracer_provider=provider)
    handle.shutdown()
    # user-owned provider must still be usable after our shutdown
    provider.get_tracer("t").start_span("still alive").end()
