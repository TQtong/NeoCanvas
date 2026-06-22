'use server';

/**
 * 服务端动作（第 04 篇第二节、第 06 篇 create-project）。
 *
 * 主页「发起创作」与「新建项目」走服务端动作：以带用户会话的服务端客户端调用
 * create-project 能力面函数（建项目 + 记首条消息 + 按需建首个生成任务），完成后服务端
 * 重定向到设计页。
 *
 * @module app/actions
 */

import { redirect } from 'next/navigation';
import type { ApiResponse, CreateProjectRequest, CreateProjectResponse, Scene } from '@/types';
import { createServerSupabase } from '@/lib/supabase/server';

/** 默认模型键（与 model_catalog 默认选中一致）。 */
const DEFAULT_MODEL_KEY = 'gpt-image-2';

/** 合法场景集合，用于校验表单输入。 */
const VALID_SCENES: ReadonlySet<string> = new Set(['design', 'branding', 'ecommerce', 'video']);

/** 调用 create-project 并返回新项目标识。 */
async function invokeCreateProject(payload: CreateProjectRequest): Promise<string> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  const { data, error } = await supabase.functions.invoke<ApiResponse<CreateProjectResponse>>(
    'create-project',
    { body: payload },
  );
  if (error || !data) {
    throw new Error(`创建项目失败：${error?.message ?? '无响应'}`);
  }
  if (!data.success) {
    throw new Error(data.error.message);
  }
  return data.data.projectId;
}

/**
 * 主页「发起创作」：依表单的想法 / 模型 / 场景创建项目并进入设计页（进入即生成）。
 *
 * @param formData - 含 prompt / modelKey / scene 字段的表单数据
 */
export async function createProjectAction(formData: FormData): Promise<void> {
  const prompt = (formData.get('prompt') as string | null)?.trim() ?? '';
  const modelKey = (formData.get('modelKey') as string | null) || DEFAULT_MODEL_KEY;
  const sceneRaw = (formData.get('scene') as string | null) ?? '';
  const scene = VALID_SCENES.has(sceneRaw) ? (sceneRaw as Scene) : null;

  if (!prompt) {
    // 空想法不创建（前端发送按钮已禁用，此为服务端兜底）
    return;
  }

  const projectId = await invokeCreateProject({
    prompt,
    modelKey,
    scene,
    generateOnCreate: true,
  });
  redirect(`/p/${projectId}`);
}

/**
 * 主页「新建项目」：创建一个空白项目并进入设计页（不触发生成）。
 */
export async function createBlankProjectAction(): Promise<void> {
  const projectId = await invokeCreateProject({
    prompt: '',
    modelKey: DEFAULT_MODEL_KEY,
    scene: null,
    generateOnCreate: false,
  });
  redirect(`/p/${projectId}`);
}
