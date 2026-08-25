/**
 * 为 Deno 数据库并发测试注入本地 Supabase 地址与服务角色密钥。
 *
 * 密钥只通过子进程环境传递，不写文件、不打印到日志。Supabase 未启动时立即失败，避免把
 * 数据库并发用例静默降级为 mock。
 */

import { execFileSync, spawn } from 'node:child_process';

const cli = 'node_modules/supabase/dist/supabase.js';
const rawStatus = execFileSync(process.execPath, [cli, 'status', '--output', 'json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const status = JSON.parse(rawStatus);
if (!status.API_URL || !status.SERVICE_ROLE_KEY) {
  throw new Error('本地 Supabase 未启动，无法执行数据库并发测试');
}

const child = spawn(
  process.execPath,
  [
    'node_modules/deno/bin.cjs',
    'test',
    '--no-lock',
    '--allow-env=SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY',
    '--allow-net=127.0.0.1,localhost',
    '--config',
    'supabase/functions/deno.json',
    'supabase/tests/integration',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      SUPABASE_URL: status.API_URL,
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    },
  },
);

child.on('error', (error) => {
  process.stderr.write(`无法启动数据库并发测试：${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
