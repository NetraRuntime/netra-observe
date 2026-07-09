import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api"
import type { Attributes, HrTime } from "@opentelemetry/api"
import type { Resource } from "@opentelemetry/resources"
import type { ReadableSpan, TimedEvent } from "@opentelemetry/sdk-trace-base"
import { SpanType } from "@mastra/core/observability"
import type { AnyExportedSpan } from "@mastra/core/observability"

import { VERSION } from "../instrument.js"

const SCOPE = { name: "@netra/observe/mastra", version: VERSION }

function oiSpanKind(type: SpanType): string {
    switch (type) {
        case SpanType.MODEL_GENERATION:
        case SpanType.MODEL_STEP:
        case SpanType.MODEL_INFERENCE:
        case SpanType.MODEL_CHUNK:
            return "LLM"
        case SpanType.TOOL_CALL:
        case SpanType.MCP_TOOL_CALL:
        case SpanType.CLIENT_TOOL_CALL:
            return "TOOL"
        case SpanType.AGENT_RUN:
            return "AGENT"
        case SpanType.RAG_EMBEDDING:
            return "EMBEDDING"
        case SpanType.RAG_VECTOR_OPERATION:
            return "RETRIEVER"
        default:
            return "CHAIN"
    }
}

function setValue(
    attrs: Attributes,
    prefix: "input" | "output",
    value: unknown
): void {
    if (value === undefined || value === null) return
    if (typeof value === "string") {
        attrs[`${prefix}.value`] = value
        attrs[`${prefix}.mime_type`] = "text/plain"
        return
    }
    try {
        attrs[`${prefix}.value`] = JSON.stringify(value)
        attrs[`${prefix}.mime_type`] = "application/json"
    } catch {
        /* unserializable (circular) — drop the value, keep the span */
    }
}

function hrTime(d: Date): HrTime {
    const ms = d.getTime()
    return [Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)]
}

function hrDuration(start: Date, end: Date): HrTime {
    const ns = Math.max(0, (end.getTime() - start.getTime()) * 1e6)
    return [Math.floor(ns / 1e9), Math.round(ns % 1e9)]
}

/** Untyped view of the span-type-specific attributes we read. Mastra types
 * these per SpanType; we only touch fields shared by the model_* family. */
interface ModelishAttributes {
    model?: string
    responseModel?: string
    provider?: string
    usage?: { inputTokens?: number; outputTokens?: number }
    parameters?: Record<string, unknown>
}

/** Convert an ended Mastra exported span to an OpenInference-conventioned
 * OTel ReadableSpan. Trace/span/parent ids are Mastra's, verbatim — the
 * same ids the fetch patch injects, which is what joins the gateway record
 * to this exported span. */
export function convertSpan(
    span: AnyExportedSpan,
    resource: Resource
): ReadableSpan {
    const kind = oiSpanKind(span.type)
    const attrs: Attributes = { "openinference.span.kind": kind }

    setValue(attrs, "input", span.input)
    setValue(attrs, "output", span.output)

    if (span.metadata && Object.keys(span.metadata).length > 0) {
        try {
            attrs["metadata"] = JSON.stringify(span.metadata)
        } catch {
            /* unserializable metadata — skip */
        }
    }
    if (span.isRootSpan && span.tags?.length) attrs["tag.tags"] = span.tags

    if (kind === "LLM") {
        const a = (span.attributes ?? {}) as ModelishAttributes
        const model = a.responseModel ?? a.model
        if (model) attrs["llm.model_name"] = model
        if (a.provider) attrs["llm.provider"] = a.provider
        if (a.parameters) {
            try {
                attrs["llm.invocation_parameters"] = JSON.stringify(
                    a.parameters
                )
            } catch {
                /* skip */
            }
        }
        const prompt = a.usage?.inputTokens
        const completion = a.usage?.outputTokens
        if (prompt != null) attrs["llm.token_count.prompt"] = prompt
        if (completion != null)
            attrs["llm.token_count.completion"] = completion
        if (prompt != null || completion != null)
            attrs["llm.token_count.total"] = (prompt ?? 0) + (completion ?? 0)
    }

    if (kind === "TOOL") attrs["tool.name"] = span.entityName ?? span.name

    const end = span.endTime ?? span.startTime
    const endHr = hrTime(end)

    const events: TimedEvent[] = span.errorInfo
        ? [
              {
                  name: "exception",
                  time: endHr,
                  attributes: {
                      "exception.message": span.errorInfo.message,
                      ...(span.errorInfo.name && {
                          "exception.type": span.errorInfo.name,
                      }),
                      ...(span.errorInfo.stack && {
                          "exception.stacktrace": span.errorInfo.stack,
                      }),
                  },
                  droppedAttributesCount: 0,
              },
          ]
        : []

    return {
        name: span.name,
        kind: SpanKind.INTERNAL,
        spanContext: () => ({
            traceId: span.traceId,
            spanId: span.id,
            traceFlags: TraceFlags.SAMPLED,
            isRemote: false,
        }),
        parentSpanContext: span.parentSpanId
            ? {
                  traceId: span.traceId,
                  spanId: span.parentSpanId,
                  traceFlags: TraceFlags.SAMPLED,
                  isRemote: false,
              }
            : undefined,
        startTime: hrTime(span.startTime),
        endTime: endHr,
        duration: hrDuration(span.startTime, end),
        ended: true,
        status: span.errorInfo
            ? { code: SpanStatusCode.ERROR, message: span.errorInfo.message }
            : { code: SpanStatusCode.OK },
        attributes: attrs,
        links: [],
        events,
        resource,
        instrumentationScope: SCOPE,
        droppedAttributesCount: 0,
        droppedEventsCount: 0,
        droppedLinksCount: 0,
    }
}
