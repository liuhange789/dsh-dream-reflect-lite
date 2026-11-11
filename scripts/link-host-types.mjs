/**
 * 把本机已安装的 DSH 包的**真实类型**接到本地 node_modules。
 *
 * 为什么这么做：`@deepseek-ai/*` 在 npm 上的公开版本远远落后于本机 DSH 运行时
 * （宿主里是 0.1.0-rc.7，registry 上还是 0.0.1-rc.x）。如果按 registry 版本做类型检查，
 * 就等于拿一份过期 API 契约去编译，编译过了真机照样装不上 —— 这正是要避免的坑。
 *
 * 所以这里做一个目录 junction，直接指向宿主 profile 里的 node_modules/@deepseek-ai，
 * 让 `tsc` 用**运行时真正加载的那份 .d.ts** 做校验。
 *
 * 构建产物不依赖这个 junction：源码里全部是 `import type`，编译后没有任何
 * `@deepseek-ai/*` 的运行时 import。
 *
 * 用法：node scripts/link-host-types.mjs [dshNodeModulesPath]
 */

import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const candidates = [
  process.argv[2],
  process.env.DSH_HOST_NODE_MODULES,
  join(homedir(), '.dsh', 'profiles', 'node_modules'),
].filter((value) => typeof value === 'string' && value.length > 0)

const hostNodeModules = candidates.find((value) => existsSync(join(value, '@deepseek-ai', 'dsh-tools', 'package.json')))

if (hostNodeModules === undefined) {
  console.error('[link-host-types] 没找到本机 DSH 安装，请显式传入路径：')
  console.error('  node scripts/link-host-types.mjs C:\\Users\\<you>\\.dsh\\profiles\\node_modules')
  process.exit(1)
}

const source = join(hostNodeModules, '@deepseek-ai')
const target = join(repoRoot, 'node_modules', '@deepseek-ai')

mkdirSync(dirname(target), { recursive: true })

if (existsSync(target) || isSymlink(target)) {
  try {
    unlinkSync(target)
  } catch (error) {
    console.error(`[link-host-types] 无法移除已存在的 ${target}：${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}

// Windows 用 junction（不需要管理员权限，也不需要开发者模式）。
symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
console.log(`[link-host-types] ${target} -> ${source}`)

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
