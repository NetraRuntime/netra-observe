from __future__ import annotations

from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from ._config import Config


def build_resource(cfg: Config) -> Resource:
    attrs = {"service.name": cfg.project or "netra-observe"}
    if cfg.project:
        attrs["netra.project"] = cfg.project
    if cfg.agent:
        attrs["gen_ai.agent.name"] = cfg.agent
    if cfg.environment:
        attrs["deployment.environment"] = cfg.environment
    return Resource.create(attrs)


def build_exporter(cfg: Config) -> OTLPSpanExporter:
    return OTLPSpanExporter(
        endpoint=cfg.endpoint + "/v1/traces",
        headers={"Authorization": f"Bearer {cfg.api_key}"},
    )


def build_processor(cfg: Config) -> BatchSpanProcessor:
    return BatchSpanProcessor(build_exporter(cfg))


def build_provider(cfg: Config) -> TracerProvider:
    provider = TracerProvider(resource=build_resource(cfg))
    provider.add_span_processor(build_processor(cfg))
    return provider
