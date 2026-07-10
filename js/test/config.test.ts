import { describe, it, expect, afterEach } from "vitest"
import { normalizeHost, resolveConfig, NetraConfigError } from "../src/config.js"

const ENVS = [
    "NETRA_API_KEY",
    "NETRA_OTEL_ENDPOINT",
    "NETRA_PROJECT",
    "NETRA_ENVIRONMENT",
]
afterEach(() => ENVS.forEach((k) => delete process.env[k]))

describe("normalizeHost", () => {
    it("lowercases and strips the scheme default port", () => {
        expect(normalizeHost("API.NETRARUNTIME.COM:443", "https:")).toBe(
            "api.netraruntime.com"
        )
        expect(normalizeHost("localhost:80", "http:")).toBe("localhost")
        expect(normalizeHost("localhost:8080", "http:")).toBe("localhost:8080")
    })
})

describe("resolveConfig", () => {
    it("defaults endpoint + derives host", () => {
        const c = resolveConfig({ apiKey: "ntr_k" })
        expect(c.endpoint).toBe("https://api.netraruntime.com/v1/otel")
        expect(c.gatewayHost).toBe("api.netraruntime.com")
        expect(c.project).toBeUndefined()
    })
    it("reads env fallbacks and strips a trailing slash", () => {
        process.env.NETRA_API_KEY = "ntr_env"
        process.env.NETRA_OTEL_ENDPOINT = "http://localhost:8080/v1/otel/"
        process.env.NETRA_PROJECT = "p1"
        process.env.NETRA_ENVIRONMENT = "staging"
        const c = resolveConfig()
        expect(c.apiKey).toBe("ntr_env")
        expect(c.endpoint).toBe("http://localhost:8080/v1/otel")
        expect(c.gatewayHost).toBe("localhost:8080")
        expect(c.project).toBe("p1")
        expect(c.environment).toBe("staging")
    })
    it("args beat env", () => {
        process.env.NETRA_API_KEY = "ntr_env"
        expect(resolveConfig({ apiKey: "ntr_arg" }).apiKey).toBe("ntr_arg")
    })
    it("throws without an api key", () => {
        expect(() => resolveConfig()).toThrow(NetraConfigError)
    })
    it("falls back to NETRA_AGENT", () => {
        process.env.NETRA_AGENT = "env-bot"
        expect(resolveConfig({ apiKey: "ntr_x" }).agent).toBe("env-bot")
        delete process.env.NETRA_AGENT
    })
})
