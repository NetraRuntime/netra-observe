import { describe, it, expect, afterEach } from "vitest"
import { context, trace } from "@opentelemetry/api"
import { instrument, VERSION } from "../src/instrument.js"
import type { NetraInstrumentation } from "../src/instrument.js"
import { activeSpanContext } from "../src/context.js"
import { install, uninstall } from "../src/inject.js"

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

    it("does not uninstall a fetch patch it does not own", async () => {
        const original = globalThis.fetch
        // Simulate a prior owner of the fetch patch (e.g. a live
        // NetraExporter) that installed before instrument() ran.
        expect(install("some-host")).toBe(true)
        const priorPatched = globalThis.fetch
        expect(priorPatched).not.toBe(original)

        handle = instrument({
            apiKey: "ntr_k",
            endpoint: "http://localhost:9/v1/otel",
        })
        // install() is idempotent — instrument()'s call retargeted the host
        // but did not perform a new patch, so it does not own it.
        expect(globalThis.fetch).toBe(priorPatched)

        await handle.shutdown()
        handle = null
        // The patch instrument() doesn't own must survive its shutdown.
        expect(globalThis.fetch).toBe(priorPatched)

        // The prior owner's uninstall() still restores the original fetch.
        uninstall()
        expect(globalThis.fetch).toBe(original)
    })
})
