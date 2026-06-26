/**
 * 中英文案字典（第 04 篇第十节）。
 *
 * 尊重界面草图的中英混排：产品标语、模型名、Agent、部分英文引导语保留英文原文，
 * 功能性与正文文案以所选语言呈现。键以点分命名空间组织。
 *
 * @module i18n/messages
 */

import type { Locale } from '@/stores/session-store';
import type { ErrorCode } from '@/types';

/** 一种语言的文案字典。 */
export type MessageDictionary = Record<string, string>;

/** 简体中文文案。 */
const zhCN: MessageDictionary = {
  'common.cancel': '取消',
  'common.confirm': '确认',
  'common.delete': '删除',
  'common.rename': '重命名',
  'common.save': '保存',
  'common.close': '关闭',
  'common.retry': '重试',
  'common.loading': '加载中…',
  'common.share': '分享',
  'common.export': '导出',
  'common.settings': '设置',
  'common.logout': '退出登录',
  'common.untitled': 'Untitled',
  'common.copyLink': '复制链接',
  'common.linkCopied': '链接已复制',
  'common.undo': '撤销',

  'settings.title': '设置',
  'settings.displayName': '显示名称',
  'settings.displayNamePlaceholder': '你的名字',
  'settings.language': '语言',
  'settings.saved': '设置已保存',

  'design.versionSwitcher': '版本 / 标签',
  'design.noVersions': '暂无其他版本',
  'design.newConversationStarted': '已开始新对话',

  'home.tagline': 'NeoCanvas 让设计更简单',
  'home.subtitle': '懂你的设计代理，帮你搞定一切',
  'home.promptPlaceholder': '让 NeoCanvas 设计一张美丽的婚礼海报',
  'home.recentProjects': '最近项目',
  'home.newProject': '新建项目',
  'home.send': '发送',
  'home.attach': '添加附件',
  'home.emptyProjects': '还没有项目，点击「新建项目」开始创作',
  'home.updatedAt': '更新于 {date}',
  'home.loadMore': '加载更多',
  'home.deleteProjectConfirm': '确定删除该项目？删除后可在保留期内恢复。',
  'home.projectDeleted': '项目已删除',

  'scene.design': 'Design',
  'scene.branding': 'Branding',
  'scene.ecommerce': 'E-Commerce',
  'scene.video': 'Video',

  'design.emptyCanvas': '输入你的想法开始创作，或按 C 开始对话',
  'design.zoomToFit': '适应画布',
  'design.zoom': '缩放',
  'design.layers': '图层',
  'design.share': '分享',
  'design.collapsePanel': '收起面板',
  'design.expandPanel': '展开面板',
  'design.renameProject': '重命名项目',

  'tool.select': '选择 / 移动',
  'tool.pan': '抓手 / 定位',
  'tool.uploadImage': '上传图片',
  'tool.frame': '画板',
  'tool.grid': '网格',
  'tool.shape': '形状',
  'tool.draw': '手绘',
  'tool.text': '文本',
  'tool.aiImage': 'AI 图像',
  'tool.aiVideo': 'AI 视频',
  'tool.aiText': 'AI 文本',

  'node.regenerate': '以此为参考再生成',
  'node.replace': '替换',
  'node.delete': '删除',
  'node.bringToFront': '置顶',
  'node.sendToBack': '置底',
  'node.duplicate': '复制',
  'node.group': '成组',
  'node.ungroup': '解组',
  'node.generating': '生成中…',
  'node.generationFailed': '生成失败',
  'node.generateVideo': '按顺序生成视频',
  'node.addDescription': '添加描述',
  'edge.description': '描述',
  'node.videoQueued': '已按关键帧顺序提交视频生成',
  'node.videoTooShort': '至少连接两张已就绪的图片才能生成视频',
  'node.videoNoModel': '当前无可用视频模型（需激活视频模型并配置其密钥）',
  'node.videoFailed': '视频生成提交失败',
  'node.tapToRetry': '点击重试',

  'chat.newConversation': '新对话',
  'chat.heading': 'What do you want to create?',
  'chat.inputPlaceholder': 'Start with an idea, or type "@" to mention',
  'chat.send': '发送',
  'chat.mention': '提及画布元素',
  'chat.agentMode': 'Agent',
  'chat.thinking': '思考中…',
  'chat.generating': '生成中…',

  'agent.generate': '纯生成',
  'agent.orchestrate': 'Agent',
  'agent.scene': '场景流程',
  'agent.generate.desc': '直接把消息映射为一次生成',
  'agent.orchestrate.desc': '理解意图并编排多步生成',
  'agent.scene.desc': '按所选场景产出成套物料',

  'error.unauthorized': '登录态失效，请重新登录',
  'error.forbidden': '无权访问该资源',
  'error.invalid_params': '参数不合法',
  'error.unsupported_param': '当前模型不支持该参数',
  'error.not_found': '资源不存在',
  'error.content_blocked': '内容被安全策略拦截，请修改后重试',
  'error.model_unavailable': '模型暂不可用，请更换模型',
  'error.provider_error': '上游服务出错，请稍后重试',
  'error.generation_timeout': '生成超时，请重试',
  'error.duplicate_request': '请求已提交',
  'error.conflict': '数据已更新，请刷新后重试',
  'error.rate_limited': '操作过于频繁，请稍后再试',
  'error.internal_error': '服务出错，请稍后重试',
};

