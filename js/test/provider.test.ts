import { describe, it, expect } from "vitest"
import { resolveConfig, type InstrumentOptions } from "../src/config.js"
import { buildResource, buildExporter, buildProvider } from "../src/provider.js"

const cfg = (o: InstrumentOptions = {}) => resolveConfig({ apiKey: "ntr_k", ...o })

describe("buildResource", () => {
    it("carries project + environment", () => {
        const r = buildResource(cfg({ project: "support", environment: "prod" }))
        expect(r.attributes["service.name"]).toBe("support")
        expect(r.attributes["netra.project"]).toBe("support")
        expect(r.attributes["deployment.environment"]).toBe("prod")
    })
    it("defaults service.name when no project", () => {
        const r = buildResource(cfg())
        expect(r.attributes["service.name"]).toBe("netra-observe")
        expect(r.attributes["netra.project"]).toBeUndefined()
        expect(r.attributes["deployment.environment"]).toBeUndefined()
    })
})

describe("buildExporter", () => {
    it("targets <endpoint>/v1/traces", () => {
        const e = buildExporter(cfg({ endpoint: "http://localhost:9999/v1/otel" }))
        // otlp-proto 0.2xx nests the resolved url under the transport chain.
        const url = (e as unknown as {
            _delegate?: { _transport?: { _transport?: { _parameters?: { url?: string } } } }
        })._delegate?._transport?._transport?._parameters?.url
        expect(url).toBe("http://localhost:9999/v1/otel/v1/traces")
    })
})

describe("buildProvider", () => {
    it("registers one span processor", () => {
        const p = buildProvider(cfg())
        const procs = (p as unknown as {
            _activeSpanProcessor?: { _spanProcessors?: unknown[] }
        })._activeSpanProcessor?._spanProcessors
        expect(procs?.length).toBe(1)
        return p.shutdown()
    })
})
