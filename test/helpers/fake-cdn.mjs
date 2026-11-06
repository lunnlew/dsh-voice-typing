/**
 * 测试接缝：一个真的本地 HTTP 文件源（按 Range 应答），用来跑真下载。
 *
 * 为什么需要它（docs/architecture-modernization.md §8.34 批次 2）：
 *   `test/download.test.mjs` 里 14 条判据长这样：
 *     check('分片划分用真实大小', /const total = size/.test(cat))
 *     check('单连接路径 404 立即抛错', /仓库里没有这个文件/.test(cat))
 *   第一条钉的是**写法**：谁把 `const total = size` 改成 `const total = declaredBytes`，
 *   只要那行字符串还在它就绿；而真实后果（文件尾部下不到、sha 不匹配、模型永远下不下来）看不见。
 *   第二条更糟：那句话确实在源码里，但它被外层 `catch { 换镜像重试 }` 吞掉了，
 *   运行时 404 会白等 40 轮 × 2 个镜像（实测好几分钟）—— 文本判据把一个**真缺陷**当成了已实现。
 *
 * 换成这个接缝之后：下载走真 fetch、真 Range、真落盘，判据比的是
 * 「落盘文件的字节数与 sha256」「onProgress 报出来的那一串数」「请求了几次、每次要哪段」「多久失败」。
 *
 * 用法：
 *   const cdn = await startFakeCdn({ files: { 'repo/name': { buffer } }, decide })
 *   const { origin, requests, close } = cdn
 *   decide(record, index) 每次应答前调一次，可返回：
 *     { status: 404 }        强制这个请求失败
 *     { noRange: true }      无视 Range，整文件 200（服务端不支持续传）
 *     { chunked: true }      200 但不给 content-length（探测读不到大小）
 *     { dropAfterBytes: n }  吐 n 字节就把连接掐掉（模拟断流）
 *     { delayMs: n }         先等 n 毫秒再应答（让「下载中」这个状态可被轮询观测）
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { copyHostTree, importFromTree, removeHostTree } from './host-copy.mjs'

/**
 * 有内容的字节串（不是全零：截断、错序、只下一半都能被 sha256 区分开）。
 * @param {number} size - 字节数。
 * @param {number} [salt] - 错位量，让不同文件内容不同。
 * @returns {Buffer} 内容。
 */
export function patternBuffer(size, salt = 0) {
  const b = Buffer.alloc(size)
  for (let i = 0; i < size; i++) b[i] = (i * 7 + salt) % 251
  return b
}

/**
 * sha256（档位数据里那个字段就是这个值，测试自己算，不抄源码）。
 * @param {Buffer} buf - 内容。
 * @returns {string} 十六进制摘要。
 */
export function digest(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * 解析 `Range: bytes=100-200` / `bytes=100-`。
 * @param {string|undefined} header - 请求头里的 range。
 * @returns {{start: number, end: number}|null} end 开区间时为 Infinity。
 */
function parseRange(header) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(header ?? ''))
  if (!m) return null
  return { start: Number(m[1]), end: m[2] === '' ? Infinity : Number(m[2]) }
}

/**
 * 起一个假 CDN。
 *
 * @param {object} options - 选项。
 * @param {Record<string, {buffer: Buffer}>} options.files - 键是 `<repo>/<name>`，值是文件内容。
 * @param {(record: object, index: number) => object|null} [options.decide] - 逐请求应答策略。
 * @returns {Promise<{origin: string, requests: Array<object>, close: () => Promise<void>}>}
 */
export async function startFakeCdn({ files, decide = null } = {}) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const url = String(req.url ?? '/').split('?')[0]
    const m = /^\/(.+?)\/resolve\/([^/]+)\/(.+)$/.exec(url)
    const record = m
      ? { url, repo: m[1], revision: m[2], name: m[3], key: `${m[1]}/${m[3]}`, range: parseRange(req.headers.range), headers: req.headers }
      : { url, repo: null, revision: null, name: null, key: null, range: null, headers: req.headers }
    requests.push(record)
    const index = requests.filter((r) => r.key === record.key).length - 1
    const rule = (decide ? decide(record, index) : null) ?? {}
    // 慢速应答：让「下载进行中」这个状态在测试里能被观测到（宿主的后台下载太快，
    // 轮询根本抓不到 downloading:true 的那几毫秒）。
    if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs))

    if (!record.key || rule.status === 404 || !files[record.key]) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('NotFound')
      return
    }
    const body = files[record.key].buffer
    const total = body.length

    // 无 Range（或这个服务端不支持）：整文件 200。
    if (!record.range || rule.noRange) {
      if (rule.chunked) {
        // 不给 content-length → Node 走 chunked，探测侧读不到大小。
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
      } else {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(total) })
      }
      if (rule.dropAfterBytes != null) {
        res.write(body.subarray(0, rule.dropAfterBytes))
        res.destroy()
        return
      }
      res.end(body)
      return
    }

    const start = record.range.start
    const stop = Math.min(record.range.end, total - 1)
    const slice = start >= total ? Buffer.alloc(0) : body.subarray(start, stop + 1)
    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-range': `bytes ${start}-${stop}/${total}`,
      'content-length': String(slice.length),
    })
    if (rule.dropAfterBytes != null) {
      res.write(slice.subarray(0, rule.dropAfterBytes))
      res.destroy()
      return
    }
    res.end(slice)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      // 先掐连接再等 close：undici 会保持 socket，只调 close() 的话回调永远不来。
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * 把 `model-catalog` 装到假 CDN 上（HOSTS 换成 127.0.0.1，缓存根目录换成临时目录）。
 *
 * @param {string} origin - `startFakeCdn` 给出的源地址。
 * @param {string} dshHome - 临时 DSH_HOME（cacheRoot() 调用时才读这个环境变量）。
 * @param {object} [options] - 选项。
 * @param {(code: string, file: string) => string} [options.tune] - 调用方给的额外改写，**最后**生效
 *   （先 scaffold 再 tune，这样脚手架不会盖掉调用方的改写，改写也不会让脚手架失配）。
 * @param {(code: string, file: string) => string} [options.scaffold] - 常驻脚手架改写
 *   （例如把重试轮数上限压小，好让「404 被当成网络错误重试」这类用例能在有界时间内跑完）。
 * @param {Array<[string, string, string]>} [options.extraRewriteChecks] -
 *   配合 scaffold 的自检清单（`[说明, 原文片段, 产物片段]`）。脚手架打空了不会报错，
 *   只会让某条判据跑上好几分钟 —— 所以谁给了 scaffold 就得同时给这条。
 * @returns {Promise<{mod: object, dir: string, dshHome: string, restore: () => void}>}
 */
export async function loadModelCatalogOnFakeCdn(origin, dshHome, { tune = null, scaffold = null, extraRewriteChecks = [] } = {}) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  const hostsLiteral = `const HOSTS = ${JSON.stringify([origin])}`
  const tree = copyHostTree('model-catalog', {
    transform: (code, file) => {
      if (file !== 'model-catalog.js') return code
      let out = code.replace(/const HOSTS = \[[^\]]*\]/, hostsLiteral)
      if (scaffold) out = scaffold(out, file)
      if (tune) out = tune(out, file)
      return out
    },
    requireRewrite: [
      ['HOSTS 换成假 CDN', "const HOSTS = ['https://hf-mirror.com', 'https://huggingface.co']", hostsLiteral],
      ...extraRewriteChecks,
    ],
  })
  const mod = await importFromTree(tree)
  return {
    mod,
    dir: tree.dir,
    dshHome,
    restore() {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      removeHostTree(tree.dir)
    },
  }
}
