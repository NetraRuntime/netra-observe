import { describe, it, expect, vi, afterEach } from "vitest"

vi.mock("@mastra/core/observability", () => ({
    resolveCurrentSpan: vi.fn(),
}))
import { resolveCurrentSpan } from "@mastra/core/observability"
import { mastraSpanContext } from "../src/mastra/span-source.js"

const mockResolve = resolveCurrentSpan as unknown as ReturnType<typeof vi.fn>

afterEach(() => mockResolve.mockReset())

describe("mastraSpanContext", () => {
    it("returns the live span's ids, lowercased", () => {
        mockResolve.mockReturnValue({
            traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
            id: "00F067AA0BA902B7",
        })
        expect(mastraSpanContext()).toEqual({
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "00f067aa0ba902b7",
        })
    })

    it("returns undefined when no span is ambient", () => {
        mockResolve.mockReturnValue(undefined)
        expect(mastraSpanContext()).toBeUndefined()
    })

    it("returns undefined for non-W3C ids", () => {
        mockResolve.mockReturnValue({ traceId: "not-hex", id: "short" })
        expect(mastraSpanContext()).toBeUndefined()
    })

    it("returns undefined for all-zero ids", () => {
        mockResolve.mockReturnValue({
            traceId: "0".repeat(32),
            id: "0".repeat(16),
        })
        expect(mastraSpanContext()).toBeUndefined()
    })

    it("returns undefined when the resolver throws", () => {
        mockResolve.mockImplementation(() => {
            throw new Error("boom")
        })
        expect(mastraSpanContext()).toBeUndefined()
    })
})
