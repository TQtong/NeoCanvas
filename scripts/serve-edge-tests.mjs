/**
 * 以测试隔离环境启动本地 Supabase Edge Runtime。
 *
 * 仅供 Playwright webServer 使用；不会修改仓库环境文件。子进程退出码和信号原样传递，
 * 确保测试结束后 Edge Runtime 可以被 Playwright 正常回收。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'neocanvas-edge-test-'));
const temporaryEnvFile = join(temporaryDirectory, 'edge.env');
const sourceEnvFile = resolve('supabase/functions/.env');
const sourceEnvironment = existsSync(sourceEnvFile) ? readFileSync(sourceEnvFile, 'utf8') : '';
writeFileSync(
  temporaryEnvFile,
  `${sourceEnvironment.replace(/\s*$/, '')}\nAPP_ENV=test\nNEOCANVAS_TEST_MODE=true\nFLOW_STUDIO_ENABLED=true\n`,
  { encoding: 'utf8', mode: 0o600 },
);

const child = spawn(
  process.execPath,
  [
    'node_modules/supabase/dist/supabase.js',
    'functions',
    'serve',
    '--no-verify-jwt',
    '--env-file',
    temporaryEnvFile,
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      APP_ENV: 'test',
      NEOCANVAS_TEST_MODE: 'true',
      FLOW_STUDIO_ENABLED: 'true',
    },
  },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  process.stderr.write(`无法启动测试 Edge Runtime：${error.message}\n`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
