import { defineConfig } from "tsup"

export default defineConfig({
    entry: { index: "src/index.ts", "mastra/index": "src/mastra/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
})
