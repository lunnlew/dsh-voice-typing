/**
 * 静音幻觉回归测试：
 *  - 纯静音 / 低噪 → 不应该识别出任何文字
 *  - 真实语音   → 仍然要识别正确
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const base = process.argv[2] ?? 'http://127.0.0.1:59325'

function makeWav(samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples.length * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16000, 24)
  buffer.writeUInt32LE(32000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2)
  }
  return buffer
}

function readWav(path) {
  const wav = fs.readFileSync(path)
  let pos = 12
  let dataOffset = -1
  let dataLen = 0
  while (pos + 8 <= wav.length) {
    const id = wav.toString('ascii', pos, pos + 4)
    const size = wav.readUInt32LE(pos + 4)
    if (id === 'data') {
      dataOffset = pos + 8
      dataLen = size
      break
    }
    pos += 8 + size + (size % 2)
  }
  const pcm = new Int16Array(dataLen / 2)
  for (let i = 0; i < pcm.length; i++) pcm[i] = wav.readInt16LE(dataOffset + i * 2)
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768
  return out
}

async function transcribe(samples, label) {
  const resp = await fetch(`${base}/dsh-voice-typing/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: samples.buffer,
  })
  const data = await resp.json().catch(() => null)
  const text = data?.text
  const ok = text === '' || text === undefined
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(22)} -> ${JSON.stringify(text)}`)
  return ok
}

let failures = 0
const check = (ok) => {
  if (!ok) failures++
}

// 1) 纯静音
const silence = new Float32Array(16000 * 3)
check(await transcribe(silence, '纯静音 3 秒'))

// 2) 低噪（模拟房间底噪）
const noise = new Float32Array(16000 * 3)
let seed = 12345
for (let i = 0; i < noise.length; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  noise[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.01
}
check(await transcribe(noise, '低噪 3 秒'))

// 3) 真实语音仍然要识别正确
const speech = readWav(fileURLToPath(new URL('./fixtures/zh-test.wav', import.meta.url)))
const resp = await fetch(`${base}/dsh-voice-typing/transcribe`, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream' },
  body: speech.buffer,
})
const data = await resp.json().catch(() => null)
const good = String(data?.text ?? '').includes('天气')
console.log(`${good ? '✓' : '✗'} ${'真实语音'.padEnd(20)} -> ${JSON.stringify(data?.text)}`)
if (!good) failures++

// 4) 流式：静音块不应产生文字
const sid = 'silence-test'
const resp2 = await fetch(`${base}/dsh-voice-typing/asr-stream?sessionId=${sid}`, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream' },
  body: new Float32Array(16000).buffer,
})
const stream = await resp2.json().catch(() => null)
const quiet = !stream?.text
console.log(`${quiet ? '✓' : '✗'} ${'流式·静音块'.padEnd(20)} -> ${JSON.stringify(stream?.text)}`)
if (!quiet) failures++

// 5) 流式：真实语音要有字
const sid2 = 'speech-test'
let last = ''
const chunk = 16000 * 0.4
for (let off = 0; off < speech.length; off += chunk) {
  const slice = speech.subarray(off, Math.min(speech.length, off + chunk))
  const r = await fetch(`${base}/dsh-voice-typing/asr-stream?sessionId=${sid2}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
  })
  const d = await r.json().catch(() => null)
  if (d?.text) last = d.text
}
const streamOk = last.includes('天气')
console.log(`${streamOk ? '✓' : '✗'} ${'流式·真实语音'.padEnd(18)} -> ${JSON.stringify(last)}`)
if (!streamOk) failures++

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
