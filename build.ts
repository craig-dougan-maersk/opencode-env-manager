// Builds src/tui.tsx into ./tui.js for git/npm installs, which resolve the
// package exports map rather than a local directory's file names.
//
// The Solid transform plugin is applied unconditionally: the current TUI is
// imperative and contains no JSX, but if JSX is added later, Bun's built-in
// lowering (React semantics) would break it at runtime. The plugin makes the
// correct lowering automatic instead of a trap for the next edit.
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  target: "bun",
  packages: "external",
  tsconfig: "./tsconfig.build.json",
  plugins: [createSolidTransformPlugin()],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const code = await result.outputs[0].text()

// A React-style transform makes it into the bundle only when the Solid plugin
// failed to lower JSX. Both markers are fatal at runtime.
for (const marker of ["jsxDEV", "jsx-runtime", "React.createElement"]) {
  if (code.includes(marker)) {
    console.error(`FAILED: output contains "${marker}"; the Solid transform did not run`)
    process.exit(1)
  }
}

await Bun.write("tui.js", code)
console.log(`built tui.js (${code.length} bytes)`)
