/**
 * 候选媒体替换主媒体。
 *
 * 主媒体节点 id 保持不变，因此它旁边的媒体侧卡、会话和引用关系不会丢失；旧主媒体被写回候选节点。
 *
 * @module functions/swap-media-candidate
 */

import {
  type SwapMediaCandidateRequest,
  type SwapMediaCandidateResponse,
} from '../_shared/types.ts';
import {
  ApiException,
  exceptionToResponse,
  fail,
  handleCorsPreflight,
  ok,
} from '../_shared/response.ts';
import { assertProjectOwner, createAdminClient, requireUser } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return fail('invalid_params', '仅支持 POST');

  try {
    const { userId } = await requireUser(request);
    const admin = createAdminClient();
    const body = (await request.json()) as SwapMediaCandidateRequest;

    if (!body.projectId || !body.primaryNodeId || !body.candidateNodeId || !body.geometryMode) {
      throw new ApiException('invalid_params', '缺少必要字段');
    }
    await assertProjectOwner(admin, body.projectId, userId);

    const { data, error } = await admin.rpc('swap_media_candidate', {
      p_project_id: body.projectId,
      p_primary_node_id: body.primaryNodeId,
      p_candidate_node_id: body.candidateNodeId,
      p_geometry_mode: body.geometryMode,
    });
    if (error) throw new ApiException('conflict', error.message);

    return ok<SwapMediaCandidateResponse>({ swapped: Boolean(data) });
  } catch (error) {
    return exceptionToResponse(error);
  }
});
