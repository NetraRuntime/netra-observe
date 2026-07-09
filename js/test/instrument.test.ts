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

    it("shutdown leaves the patch installed while another installer is live", async () => {
        const original = globalThis.fetch
        // Simulate a prior installer of the fetch patch (e.g. a live
        // NetraExporter) that installed before instrument() ran. Ref count: 1.
        install("some-host")
        const priorPatched = globalThis.fetch
        expect(priorPatched).not.toBe(original)

        // instrument()'s install() retargets the host and bumps the ref
        // count to 2 — the existing patch identity is unchanged.
        handle = instrument({
            apiKey: "ntr_k",
            endpoint: "http://localhost:9/v1/otel",
        })
        expect(globalThis.fetch).toBe(priorPatched)

        // instrument()'s shutdown() decrements to 1 — the patch, shared with
        // the still-live prior installer, must remain.
        await handle.shutdown()
        handle = null
        expect(globalThis.fetch).toBe(priorPatched)

        // The prior installer's own uninstall() brings the count to 0 and
        // restores the original fetch.
        uninstall()
        expect(globalThis.fetch).toBe(original)
    })

    it("a second shutdown() call is a no-op — it does not over-decrement the shared install ref-count", async () => {
        const original = globalThis.fetch
        // External installer, count 1.
        install("some-host")
        const priorPatched = globalThis.fetch

        // instrument()'s install() bumps the ref count to 2.
        handle = instrument({
            apiKey: "ntr_k",
            endpoint: "http://localhost:9/v1/otel",
        })
        expect(globalThis.fetch).toBe(priorPatched)

        // First shutdown() decrements to 1 — the shared patch survives.
        await handle.shutdown()
        expect(globalThis.fetch).toBe(priorPatched)

        // A second shutdown() call must resolve immediately without
        // re-running uninstall() (which would incorrectly decrement the
        // ref count to 0 and unpatch fetch out from under the still-live
        // external installer).
        await handle.shutdown()
        expect(globalThis.fetch).toBe(priorPatched)
        handle = null

        // The external installer's own uninstall() still restores cleanly.
        uninstall()
        expect(globalThis.fetch).toBe(original)
    })
})
