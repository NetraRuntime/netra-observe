import { describe, it, expect, afterEach, vi } from "vitest"
import { createServer, type Server } from "node:http"

vi.mock("../src/context.js", () => ({ activeSpanContext: vi.fn() }))
import { activeSpanContext } from "../src/context.js"
import {
    install,
    uninstall,
    addSpanContextSource,
    removeSpanContextSource,
} from "../src/inject.js"

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

const mockActive = activeSpanContext as unknown as ReturnType<typeof vi.fn>

afterEach(() => {
    uninstall()
    mockActive.mockReset()
})

describe("inject", () => {
    it("injects the active span context for the gateway host", async () => {
        const cap = await capture()
        mockActive.mockReturnValue({
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "00f067aa0ba902b7",
        })
        install(cap.host)
        await fetch(`http://${cap.host}/v1/chat/completions`)
        expect(cap.got[0]["traceparent"]).toBe(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        )
        cap.close()
    })

    it("does not inject for other hosts", async () => {
        const cap = await capture()
        mockActive.mockReturnValue({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
        })
        install("api.netraruntime.com")
        await fetch(`http://${cap.host}/x`)
        expect(cap.got[0]["traceparent"]).toBeUndefined()
        cap.close()
    })

    it("no active span → no header", async () => {
        const cap = await capture()
        mockActive.mockReturnValue(undefined)
        install(cap.host)
        await fetch(`http://${cap.host}/v1/chat/completions`)
        expect(cap.got[0]["traceparent"]).toBeUndefined()
        cap.close()
    })

    it("preserves caller headers while adding traceparent", async () => {
        const cap = await capture()
        mockActive.mockReturnValue({
            traceId: "c".repeat(32),
            spanId: "d".repeat(16),
        })
        install(cap.host)
        await fetch(`http://${cap.host}/x`, {
            headers: { authorization: "Bearer k" },
        })
        expect(cap.got[0]["authorization"]).toBe("Bearer k")
        expect(cap.got[0]["traceparent"]).toBe(
            `00-${"c".repeat(32)}-${"d".repeat(16)}-01`
        )
        cap.close()
    })

    it("uninstall restores the original fetch and is safe twice", () => {
        const original = globalThis.fetch
        install("h")
        expect(globalThis.fetch).not.toBe(original)
        uninstall()
        expect(globalThis.fetch).toBe(original)
        uninstall()
        expect(globalThis.fetch).toBe(original)
    })

    it("prefers an added source over the OTel active span", async () => {
        const cap = await capture()
        mockActive.mockReturnValue({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
        })
        const source = () => ({
            traceId: "1".repeat(32),
            spanId: "2".repeat(16),
        })
        addSpanContextSource(source)
        install(cap.host)
        await fetch(`http://${cap.host}/x`)
        removeSpanContextSource(source)
        expect(cap.got[0]["traceparent"]).toBe(
            `00-${"1".repeat(32)}-${"2".repeat(16)}-01`
        )
        cap.close()
    })

    it("falls back to the OTel active span when sources return undefined", async () => {
        const cap = await capture()
        mockActive.mockReturnValue({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
        })
        const source = () => undefined
        addSpanContextSource(source)
        install(cap.host)
        await fetch(`http://${cap.host}/x`)
        removeSpanContextSource(source)
        expect(cap.got[0]["traceparent"]).toBe(
            `00-${"a".repeat(32)}-${"b".repeat(16)}-01`
        )
        cap.close()
    })

    it("a throwing source is skipped, not fatal", async () => {
        const cap = await capture()
        mockActive.mockReturnValue({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
        })
        const source = () => {
            throw new Error("boom")
        }
        addSpanContextSource(source)
        install(cap.host)
        await fetch(`http://${cap.host}/x`)
        removeSpanContextSource(source)
        expect(cap.got[0]["traceparent"]).toBe(
            `00-${"a".repeat(32)}-${"b".repeat(16)}-01`
        )
        cap.close()
    })

    it("nested installs: fetch restored only when every install has been uninstalled", () => {
        const original = globalThis.fetch
        install("h1")
        const patched = globalThis.fetch
        expect(patched).not.toBe(original)

        install("h2")
        expect(globalThis.fetch).toBe(patched)

        uninstall()
        expect(globalThis.fetch).toBe(patched)

        uninstall()
        expect(globalThis.fetch).toBe(original)

        uninstall()
        expect(globalThis.fetch).toBe(original)
    })

    it("ref-counts a source added twice: one remove leaves it active, second clears it", async () => {
        const cap = await capture()
        mockActive.mockReturnValue({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
        })
        const source = () => ({
            traceId: "1".repeat(32),
            spanId: "2".repeat(16),
        })
        addSpanContextSource(source)
        addSpanContextSource(source)
        install(cap.host)

        removeSpanContextSource(source)
        await fetch(`http://${cap.host}/x`)
        expect(cap.got[0]["traceparent"]).toBe(
            `00-${"1".repeat(32)}-${"2".repeat(16)}-01`
        )

        removeSpanContextSource(source)
        await fetch(`http://${cap.host}/x`)
        expect(cap.got[1]["traceparent"]).toBe(
            `00-${"a".repeat(32)}-${"b".repeat(16)}-01`
        )

        cap.close()
    })

    it("removing a source that was never added is a no-op", async () => {
        const cap = await capture()
        mockActive.mockReturnValue({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
        })
        const untouched = () => ({
            traceId: "1".repeat(32),
            spanId: "2".repeat(16),
        })
        // no addSpanContextSource(untouched) call
        removeSpanContextSource(untouched)
        install(cap.host)
        await fetch(`http://${cap.host}/x`)
        expect(cap.got[0]["traceparent"]).toBe(
            `00-${"a".repeat(32)}-${"b".repeat(16)}-01`
        )
        cap.close()
    })
})
