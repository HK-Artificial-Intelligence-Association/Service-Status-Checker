import http from 'http'
import fs from 'fs/promises'
import path from 'path'
import dotenv from 'dotenv'

// 加载 .env 文件
dotenv.config()

const PORT = process.env.PORT || 3000
const HTML_OUTPUT_DIRECTORY = process.env.HTML_OUTPUT_DIRECTORY || './output'

const serveFile = async (filePath: string, res: http.ServerResponse) => {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(content)
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('File not found')
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/') {
    await serveFile(path.join(HTML_OUTPUT_DIRECTORY, 'index.html'), res)
  } else if (req.url === '/history.html') {
    await serveFile(path.join(HTML_OUTPUT_DIRECTORY, 'history.html'), res)
  } else if (req.url === '/index.html') {
    await serveFile(path.join(HTML_OUTPUT_DIRECTORY, 'index.html'), res)
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  }
})

server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`)
})