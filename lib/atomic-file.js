/**
 * 原子写文件的小工具（宿主侧共用）。
 *
 * 为什么需要它：
 *   直接 `writeFile(目标路径)` / `createWriteStream(目标路径)` 写文件，
 *   **中途被中断就会在目标路径上留下一个半截文件**：
 *   - 配置文件写一半 → JSON 截断 → 读配置时 parse 失败被吞掉 →
 *     用户的配置**静默回到默认值**，界面上一点提示都没有；
 *   - 模型分片合并写一半 → 目标路径上留下一个截断的模型文件 →
 *     而「是否就绪」只看文件存在且非空 → 判定「已就绪」→ 永远不再重下 →
 *     用户卡在一个「界面显示已就绪、模型却加载不了」的状态上。
 *
 * 正确做法是「先写临时文件，校验通过后再原子替换到最终路径」：
 *   中断只会留下临时文件，最终路径上的旧内容**完好无损**。
 *
 * 这个模块只依赖 Node 内置模块，不 import 任何项目内文件 ——
 * 所以 lib/index.js、lib/model-catalog.js、scripts/ 都能用它，不会循环依赖。
 *
 * @module dsh-voice-typing/atomic-file
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 临时文件名的自增序号（同进程内唯一，避免并发写互相踩）。 */
let tmpSeq = 0

/**
 * 生成一个唯一的临时文件路径。
 *
 * 不用固定的 `${dest}.tmp`：两个并发写同一个目标时，
 * 它们会写同一个临时文件，内容可能互相穿插 →
 * 替换到最终路径的就是一份被搅乱的 JSON。
 * @param {string} dest - 最终文件路径。
 * @returns {string} 临时文件路径。
 */
function tmpPathOf(dest) {
  tmpSeq += 1
  return `${dest}.${process.pid}.${tmpSeq}.tmp`
}

/**
 * 把临时文件改名成最终文件（目标已存在时覆盖它）。
 *
 * 为什么需要重试：
 *   `fs.rename` 在三个平台上**都会覆盖**已有目标
 *   （Windows 走 MoveFileEx + MOVEFILE_REPLACE_EXISTING），
 *   所以「不能覆盖」不是问题。
 *
 *   真正的问题是 **Windows 上的瞬时文件锁**：
 *   杀毒软件、桌面搜索索引器、其它进程短暂打开目标文件时，
 *   rename 会抛 EPERM / EBUSY / EACCES。
 *   这是**瞬时**的 —— 稍等一下再试就能成功，
 *   但 Node 不会自动重试，于是下载直接失败。
 *
 *   （先 rm 再 rename 反而更糟：多一个「目标不存在」的窗口期，
 *     而且删除操作同样会被锁住。）
 *
 * @param {string} from - 源（临时）文件路径。
 * @param {string} to - 目标文件路径。
 * @param {number} attempts - 最多尝试几次。
 * @returns {Promise<void>} 完成。
 */
export async function replaceFile(from, to, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = error?.code
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!transient || i === attempts) throw error
      // 退避后重试：等锁释放
      await new Promise((resolve) => setTimeout(resolve, 200 * i))
    }
  }
}

/**
 * 原子写文件：先写临时文件，再替换到最终路径。
 *
 * 中断/失败时最终路径上的内容**不变**（旧文件还在，不会变成半截文件）。
 * @param {string} dest - 最终文件路径。
 * @param {string|Buffer} data - 要写的内容。
 * @param {object} [options] - {encoding}（默认 utf8）。
 * @returns {Promise<void>} 完成。
 */
export async function writeFileAtomic(dest, data, options = {}) {
  const encoding = options.encoding ?? 'utf8'
  const tmp = tmpPathOf(dest)
  try {
    // 父目录可能还不存在（首次保存配置、首次生成产物）。
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(tmp, data, encoding)
    await replaceFile(tmp, dest)
  } catch (error) {
    // 失败时把临时文件清掉，别在目录里留垃圾。
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * 原子写 JSON 文件（带两空格缩进和结尾换行）。
 * @param {string} dest - 最终文件路径。
 * @param {object} value - 要序列化的值。
 * @returns {Promise<void>} 完成。
 */
export async function writeJsonAtomic(dest, value) {
  await writeFileAtomic(dest, JSON.stringify(value, null, 2) + '\n')
}
