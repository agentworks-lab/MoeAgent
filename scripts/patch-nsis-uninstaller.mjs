/**
 * 补丁：让 electron-builder 在 Linux 上构建 NSIS 安装包时，
 * 使用内置的 UninstallerReader 直接从安装包二进制解析卸载器，
 * 而不是依赖 Wine 运行 32 位安装程序。
 *
 * 背景：部分 Linux 环境（如禁用 ia32 的内核 / 容器）无法运行 32 位
 * Windows 程序，Wine 会失败；而 UninstallerReader 是纯 Node 实现，
 * electron-builder 在 macOS Catalina 上已默认使用该路径。
 *
 * 本脚本幂等，可重复执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(
  __dirname,
  '..',
  'node_modules',
  'app-builder-lib',
  'out',
  'targets',
  'nsis',
  'NsisTarget.js'
);

if (!fs.existsSync(target)) {
  console.log('[patch-nsis] 未找到 NsisTarget.js，跳过（electron-builder 尚未安装）');
  process.exit(0);
}

let src = fs.readFileSync(target, 'utf8');

const ORIGINAL = 'if ((0, macosVersion_1.isMacOsCatalina)()) {';
const PATCHED = 'if ((0, macosVersion_1.isMacOsCatalina)() || process.platform !== "win32" /* use UninstallerReader without wine */) {';

if (src.includes('use UninstallerReader without wine')) {
  console.log('[patch-nsis] 已打过补丁，跳过');
  process.exit(0);
}

if (!src.includes(ORIGINAL)) {
  console.log('[patch-nsis] 未找到目标代码片段，可能 electron-builder 版本不兼容，跳过');
  process.exit(0);
}

src = src.replace(ORIGINAL, PATCHED);
fs.writeFileSync(target, src, 'utf8');
console.log('[patch-nsis] 补丁已应用：Linux 构建 NSIS 将使用 UninstallerReader（无需 Wine）');
