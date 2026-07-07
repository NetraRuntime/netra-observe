from __future__ import annotations

import httpx
import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from netra_observe._inject import install, uninstall


@pytest.fixture(autouse=True)
def _clean_patch():
    yield
    uninstall()


def _tracer():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider.get_tracer("test"), exporter


def test_injects_ambient_span_for_gateway_host(capture_server):
    host, captured = capture_server
    install(host)
    tracer, exporter = _tracer()
    with tracer.start_as_current_span("llm call"):
        httpx.get(f"http://{host}/v1/chat/completions")
    assert len(captured) == 1
    tp = captured[0].get("traceparent")
    assert tp is not None
    span = exporter.get_finished_spans()[0]
    assert format(span.context.trace_id, "032x") in tp
    assert format(span.context.span_id, "016x") in tp


def test_no_injection_for_other_hosts(capture_server):
    host, captured = capture_server
    install("api.netraruntime.com")  # patch active, but scope differs
    tracer, _ = _tracer()
    with tracer.start_as_current_span("llm call"):
        httpx.get(f"http://{host}/anything")
    assert "traceparent" not in captured[0]


def test_no_span_no_header(capture_server):
    host, captured = capture_server
    install(host)
    httpx.get(f"http://{host}/v1/chat/completions")
    assert "traceparent" not in captured[0]


def test_install_idempotent_and_uninstall_restores(capture_server):
    host, captured = capture_server
    original = httpx.Client.send
    install(host)
    install(host)  # second call must not double-wrap
    patched = httpx.Client.send
    uninstall()
    assert httpx.Client.send is original
    uninstall()  # second uninstall is a no-op
    assert httpx.Client.send is original
    assert patched is not original


def test_langchain_run_span_wins_over_ambient(capture_server):
    """Inside a LangChain run, the OpenInference run span (not ambient
    context) must be the injected parent — that's the ledger-join contract."""
    from langchain_core.runnables import RunnableLambda
    from openinference.instrumentation.langchain import LangChainInstrumentor

    host, captured = capture_server
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    LangChainInstrumentor().instrument(tracer_provider=provider)
    try:
        install(host)
        RunnableLambda(
            lambda _: httpx.get(f"http://{host}/v1/chat/completions").status_code,
            name="fake llm",
        ).invoke("hi")
    finally:
        LangChainInstrumentor().uninstrument()
    tp = captured[0].get("traceparent")
    assert tp is not None
    run_span = exporter.get_finished_spans()[0]
    assert format(run_span.context.trace_id, "032x") in tp
    assert format(run_span.context.span_id, "016x") in tp
