import { resolveCurrentSpan } from "@mastra/core/observability"

const TRACE_ID = /^[0-9a-f]{32}$/
const SPAN_ID = /^[0-9a-f]{16}$/

/** Span-context source (see inject.ts) reading the live Mastra span from
 * Mastra's AsyncLocalStorage. Mastra wraps model calls in
 * executeWithContext(modelSpan, …), so during the outbound gateway fetch
 * this yields the model span whose ids the exporter also ships — the join.
 * Returns undefined outside a Mastra run or when ids aren't W3C-shaped. */
export function mastraSpanContext():
    | { traceId: string; spanId: string }
    | undefined {
    try {
        const span = resolveCurrentSpan()
        if (!span) return undefined
        const traceId = String(span.traceId ?? "").toLowerCase()
        const spanId = String(span.id ?? "").toLowerCase()
        if (!TRACE_ID.test(traceId) || !SPAN_ID.test(spanId)) return undefined
        if (traceId === "0".repeat(32) || spanId === "0".repeat(16))
            return undefined
        return { traceId, spanId }
    } catch {
        return undefined
    }
}
