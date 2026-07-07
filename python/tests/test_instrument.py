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


def test_attach_mode_adds_netra_exporter_to_user_provider():
    """Post-review S-C2: attach mode must actually export to Netra —
    instrument(tracer_provider=...) adds our BatchSpanProcessor to the
    user's provider."""
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider()
    before = len(provider._active_span_processor._span_processors)
    handle = instrument(
        api_key="sk_live_k",
        endpoint="http://localhost:9999/v1/otel",
        tracer_provider=provider,
    )
    procs = provider._active_span_processor._span_processors
    assert len(procs) == before + 1
    batch = [p for p in procs if isinstance(p, BatchSpanProcessor)]
    assert batch, "no BatchSpanProcessor attached in attach mode"
    exporter = batch[-1].span_exporter
    assert "localhost:9999/v1/otel/v1/traces" in exporter._endpoint
    handle.shutdown()


def test_does_not_uninstrument_preexisting_instrumentation():
    """Post-review S-I2: if LangChainInstrumentor was active before us
    (e.g. Phoenix), shutdown() must leave it active."""
    from openinference.instrumentation.langchain import LangChainInstrumentor

    li = LangChainInstrumentor()
    pre_provider = TracerProvider()
    li.instrument(tracer_provider=pre_provider)
    try:
        handle = instrument(api_key="sk_live_k", tracer_provider=TracerProvider())
        handle.shutdown()
        assert li.is_instrumented_by_opentelemetry, (
            "shutdown() tore down instrumentation it did not own"
        )
    finally:
        li.uninstrument()
