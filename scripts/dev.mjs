import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const children = [
  spawn(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), 'watch', 'server/index.ts'], { cwd: root, stdio: 'inherit', env: process.env }),
  spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--config', 'client/vite.config.ts'], { cwd: root, stdio: 'inherit', env: process.env }),
]
let closing = false
function stop(code = 0) {
  if (closing) return
  closing = true
  for (const child of children) child.kill()
  process.exitCode = code
}
for (const child of children) {
  child.on('error', (error) => { console.error(error.message); stop(1) })
  child.on('exit', (code) => { if (!closing) stop(code ?? 1) })
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
