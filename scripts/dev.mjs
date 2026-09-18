/**
 * 开发模式启动器：并行启动 Vite 开发服务器与 Electron。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

// 1. 先构建主进程
const build = spawn(isWin ? 'npm.cmd' : 'npm', ['run', 'build:main'], { cwd: root, stdio: 'inherit' });
build.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);

  // 2. 启动 Vite
  const vite = spawn(isWin ? 'npm.cmd' : 'npm', ['run', 'dev:web', '--', '--port', '5173', '--strictPort'], {
    cwd: root,
    stdio: 'inherit',
  });

  // 3. 等待 Vite 就绪后启动 Electron
  setTimeout(() => {
    const electronBin = path.join(root, 'node_modules', '.bin', isWin ? 'electron.cmd' : 'electron');
    const electron = spawn(electronBin, ['.'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'development', VITE_DEV_SERVER_URL: 'http://localhost:5173' },
    });
    electron.on('exit', () => {
      vite.kill();
      process.exit(0);
    });
  }, 2500);

  vite.on('exit', (code) => process.exit(code ?? 0));
});
