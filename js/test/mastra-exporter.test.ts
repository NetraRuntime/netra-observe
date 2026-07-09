import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SpanType, TracingEventType } from "@mastra/core/observability"
import type { AnyExportedSpan, TracingEvent } from "@mastra/core/observability"
import { NetraExporter } from "../src/mastra/index.js"

const OPTS = { apiKey: "k", endpoint: "http://127.0.0.1:1/otel" }

function endedEvent(over: Partial<AnyExportedSpan> = {}): TracingEvent {
    return {
        type: TracingEventType.SPAN_ENDED,
        exportedSpan: {
            id: "00f067aa0ba902b7",
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            name: "s",
            type: SpanType.MODEL_GENERATION,
            startTime: new Date(),
            endTime: new Date(),
            isRootSpan: false,
            isEvent: false,
            ...over,
        } as AnyExportedSpan,
    }
}

function fakeProcessor() {
    return {
        onEnd: vi.fn(),
        forceFlush: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
    }
}

const origFetch = globalThis.fetch
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubEnv("NETRA_API_KEY", "")
})

afterEach(async () => {
    warn.mockRestore()
    vi.unstubAllEnvs()
    globalThis.fetch = origFetch
})

describe("NetraExporter", () => {
    it("without config: warns once, disabled, never throws, no patch", async () => {
        const exp = new NetraExporter()
        expect(warn).toHaveBeenCalledTimes(1)
        expect(globalThis.fetch).toBe(origFetch)
        await expect(exp.exportTracingEvent(endedEvent())).resolves.toBeUndefined()
        await expect(exp.flush()).resolves.toBeUndefined()
        await expect(exp.shutdown()).resolves.toBeUndefined()
    })

    it("with config: patches fetch and converts SPAN_ENDED into the processor", async () => {
        const exp = new NetraExporter(OPTS)
        expect(globalThis.fetch).not.toBe(origFetch)
        const proc = fakeProcessor()
        ;(exp as any).processor = proc

        await exp.exportTracingEvent(endedEvent())
        expect(proc.onEnd).toHaveBeenCalledTimes(1)
        const readable = proc.onEnd.mock.calls[0][0]
        expect(readable.spanContext().traceId).toBe(
            "4bf92f3577b34da6a3ce929d0e0e4736"
        )
        expect(readable.spanContext().spanId).toBe("00f067aa0ba902b7")
        expect(readable.attributes["openinference.span.kind"]).toBe("LLM")
        await exp.shutdown()
    })

    it("ignores SPAN_STARTED and SPAN_UPDATED", async () => {
        const exp = new NetraExporter(OPTS)
        const proc = fakeProcessor()
        ;(exp as any).processor = proc
        const span = endedEvent().exportedSpan
        await exp.exportTracingEvent({
            type: TracingEventType.SPAN_STARTED,
            exportedSpan: span,
        })
        await exp.exportTracingEvent({
            type: TracingEventType.SPAN_UPDATED,
            exportedSpan: span,
        })
        expect(proc.onEnd).not.toHaveBeenCalled()
        await exp.shutdown()
    })

    it("a converter blow-up is swallowed, not thrown into Mastra", async () => {
        const exp = new NetraExporter(OPTS)
        const proc = fakeProcessor()
        proc.onEnd.mockImplementation(() => {
            throw new Error("boom")
        })
        ;(exp as any).processor = proc
        await expect(exp.exportTracingEvent(endedEvent())).resolves.toBeUndefined()
        await exp.shutdown()
    })

    it("flush and shutdown delegate to the processor; shutdown restores fetch", async () => {
        const exp = new NetraExporter(OPTS)
        const proc = fakeProcessor()
        ;(exp as any).processor = proc
        await exp.flush()
        expect(proc.forceFlush).toHaveBeenCalledTimes(1)
        await exp.shutdown()
        expect(proc.shutdown).toHaveBeenCalledTimes(1)
        expect(globalThis.fetch).toBe(origFetch)
    })

    it("second exporter does not double-patch nor un-patch on its shutdown", async () => {
        const first = new NetraExporter(OPTS)
        const patched = globalThis.fetch
        const second = new NetraExporter(OPTS)
        expect(globalThis.fetch).toBe(patched)
        await second.shutdown()
        expect(globalThis.fetch).toBe(patched)
        await first.shutdown()
        expect(globalThis.fetch).toBe(origFetch)
    })
})
