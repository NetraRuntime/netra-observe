from __future__ import annotations

from netra_observe._config import resolve
from netra_observe._provider import build_exporter, build_provider, build_resource


def cfg(**kw):
    kw.setdefault("api_key", "sk_live_k")
    return resolve(**kw)


def test_resource_attrs():
    r = build_resource(cfg(project="support-agent", environment="prod"))
    a = r.attributes
    assert a["netra.project"] == "support-agent"
    assert a["deployment.environment"] == "prod"
    assert a["service.name"] == "support-agent"


def test_resource_defaults():
    a = build_resource(cfg()).attributes
    assert a["service.name"] == "netra-observe"
    assert "netra.project" not in a and "deployment.environment" not in a


def test_agent_resource_attribute():
    r = build_resource(cfg(project="support", agent="triage-bot"))
    assert r.attributes["gen_ai.agent.name"] == "triage-bot"


def test_no_agent_attribute_when_unset():
    assert "gen_ai.agent.name" not in build_resource(cfg()).attributes


def test_exporter_endpoint_and_auth():
    e = build_exporter(cfg(endpoint="http://localhost:9999/v1/otel"))
    assert e._endpoint == "http://localhost:9999/v1/otel/v1/traces"
    # header key case varies across otlp-exporter versions — compare folded
    headers = {k.lower(): v for k, v in dict(e._headers).items()}
    assert headers.get("authorization") == "Bearer sk_live_k"


def test_provider_has_batch_processor():
    p = build_provider(cfg())
    # TracerProvider stores processors on a composite; presence is enough.
    assert p._active_span_processor._span_processors  # non-empty
    p.shutdown()
