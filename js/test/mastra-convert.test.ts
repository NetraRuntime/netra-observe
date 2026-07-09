import { describe, it, expect } from "vitest"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api"
import { SpanType } from "@mastra/core/observability"
import type { AnyExportedSpan } from "@mastra/core/observability"
import { convertSpan } from "../src/mastra/convert.js"

const resource = resourceFromAttributes({ "service.name": "t" })
const T0 = new Date("2026-07-09T00:00:00.000Z")
const T1 = new Date("2026-07-09T00:00:01.500Z")

function base(over: Partial<AnyExportedSpan> = {}): AnyExportedSpan {
    return {
        id: "00f067aa0ba902b7",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        name: "span",
        type: SpanType.GENERIC,
        startTime: T0,
        endTime: T1,
        isRootSpan: false,
        isEvent: false,
        ...over,
    } as AnyExportedSpan
}

describe("convertSpan", () => {
    it("model_generation → LLM with ids verbatim and token counts", () => {
        const s = convertSpan(
            base({
                type: SpanType.MODEL_GENERATION,
                name: "gen",
                parentSpanId: "aaaaaaaaaaaaaaaa",
                input: [{ role: "user", content: "hi" }],
                output: { role: "assistant", content: "hello" },
                attributes: {
                    model: "gpt-4o-mini",
                    provider: "openai",
                    usage: { inputTokens: 7, outputTokens: 3 },
                    parameters: { temperature: 0 },
                },
            }),
            resource
        )
        expect(s.spanContext().traceId).toBe(
            "4bf92f3577b34da6a3ce929d0e0e4736"
        )
        expect(s.spanContext().spanId).toBe("00f067aa0ba902b7")
        expect(s.spanContext().traceFlags).toBe(TraceFlags.SAMPLED)
        expect(s.parentSpanContext?.spanId).toBe("aaaaaaaaaaaaaaaa")
        expect(s.kind).toBe(SpanKind.INTERNAL)
        expect(s.attributes["openinference.span.kind"]).toBe("LLM")
        expect(s.attributes["llm.model_name"]).toBe("gpt-4o-mini")
        expect(s.attributes["llm.provider"]).toBe("openai")
        expect(s.attributes["llm.invocation_parameters"]).toBe(
            JSON.stringify({ temperature: 0 })
        )
        expect(s.attributes["llm.token_count.prompt"]).toBe(7)
        expect(s.attributes["llm.token_count.completion"]).toBe(3)
        expect(s.attributes["llm.token_count.total"]).toBe(10)
        expect(s.attributes["input.mime_type"]).toBe("application/json")
        expect(s.attributes["output.mime_type"]).toBe("application/json")
        expect(JSON.parse(String(s.attributes["input.value"]))).toEqual([
            { role: "user", content: "hi" },
        ])
        expect(s.ended).toBe(true)
        expect(s.status.code).toBe(SpanStatusCode.OK)
    })

    it("responseModel wins over model for llm.model_name", () => {
        const s = convertSpan(
            base({
                type: SpanType.MODEL_GENERATION,
                attributes: { model: "gpt-4o-mini", responseModel: "gpt-4o-mini-2026" },
            }),
            resource
        )
        expect(s.attributes["llm.model_name"]).toBe("gpt-4o-mini-2026")
    })

    it("tool_call → TOOL with tool.name from entityName", () => {
        const s = convertSpan(
            base({
                type: SpanType.TOOL_CALL,
                name: "tool run",
                entityName: "weather",
            }),
            resource
        )
        expect(s.attributes["openinference.span.kind"]).toBe("TOOL")
        expect(s.attributes["tool.name"]).toBe("weather")
    })

    it("agent_run root → AGENT with tags and metadata", () => {
        const s = convertSpan(
            base({
                type: SpanType.AGENT_RUN,
                isRootSpan: true,
                tags: ["prod", "beta"],
                metadata: { userId: "u1" },
            }),
            resource
        )
        expect(s.attributes["openinference.span.kind"]).toBe("AGENT")
        expect(s.attributes["tag.tags"]).toEqual(["prod", "beta"])
        expect(s.attributes["metadata"]).toBe(JSON.stringify({ userId: "u1" }))
    })

    it("workflow_step → CHAIN", () => {
        const s = convertSpan(base({ type: SpanType.WORKFLOW_STEP }), resource)
        expect(s.attributes["openinference.span.kind"]).toBe("CHAIN")
    })

    it("string input/output → text/plain", () => {
        const s = convertSpan(base({ input: "hi", output: "yo" }), resource)
        expect(s.attributes["input.value"]).toBe("hi")
        expect(s.attributes["input.mime_type"]).toBe("text/plain")
        expect(s.attributes["output.value"]).toBe("yo")
        expect(s.attributes["output.mime_type"]).toBe("text/plain")
    })

    it("errorInfo → ERROR status and exception event", () => {
        const s = convertSpan(
            base({
                errorInfo: {
                    message: "rate limited",
                    name: "APIError",
                    stack: "APIError: rate limited\n  at x",
                },
            }),
            resource
        )
        expect(s.status.code).toBe(SpanStatusCode.ERROR)
        expect(s.status.message).toBe("rate limited")
        expect(s.events).toHaveLength(1)
        expect(s.events[0].name).toBe("exception")
        expect(s.events[0].attributes?.["exception.message"]).toBe(
            "rate limited"
        )
        expect(s.events[0].attributes?.["exception.type"]).toBe("APIError")
        expect(s.events[0].attributes?.["exception.stacktrace"]).toBe(
            "APIError: rate limited\n  at x"
        )
    })

    it("event span (no endTime) → zero duration, still ended", () => {
        const s = convertSpan(
            base({ endTime: undefined, isEvent: true }),
            resource
        )
        expect(s.endTime).toEqual(s.startTime)
        expect(s.duration).toEqual([0, 0])
        expect(s.ended).toBe(true)
    })

    it("timing: 1.5s duration computed from start/end", () => {
        const s = convertSpan(base(), resource)
        expect(s.startTime).toEqual([Math.floor(T0.getTime() / 1000), 0])
        expect(s.duration).toEqual([1, 500_000_000])
    })

    it("rag_embedding → EMBEDDING and rag_vector_operation → RETRIEVER", () => {
        const e = convertSpan(base({ type: SpanType.RAG_EMBEDDING }), resource)
        expect(e.attributes["openinference.span.kind"]).toBe("EMBEDDING")
        const r = convertSpan(
            base({ type: SpanType.RAG_VECTOR_OPERATION }),
            resource
        )
        expect(r.attributes["openinference.span.kind"]).toBe("RETRIEVER")
    })

    it("circular input/metadata/parameters are dropped, span kept, no throw", () => {
        const circular: Record<string, unknown> = {}
        circular.self = circular
        const s = convertSpan(
            base({
                type: SpanType.MODEL_GENERATION,
                input: circular,
                metadata: { c: circular },
                attributes: { parameters: { c: circular } },
            }),
            resource
        )
        expect(s.attributes["input.value"]).toBeUndefined()
        expect(s.attributes["input.mime_type"]).toBeUndefined()
        expect(s.attributes["metadata"]).toBeUndefined()
        expect(s.attributes["llm.invocation_parameters"]).toBeUndefined()
        expect(s.spanContext().spanId).toBe("00f067aa0ba902b7")
    })

    it("partial usage: only inputTokens → prompt and total set, completion absent", () => {
        const s = convertSpan(
            base({
                type: SpanType.MODEL_GENERATION,
                attributes: { usage: { inputTokens: 5 } },
            }),
            resource
        )
        expect(s.attributes["llm.token_count.prompt"]).toBe(5)
        expect(s.attributes["llm.token_count.completion"]).toBeUndefined()
        expect(s.attributes["llm.token_count.total"]).toBe(5)
    })
})