/** 英文文案。 */
const en: MessageDictionary = {
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.delete': 'Delete',
  'common.rename': 'Rename',
  'common.save': 'Save',
  'common.close': 'Close',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
  'common.share': 'Share',
  'common.export': 'Export',
  'common.settings': 'Settings',
  'common.logout': 'Log out',
  'common.untitled': 'Untitled',
  'common.copyLink': 'Copy link',
  'common.linkCopied': 'Link copied',
  'common.undo': 'Undo',

  'settings.title': 'Settings',
  'settings.displayName': 'Display name',
  'settings.displayNamePlaceholder': 'Your name',
  'settings.language': 'Language',
  'settings.saved': 'Settings saved',

  'design.versionSwitcher': 'Version / tag',
  'design.noVersions': 'No other versions',
  'design.newConversationStarted': 'Started a new conversation',

  'home.tagline': 'NeoCanvas makes design simple',
  'home.subtitle': 'Your design agent that gets it done',
  'home.promptPlaceholder': 'Ask NeoCanvas to design a beautiful wedding poster',
  'home.recentProjects': 'Recent projects',
  'home.newProject': 'New project',
  'home.send': 'Send',
  'home.attach': 'Add attachment',
  'home.emptyProjects': 'No projects yet — click "New project" to start',
  'home.updatedAt': 'Updated {date}',
  'home.loadMore': 'Load more',
  'home.deleteProjectConfirm':
    'Delete this project? You can restore it during the retention window.',
  'home.projectDeleted': 'Project deleted',

  'scene.design': 'Design',
  'scene.branding': 'Branding',
  'scene.ecommerce': 'E-Commerce',
  'scene.video': 'Video',

  'design.emptyCanvas': 'Type your idea to start, or press C to chat',
  'design.zoomToFit': 'Zoom to fit',
  'design.zoom': 'Zoom',
  'design.layers': 'Layers',
  'design.share': 'Share',
  'design.collapsePanel': 'Collapse panel',
  'design.expandPanel': 'Expand panel',
  'design.renameProject': 'Rename project',

  'tool.select': 'Select / Move',
  'tool.pan': 'Hand / Pan',
  'tool.uploadImage': 'Upload image',
  'tool.frame': 'Frame',
  'tool.grid': 'Grid',
  'tool.shape': 'Shape',
  'tool.draw': 'Draw',
  'tool.text': 'Text',
  'tool.aiImage': 'AI Image',
  'tool.aiVideo': 'AI Video',
  'tool.aiText': 'AI Text',

  'node.regenerate': 'Regenerate from this',
  'node.replace': 'Replace',
  'node.delete': 'Delete',
  'node.bringToFront': 'Bring to front',
  'node.sendToBack': 'Send to back',
  'node.duplicate': 'Duplicate',
  'node.group': 'Group',
  'node.ungroup': 'Ungroup',
  'node.generating': 'Generating…',
  'node.generationFailed': 'Generation failed',
  'node.generateVideo': 'Generate video in order',
  'node.addDescription': 'Add description',
  'edge.description': 'Description',
  'node.videoQueued': 'Video generation queued in keyframe order',
  'node.videoTooShort': 'Connect at least two ready images to generate a video',
  'node.videoNoModel': 'No active video model (activate one and configure its key)',
  'node.videoFailed': 'Failed to submit video generation',
  'node.tapToRetry': 'Tap to retry',

  'chat.newConversation': 'New conversation',
  'chat.heading': 'What do you want to create?',
  'chat.inputPlaceholder': 'Start with an idea, or type "@" to mention',
  'chat.send': 'Send',
  'chat.mention': 'Mention a canvas element',
  'chat.agentMode': 'Agent',
  'chat.thinking': 'Thinking…',
  'chat.generating': 'Generating…',

  'agent.generate': 'Generate',
  'agent.orchestrate': 'Agent',
  'agent.scene': 'Scene flow',
  'agent.generate.desc': 'Map the message directly to one generation',
  'agent.orchestrate.desc': 'Understand intent and orchestrate multi-step generation',
  'agent.scene.desc': 'Produce a full set of assets for the chosen scene',

  'error.unauthorized': 'Session expired, please sign in again',
  'error.forbidden': 'You do not have access to this resource',
  'error.invalid_params': 'Invalid parameters',
  'error.unsupported_param': 'This model does not support that parameter',
  'error.not_found': 'Resource not found',
  'error.content_blocked': 'Blocked by content safety, please edit and retry',
  'error.model_unavailable': 'Model unavailable, please switch model',
  'error.provider_error': 'Upstream error, please retry later',
  'error.generation_timeout': 'Generation timed out, please retry',
  'error.duplicate_request': 'Request already submitted',
  'error.conflict': 'Data changed, please refresh and retry',
  'error.rate_limited': 'Too many requests, please slow down',
  'error.internal_error': 'Service error, please retry later',
};

/** 文案字典表。 */
export const DICTIONARIES: Record<Locale, MessageDictionary> = {
  'zh-CN': zhCN,
  en,
};

/** 错误码 → 文案键。 */
export function errorMessageKey(code: ErrorCode): string {
  return `error.${code}`;
}
