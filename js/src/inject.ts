import { normalizeHost } from "./config.js"
import { activeSpanContext } from "./context.js"

let original: typeof globalThis.fetch | null = null
let gatewayHost: string | null = null

function requestHost(input: RequestInfo | URL): string | null {
    try {
        const href =
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : (input as Request).url
        const url = new URL(href)
        return normalizeHost(url.host, url.protocol)
    } catch {
        return null
    }
}

function traceparentHeaders(base?: HeadersInit): Headers {
    const headers = new Headers(base)
    const sc = activeSpanContext()
    if (sc) headers.set("traceparent", `00-${sc.traceId}-${sc.spanId}-01`)
    return headers
}

/** Patch global fetch to inject the active LLM span's traceparent on requests
 * to the gateway host. Idempotent — a second call just retargets the host.
 * Never throws into the caller; on any error the request goes out untouched. */
export function install(host: string): void {
    gatewayHost = host
    if (original) return
    original = globalThis.fetch
    const orig = original
    globalThis.fetch = function patched(
        input: RequestInfo | URL,
        init?: RequestInit
    ) {
        try {
            if (requestHost(input) === gatewayHost) {
                // A Request with no init carries its own headers/body; rebuild
                // it so the added header survives. Otherwise merge into init.
                if (input instanceof Request && !init) {
                    const headers = traceparentHeaders(input.headers)
                    return orig(new Request(input, { headers }))
                }
                const headers = traceparentHeaders(
                    init?.headers ??
                        (input instanceof Request ? input.headers : undefined)
                )
                return orig(input, { ...init, headers })
            }
        } catch {
            /* fall through to the untouched call */
        }
        return orig(input, init)
    } as typeof globalThis.fetch
}

export function uninstall(): void {
    if (original) {
        globalThis.fetch = original
        original = null
    }
    gatewayHost = null
}
