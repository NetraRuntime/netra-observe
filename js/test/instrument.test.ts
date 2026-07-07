import { describe, it, expect, afterEach } from "vitest"
import { context, trace } from "@opentelemetry/api"
import { instrument, VERSION } from "../src/instrument.js"
import type { NetraInstrumentation } from "../src/instrument.js"
import { activeSpanContext } from "../src/context.js"

let handle: NetraInstrumentation | null = null
afterEach(async () => {
    await handle?.shutdown()
    handle = null
})

describe("instrument", () => {
    it("returns a handle, exposes the version, and is idempotent", () => {
        handle = instrument({ apiKey: "ntr_k", endpoint: "http://localhost:9/v1/otel" })
        const again = instrument({ apiKey: "ntr_k" })
        expect(again).toBe(handle)
        expect(VERSION).toBe("0.1.0")
    })

    it("shutdown restores global fetch", async () => {
        const original = globalThis.fetch
        handle = instrument({ apiKey: "ntr_k", endpoint: "http://localhost:9/v1/otel" })
        expect(globalThis.fetch).not.toBe(original)
        await handle.shutdown()
        handle = null
        expect(globalThis.fetch).toBe(original)
    })

    it("registers an async context manager so active spans are readable", () => {
        handle = instrument({ apiKey: "ntr_k", endpoint: "http://localhost:9/v1/otel" })
        const tracer = handle.provider.getTracer("test")
        const span = tracer.startSpan("llm")
        const sc = context.with(trace.setSpan(context.active(), span), () =>
            activeSpanContext()
        )
        span.end()
        expect(sc?.traceId).toMatch(/^[0-9a-f]{32}$/)
        expect(sc?.spanId).toBe(span.spanContext().spanId)
    })
})
