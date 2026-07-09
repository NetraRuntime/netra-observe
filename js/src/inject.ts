import { normalizeHost } from "./config.js"
import { activeSpanContext } from "./context.js"

export type SpanContextSource = () =>
    | { traceId: string; spanId: string }
    | undefined

let original: typeof globalThis.fetch | null = null
let gatewayHost: string | null = null
let sources: SpanContextSource[] = []
const sourceRefCounts = new Map<SpanContextSource, number>()

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

/** Register an additional span-context source consulted BEFORE the OTel
 * active span (FIFO among added sources). Used by the Mastra integration,
 * whose spans are not OTel-active. Ref-counted: multiple callers may add the
 * same source (by function identity) — it stays registered until every
 * caller has removed it, so one owner's removeSpanContextSource() can't
 * silently kill a sibling's still-live registration. */
export function addSpanContextSource(src: SpanContextSource): void {
    const count = sourceRefCounts.get(src) ?? 0
    if (count === 0) sources.push(src)
    sourceRefCounts.set(src, count + 1)
}

/** Decrement the source's ref count, removing it once the count reaches 0.
 * A remove without a prior add is a no-op — it never goes negative and
 * never removes a source it didn't register. */
export function removeSpanContextSource(src: SpanContextSource): void {
    const count = sourceRefCounts.get(src)
    if (!count) return
    if (count === 1) {
        sourceRefCounts.delete(src)
        sources = sources.filter((s) => s !== src)
    } else {
        sourceRefCounts.set(src, count - 1)
    }
}

function currentSpanContext():
    | { traceId: string; spanId: string }
    | undefined {
    for (const src of sources) {
        try {
            const sc = src()
            if (sc) return sc
        } catch {
            /* a broken source must not break the request */
        }
    }
    return activeSpanContext()
}

function traceparentHeaders(base?: HeadersInit): Headers {
    const headers = new Headers(base)
    const sc = currentSpanContext()
    if (sc) headers.set("traceparent", `00-${sc.traceId}-${sc.spanId}-01`)
    return headers
}

/** Patch global fetch to inject the current LLM span's traceparent on
 * requests to the gateway host. Idempotent — a second call just retargets
 * the host and returns false; true means this call performed the patch
 * (its caller owns the eventual uninstall()). Never throws into the
 * caller; on any error the request goes out untouched. */
export function install(host: string): boolean {
    gatewayHost = host
    if (original) return false
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
    return true
}

export function uninstall(): void {
    if (original) {
        globalThis.fetch = original
        original = null
    }
    gatewayHost = null
}
