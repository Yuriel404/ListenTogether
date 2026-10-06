import { loadConfig } from './config.js'
import { createApplication } from './app.js'

const config = loadConfig()
const server = createApplication(config)
server.http.listen(config.port, config.host, () => {
  console.log(`同频后端已启动：http://localhost:${config.port} (${config.provider === 'demo' ? '本地演示音源' : '网易云音乐'})`)
})
server.http.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用` : `启动失败：${error.code || error.name}`)
  void server.close().finally(() => { process.exitCode = 1 })
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void server.close().finally(() => process.exit(0)) })
}
