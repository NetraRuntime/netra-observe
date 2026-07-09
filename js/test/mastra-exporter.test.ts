import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@mastra/core/observability", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("@mastra/core/observability")>()
    return { ...actual, resolveCurrentSpan: vi.fn() }
})
import {
    SpanType,
    TracingEventType,
    resolveCurrentSpan,
} from "@mastra/core/observability"
import type { AnyExportedSpan, TracingEvent } from "@mastra/core/observability"
import { createServer, type Server } from "node:http"
import { NetraExporter } from "../src/mastra/index.js"

const mockResolveCurrentSpan = resolveCurrentSpan as unknown as ReturnType<
    typeof vi.fn
>

function capture(): Promise<{
    host: string
    got: Record<string, string | string[] | undefined>[]
    close: () => void
}> {
    return new Promise((resolve) => {
        const got: Record<string, string | string[] | undefined>[] = []
        const srv: Server = createServer((req, res) => {
            got.push(req.headers)
            res.writeHead(200).end("ok")
        })
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as { port: number }).port
            resolve({
                host: `127.0.0.1:${port}`,
                got,
                close: () => srv.close(),
            })
        })
    })
}

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
    mockResolveCurrentSpan.mockReset()
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

    it("reverse-order teardown: the first exporter's shutdown leaves the patch installed for the survivor", async () => {
        const cap = await capture()
        mockResolveCurrentSpan.mockReturnValue({
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            id: "00f067aa0ba902b7",
        })
        const opts = { apiKey: "k", endpoint: `http://${cap.host}/otel` }
        const first = new NetraExporter(opts)
        const patched = globalThis.fetch
        const second = new NetraExporter(opts)
        expect(globalThis.fetch).toBe(patched)

        // Out-of-order teardown: the FIRST exporter shuts down first.
        await first.shutdown()
        expect(globalThis.fetch).not.toBe(origFetch)
        expect(globalThis.fetch).toBe(patched)

        // The survivor's join still works — the gateway request still
        // carries the traceparent.
        await fetch(`http://${cap.host}/v1/chat/completions`)
        expect(cap.got[0]["traceparent"]).toBe(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        )

        await second.shutdown()
        expect(globalThis.fetch).toBe(origFetch)
        cap.close()
    })

    it("a sibling's shutdown does not remove the shared span source needed by a surviving exporter's join", async () => {
        const cap = await capture()
        mockResolveCurrentSpan.mockReturnValue({
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            id: "00f067aa0ba902b7",
        })
        const opts = { apiKey: "k", endpoint: `http://${cap.host}/otel` }
        // owner is created first, so it owns the fetch patch; sibling shares
        // both the patch and the (dedup-on-identity) mastraSpanContext source.
        const owner = new NetraExporter(opts)
        const sibling = new NetraExporter(opts)

        await sibling.shutdown()

        // Without the ref-count fix, sibling.shutdown() would have removed
        // mastraSpanContext outright, and owner's join would silently fall
        // back to the (absent) OTel active span — no traceparent header.
        await fetch(`http://${cap.host}/v1/chat/completions`)
        expect(cap.got[0]["traceparent"]).toBe(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        )

        await owner.shutdown()
        expect(globalThis.fetch).toBe(origFetch)
        cap.close()
    })

    it("a disabled exporter's shutdown does not remove a healthy sibling's span source", async () => {
        const cap = await capture()
        mockResolveCurrentSpan.mockReturnValue({
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            id: "00f067aa0ba902b7",
        })
        const healthy = new NetraExporter({
            apiKey: "k",
            endpoint: `http://${cap.host}/otel`,
        })
        // NETRA_API_KEY is stubbed to "" in beforeEach, so this constructor
        // hits the resolveConfig() catch branch and returns before ever
        // calling addSpanContextSource().
        const disabled = new NetraExporter()
        expect(warn).toHaveBeenCalledTimes(1)

        await disabled.shutdown()

        await fetch(`http://${cap.host}/v1/chat/completions`)
        expect(cap.got[0]["traceparent"]).toBe(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        )

        await healthy.shutdown()
        cap.close()
    })

    it("flush and shutdown are bounded by a timeout — a hung processor does not hang them", async () => {
        const exp = new NetraExporter(OPTS)
        const proc = {
            onEnd: vi.fn(),
            forceFlush: vi.fn(() => new Promise<void>(() => {})),
            shutdown: vi.fn(() => new Promise<void>(() => {})),
        }
        ;(exp as any).processor = proc

        await expect(exp.flush(50)).resolves.toBeUndefined()
        await expect(exp.shutdown(50)).resolves.toBeUndefined()
    })

    it("malformed endpoint: warns once, disabled, never throws, no patch", async () => {
        const exp = new NetraExporter({ apiKey: "k", endpoint: "not a url" })
        expect(warn).toHaveBeenCalledTimes(1)
        expect(globalThis.fetch).toBe(origFetch)
        await expect(exp.shutdown()).resolves.toBeUndefined()
    })
})
