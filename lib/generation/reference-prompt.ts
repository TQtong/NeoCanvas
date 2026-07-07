/**
 * 参考图编辑提示词。
 *
 * 图生图/参考图生成默认要把输入图当作主体约束，而不是只借用风格重新画一张。
 * 这里把用户的媒体描述包装成“局部编辑指令”，让模型优先保留人物身份、构图与画风。
 *
 * @module lib/generation/reference-prompt
 */

const REFERENCE_IMAGE_EDIT_RULES = [
  '将提供的参考图作为唯一主体依据，进行图像编辑或相似变体生成。',
  '必须保留参考图中的同一人物身份、五官结构、年龄气质、发型胡须、服饰轮廓、配饰、姿态、镜头角度、主体占比、构图、光影、配色和绘画风格。',
  '用户修改要求里的“人物”“角色”“主体”默认都指参考图中的原人物，不表示重新设计或替换人物。',
  '不要替换人物，不要改变性别、年龄、脸型或整体气质；除非用户明确要求增加人物数量，否则不要新增无关人物。',
  '只执行用户明确提出的局部变化；未提到的内容保持与参考图一致。',
  '如果用户要求添加物品或细节，将它自然地加入原人物或原画面中，不要重画成另一个角色。',
];

/**
 * 组合基于参考图的图像编辑提示词。
 *
 * @param instruction - 用户对当前媒体的修改要求
 * @returns 适合图生图 / 图片编辑模型使用的强约束提示词
 */
export function composeReferenceImageEditPrompt(instruction: string | null | undefined): string {
  const cleaned = instruction?.trim();
  const request = cleaned
    ? `用户修改要求：${cleaned}`
    : '用户修改要求：生成一个轻微变化版本，但保持同一人物、构图和画风。';
  return [...REFERENCE_IMAGE_EDIT_RULES, request].join('\n');
}
