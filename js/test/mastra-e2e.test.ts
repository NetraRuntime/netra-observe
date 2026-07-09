import { describe, it, expect, afterEach, vi } from "vitest"
import { createServer, type Server } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import { Agent } from "@mastra/core/agent"
import { Mastra } from "@mastra/core/mastra"
import { TracingEventType } from "@mastra/core/observability"
import type { AnyExportedSpan, TracingEvent } from "@mastra/core/observability"
import { Observability } from "@mastra/observability"
import { NetraExporter } from "../src/mastra/index.js"

/** One host plays both Netra roles: OpenAI-compatible gateway
 * (/v1/chat/completions) and OTLP collector (/v1/traces). */
function mockNetra(): Promise<{
    port: number
    chat: IncomingHttpHeaders[]
    otlp: IncomingHttpHeaders[]
    close: () => void
}> {
    return new Promise((resolve) => {
        const chat: IncomingHttpHeaders[] = []
        const otlp: IncomingHttpHeaders[] = []
        const srv: Server = createServer((req, res) => {
            if (req.url?.endsWith("/v1/traces")) {
                otlp.push(req.headers)
                req.resume()
                req.on("end", () => res.writeHead(200).end())
                return
            }
            chat.push(req.headers)
            res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                    id: "chatcmpl-e2e",
                    object: "chat.completion",
                    created: 0,
                    model: "test-model",
                    choices: [
                        {
                            index: 0,
                            message: { role: "assistant", content: "hi" },
                            finish_reason: "stop",
                        },
                    ],
                    usage: {
                        prompt_tokens: 1,
                        completion_tokens: 1,
                        total_tokens: 2,
                    },
                })
            )
        })
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as { port: number }).port
            resolve({ port, chat, otlp, close: () => srv.close() })
        })
    })
}

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
    await cleanup?.()
    cleanup = null
})

describe("mastra e2e: export + gateway join", () => {
    it("injected traceparent matches an exported span; OTLP arrives with auth", async () => {
        const netra = await mockNetra()

        const exporter = new NetraExporter({
            apiKey: "test-api-key",
            endpoint: `http://127.0.0.1:${netra.port}`,
        })
        cleanup = async () => {
            await exporter.shutdown()
            netra.close()
        }

        const ended: AnyExportedSpan[] = []
        const capture = {
            name: "capture",
            exportTracingEvent: async (e: TracingEvent) => {
                if (e.type === TracingEventType.SPAN_ENDED)
                    ended.push(e.exportedSpan)
            },
            flush: async () => {},
            shutdown: async () => {},
        }

        const agent = new Agent({
            name: "e2e",
            instructions: "Answer briefly.",
            model: {
                providerId: "netra",
                modelId: "test-model",
                url: `http://127.0.0.1:${netra.port}/v1`,
                apiKey: "test-key",
            },
        })
        const mastra = new Mastra({
            agents: { e2e: agent },
            observability: new Observability({
                configs: {
                    netra: {
                        serviceName: "e2e",
                        exporters: [exporter, capture],
                    },
                },
            }),
        })

        await mastra.getAgent("e2e").generate("hello")
        // SPAN_ENDED delivery can lag the generate() return by a tick — poll
        // until both the gateway call and the exported span have landed.
        await vi.waitFor(
            () => {
                expect(netra.chat.length).toBeGreaterThan(0)
                expect(ended.length).toBeGreaterThan(0)
            },
            { timeout: 2000 }
        )

        // Join lane: the model call carried a traceparent…
        expect(netra.chat.length).toBeGreaterThan(0)
        const tp = netra.chat[0]["traceparent"] as string
        expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
        const [, traceId, spanId] = tp.split("-")

        // …whose ids belong to spans Mastra exported (same ids the
        // NetraExporter ships to OTLP — converter uses them verbatim).
        expect(ended.length).toBeGreaterThan(0)
        expect(ended.some((s) => s.traceId === traceId)).toBe(true)
        expect(ended.some((s) => s.id === spanId)).toBe(true)

        // Export lane: flushed OTLP batch reached /v1/traces with auth.
        await exporter.flush()
        expect(netra.otlp.length).toBeGreaterThan(0)
        expect(netra.otlp[0]["authorization"]).toBe("Bearer test-api-key")
    })
})
