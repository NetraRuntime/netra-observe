import {
    resourceFromAttributes,
    type Resource,
} from "@opentelemetry/resources"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import type { NetraConfig } from "./config.js"

export function buildResource(cfg: NetraConfig): Resource {
    const attrs: Record<string, string> = {
        "service.name": cfg.project ?? "netra-observe",
    }
    if (cfg.project) attrs["netra.project"] = cfg.project
    if (cfg.environment) attrs["deployment.environment"] = cfg.environment
    return resourceFromAttributes(attrs)
}

export function buildExporter(cfg: NetraConfig): OTLPTraceExporter {
    return new OTLPTraceExporter({
        url: `${cfg.endpoint}/v1/traces`,
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
    })
}

export function buildProcessor(cfg: NetraConfig): BatchSpanProcessor {
    return new BatchSpanProcessor(buildExporter(cfg))
}

export function buildProvider(cfg: NetraConfig): NodeTracerProvider {
    return new NodeTracerProvider({
        resource: buildResource(cfg),
        spanProcessors: [buildProcessor(cfg)],
    })
}
