/**
 * 测试 Provider 的环境隔离守卫。
 *
 * 确定性 Provider 只服务本地与 CI 自动化测试。它使用自定义 Provider 命名空间，避免进入
 * 生产内置 Provider 契约；任何生产部署误开测试模式都会在第一次解析时立即失败。
 *
 * @module functions/_shared/test-provider
 */

import { ApiException } from './response.ts';

/** 测试专用 Provider 标识；不会写入生产 seed。 */
export const TEST_PROVIDER = 'custom:neocanvas-test' as const;

/** 可注入的环境快照，便于在 Deno 单元测试中无副作用验证隔离规则。 */
export interface TestProviderEnvironment {
  testMode: string | undefined;
  appEnv: string | undefined;
  deploymentId: string | undefined;
}

/**
 * 判断测试 Provider 是否获准运行。
 *
 * @param environment - 当前环境变量快照
 * @returns 仅本地或 CI 且显式启用时返回 true
 * @throws 生产环境发现测试模式配置时拒绝启动测试能力
 */
export function isTestProviderEnabled(environment: TestProviderEnvironment): boolean {
  const enabled = environment.testMode === 'true';
  // Supabase 本地 Edge Runtime 也可能分配 deployment id，不能据此误判为生产；部署流水线
  // 必须显式设置 APP_ENV=production，测试启动脚本则固定 APP_ENV=test。
  const production = environment.appEnv === 'production';
  if (enabled && production) {
    throw new ApiException(
      'internal_error',
      '生产环境禁止启用 NeoCanvas 确定性测试 Provider',
    );
  }
  return enabled;
}

/**
 * 从当前 Deno 环境读取并强制执行测试 Provider 隔离规则。
 *
 * @throws 未显式启用或生产环境误配时拒绝调用
 */
export function requireTestProviderEnabled(): void {
  const enabled = isTestProviderEnabled({
    testMode: Deno.env.get('NEOCANVAS_TEST_MODE'),
    appEnv: Deno.env.get('APP_ENV'),
    deploymentId: Deno.env.get('DENO_DEPLOYMENT_ID'),
  });
  if (!enabled) {
    throw new ApiException('model_unavailable', '确定性测试 Provider 未启用');
  }
}
