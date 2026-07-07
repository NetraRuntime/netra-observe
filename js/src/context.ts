import { context, trace } from "@opentelemetry/api"

/** The trace/span ids of the OTel span active in the current context, or
 * undefined when none is active or it's invalid.
 *
 * The propagation mechanism (validated by the Task 1 spike): the OpenInference
 * OpenAI / Anthropic instrumentations — and the Vercel AI SDK — wrap each LLM
 * call in an ACTIVE span (`context.with(trace.setSpan(...))`). Since Netra's
 * gateway is OpenAI-compatible and users point their client (or LangChain's
 * ChatOpenAI) at it, that active span is present when the outbound request
 * fires. Reading it here lets the fetch patch inject its traceparent, so the
 * ledger row joins to that exact LLM span. Propagation-only: we never start a
 * span of our own. */
export function activeSpanContext():
    | { traceId: string; spanId: string }
    | undefined {
    const span = trace.getSpan(context.active())
    if (!span) return undefined
    const sc = span.spanContext()
    if (!sc.traceId || !sc.spanId) return undefined
    if (sc.traceId === "0".repeat(32) || sc.spanId === "0".repeat(16))
        return undefined
    return { traceId: sc.traceId, spanId: sc.spanId }
}
