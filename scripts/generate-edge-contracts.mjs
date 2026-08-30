/**
 * 从根 `types/` 生成 Deno 可直接导入的单文件业务契约。
 *
 * 源文件保持面向前端的模块化组织；生成器按依赖顺序拼接、移除模块间 type-only import，
 * 使 Supabase 部署包不必越出 `supabase/functions` 目录。生成内容完全确定，`--check` 只做
 * 字节比较而不写盘，适合 CI 漂移门禁。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  'types/enums.ts',
  'types/messages.ts',
  'types/generation.ts',
  'types/models.ts',
  'types/providers.ts',
  'types/workflow.ts',
  'types/api.ts',
  'types/edge-functions.ts',
];
const output = join(root, 'supabase/functions/_shared/contracts.generated.ts');

/** 去掉源模块之间的 type-only import；所有依赖已按顺序在同一输出模块中声明。 */
function stripImports(source) {
  return source
    .replace(/^import\s+type\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace(/^import\s+type\s+[^;]+;\r?\n/gm, '')
    .trim();
}

const sections = [];
for (const sourcePath of sources) {
  const absolute = join(root, sourcePath);
  const source = await readFile(absolute, 'utf8');
  sections.push(
    `// ---------------------------------------------------------------------------\n` +
      `// SOURCE: ${sourcePath.replaceAll('\\', '/')}\n` +
      `// ---------------------------------------------------------------------------\n\n` +
      stripImports(source),
  );
}

const unformatted =
  `/**\n` +
  ` * 此文件由 scripts/generate-edge-contracts.mjs 从根 types/ 生成。\n` +
  ` * 禁止手工修改；请修改根契约后运行 npm run contracts:generate。\n` +
  ` */\n\n` +
  `${sections.join('\n\n')}\n`;

const denoExecutable = join(
  root,
  'node_modules',
  'deno',
  process.platform === 'win32' ? 'deno.exe' : 'deno',
);
const formatResult = spawnSync(
  denoExecutable,
  ['fmt', '--config', join(root, 'supabase/functions/deno.json'), '--ext', 'ts', '-'],
  { input: unformatted, encoding: 'utf8' },
);
if (formatResult.status !== 0 || !formatResult.stdout) {
  process.stderr.write(formatResult.stderr || 'Deno 契约格式化失败。\n');
  process.exit(1);
}
const generated = formatResult.stdout;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = await readFile(output, 'utf8');
  } catch {
    // 缺失文件按漂移处理，并输出稳定、无敏感信息的错误。
  }
  if (current !== generated) {
    process.stderr.write(
      `Edge 契约已漂移：请运行 npm run contracts:generate 并提交 ${relative(root, output)}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('Edge 契约与根 types/ 一致。\n');
  }
} else {
  await writeFile(output, generated, 'utf8');
  process.stdout.write(`已生成 ${relative(root, output)}\n`);
}
