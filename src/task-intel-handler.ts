/**
 * 智能任务处理系统 - 使用规则分析任务评论并自动更新状态
 * 无需外部 LLM API，使用关键词规则判断
 */
import type { FeishuConfig, ResolvedFeishuAccount } from "./types.js";
import type { RuntimeEnv, ClawdbotConfig } from "openclaw/plugin-sdk";
import { createFeishuClient } from "./client.js";
import { resolveFeishuAccount } from "./accounts.js";

export type TaskCommentEvent = {
  event: {
    type: string;
    app_id: string;
    tenant_key: string;
  };
  task: {
    guid: string;
    task_id: string;
    summary: string;
  };
  comment: {
    comment_id: string;
    content: string;
    creator: {
      id: string;
      type: string;
    };
    create_time: string;
  };
};

// 分析结果
type TaskAnalysisResult = {
  decision: "complete" | "incomplete" | "unclear" | "rejected";
  confidence: number; // 0-1
  actions: {
    updateStatus?: {
      completed: boolean;
      reason: string;
    };
    replyComment: {
      content: string;
      tone: "friendly" | "formal" | "urgent";
    };
    followUp?: {
      type: "request_info" | "notify_owner" | "schedule_reminder";
      details: string;
    };
  };
  reasoning: string;
};

// 完成关键词（高置信度）
const COMPLETE_KEYWORDS = [
  "已完成", "完成了", "搞定", "done", "完成",
  "已通过", "审核通过", "测试通过", "已上线", "已发布",
  "已合并", "pr merged", "代码已合并",
];

// 进行中关键词
const INCOMPLETE_KEYWORDS = [
  "未完成", "进行中", "在处理", "待处理",
  "还有问题", "需要修改", "待完善", "in progress",
];

// 模糊关键词（低置信度）
const UNCLEAR_KEYWORDS = [
  "好了", "ok", "可以了", "行了",
  "差不多了", "应该可以", "好像完成了",
];

// 灰度控制配置
const INTEL_TASK_CONFIG = {
  enabled: process.env.FEISHU_INTEL_TASK_ENABLED === "true",
  dryRun: process.env.FEISHU_INTEL_TASK_DRY_RUN === "true",
  confidenceThreshold: parseFloat(process.env.FEISHU_INTEL_TASK_CONFIDENCE ?? "0.7"),
};

/**
 * 主处理函数 - 处理任务评论事件
 */
export async function handleTaskCommentWithLLM(params: {
  cfg: ClawdbotConfig;
  event: TaskCommentEvent;
  accountId: string;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const { event, cfg, accountId, runtime } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // 检查功能是否启用
  if (!INTEL_TASK_CONFIG.enabled) {
    log("[TaskIntel] 智能任务处理已禁用");
    return;
  }

  try {
    log(`[TaskIntel] 🔍 收到任务评论事件，任务: ${event.task.guid}`);

    // 1. 获取评论内容（v1 事件不包含内容，需要通过 API 获取）
    let commentContent = event.comment.content;
    if (!commentContent && event.comment.comment_id) {
      log(`[TaskIntel] 📝 获取评论详情...`);
      commentContent = await fetchCommentContent({
        taskGuid: event.task.guid,
        commentId: event.comment.comment_id,
        accountId,
        cfg,
      });
    }

    if (!commentContent) {
      log(`[TaskIntel] ⚠️ 无法获取评论内容，跳过处理`);
      return;
    }

    log(`[TaskIntel] 📝 评论内容: ${commentContent.slice(0, 100)}...`);

    // 2. 收集任务上下文
    const context = await gatherTaskContext({
      taskGuid: event.task.guid,
      accountId,
      cfg,
    });

    log(`[TaskIntel] 📊 任务上下文: ${context.comments.length}条评论, ${context.attachments.length}个附件`);

    // 3. 使用规则分析评论
    const analysis = analyzeWithRules({
      content: commentContent,
      hasAttachments: context.attachments.length > 0,
    });

    log(`[TaskIntel] 🤖 规则分析结果: ${analysis.decision}, 置信度: ${analysis.confidence}`);
    log(`[TaskIntel] 💭 推理: ${analysis.reasoning}`);

    // 4. Dry Run 模式 - 只记录不执行
    if (INTEL_TASK_CONFIG.dryRun) {
      log(`[TaskIntel] 🧪 [DRY RUN] 会执行: ${JSON.stringify(analysis.actions, null, 2)}`);
      await createTaskComment({
        taskGuid: event.task.guid,
        content: `[测试模式] 分析结果：\n- 决策: ${analysis.decision}\n- 置信度: ${analysis.confidence}\n- 推理: ${analysis.reasoning.slice(0, 200)}...`,
        accountId,
        cfg,
      });
      return;
    }

    // 5. 根据置信度执行
    if (analysis.confidence < INTEL_TASK_CONFIG.confidenceThreshold) {
      log(`[TaskIntel] ⚠️ 置信度不足 (${analysis.confidence} < ${INTEL_TASK_CONFIG.confidenceThreshold})，请求确认`);
      await createTaskComment({
        taskGuid: event.task.guid,
        content: `🤔 我不确定是否标记为完成：\n${analysis.reasoning}\n\n请明确回复"确认完成"或"继续处理"`,
        accountId,
        cfg,
      });
      return;
    }

    // 6. 执行决策
    await executeDecision({
      taskGuid: event.task.guid,
      analysis,
      accountId,
      cfg,
    });

  } catch (err) {
    error(`[TaskIntel] ❌ 处理失败: ${err instanceof Error ? err.message : String(err)}`);
    // 出错时不阻断流程，仅记录
  }
}

/**
 * 收集任务完整上下文
 */
async function gatherTaskContext(params: {
  taskGuid: string;
  accountId: string;
  cfg: ClawdbotConfig;
}) {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createFeishuClient(account);

  // 并行获取所有信息
  const [taskRes, commentsRes, attachmentsRes] = await Promise.all([
    (client.task.v2.task.get as any)({ path: { task_guid: params.taskGuid } }),
    (client.task.v2.comment.list as any)({
      params: { resource_type: "task", resource_id: params.taskGuid },
    }),
    (client.task.v2.attachment.list as any)({
      params: { resource_type: "task", resource_id: params.taskGuid },
    }),
  ]);

  return {
    task: taskRes.data?.task,
    comments: commentsRes.data?.items ?? [],
    attachments: attachmentsRes.data?.items ?? [],
  };
}

/**
 * 使用规则分析评论（无需 LLM）
 */
function analyzeWithRules(params: {
  content: string;
  hasAttachments: boolean;
}): TaskAnalysisResult {
  const { content, hasAttachments } = params;
  const lowerContent = content.toLowerCase();

  // 1. 检查明确完成关键词
  const hasCompleteKeyword = COMPLETE_KEYWORDS.some(kw =>
    lowerContent.includes(kw.toLowerCase())
  );
  if (hasCompleteKeyword) {
    return {
      decision: "complete",
      confidence: hasAttachments ? 0.95 : 0.85,
      actions: {
        updateStatus: { completed: true, reason: "评论包含明确完成关键词" },
        replyComment: {
          content: hasAttachments
            ? "✅ 检测到完成声明及交付物，任务已自动标记完成"
            : "✅ 检测到完成声明，任务已自动标记完成",
          tone: "friendly",
        },
      },
      reasoning: `评论包含完成关键词，${hasAttachments ? "且有附件" : ""}置信度高`,
    };
  }

  // 2. 检查进行中关键词
  const hasIncompleteKeyword = INCOMPLETE_KEYWORDS.some(kw =>
    lowerContent.includes(kw.toLowerCase())
  );
  if (hasIncompleteKeyword) {
    return {
      decision: "incomplete",
      confidence: 0.8,
      actions: {
        replyComment: {
          content: "📝 收到，任务仍在进行中，请继续加油！",
          tone: "friendly",
        },
      },
      reasoning: "评论包含进行中关键词",
    };
  }

  // 3. 检查模糊关键词
  const hasUnclearKeyword = UNCLEAR_KEYWORDS.some(kw =>
    lowerContent.includes(kw.toLowerCase())
  );
  if (hasUnclearKeyword) {
    return {
      decision: "unclear",
      confidence: 0.5,
      actions: {
        replyComment: {
          content: "🤔 请明确说明是否已完成，例如：\n- '功能已完成，代码已合并'\n- '测试通过，可以上线'",
          tone: "friendly",
        },
      },
      reasoning: "评论较模糊，需要明确确认",
    };
  }

  // 4. 默认情况
  return {
    decision: "unclear",
    confidence: 0.4,
    actions: {
      replyComment: {
        content: "💡 请说明任务状态：\n- 完成：请描述完成内容\n- 未完成：请说明进度",
        tone: "friendly",
      },
    },
    reasoning: "未识别到明确的状态关键词",
  };
}

/**
 * 执行分析决策
 */
async function executeDecision(params: {
  taskGuid: string;
  analysis: TaskAnalysisResult;
  accountId: string;
  cfg: ClawdbotConfig;
}): Promise<void> {
  const { taskGuid, analysis, accountId, cfg } = params;

  switch (analysis.decision) {
    case "complete":
      await executeCompleteTask({
        taskGuid,
        reason: analysis.actions.updateStatus?.reason ?? "用户声明完成",
        replyContent: analysis.actions.replyComment.content,
        accountId,
        cfg,
      });
      break;

    case "incomplete":
      await updateTaskStatus({ taskGuid, completed: false, accountId, cfg });
      await createTaskComment({
        taskGuid,
        content: analysis.actions.replyComment.content,
        accountId,
        cfg,
      });
      break;

    case "unclear":
      await createTaskComment({
        taskGuid,
        content: analysis.actions.replyComment.content,
        accountId,
        cfg,
      });
      break;

    case "rejected":
      await createTaskComment({
        taskGuid,
        content: `❌ 无法确认完成：${analysis.actions.replyComment.content}`,
        accountId,
        cfg,
      });
      break;
  }
}

/**
 * 执行完成任务
 */
async function executeCompleteTask(params: {
  taskGuid: string;
  reason: string;
  replyContent: string;
  accountId: string;
  cfg: ClawdbotConfig;
}): Promise<void> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createFeishuClient(account);

  // 更新任务状态为完成
  await (client.task.v2.task.patch as any)({
    path: { task_guid: params.taskGuid },
    data: {
      task: { completed_at: Date.now().toString() },
      update_fields: ["completed_at"],
    },
  });

  // 回复评论
  const fullReply = `✅ 任务已标记完成\n\n原因: ${params.reason}\n\n${params.replyContent}`;

  await (client.task.v2.comment.create as any)({
    path: { task_guid: params.taskGuid },
    data: { content: fullReply },
  });
}

/**
 * 更新任务状态
 */
async function updateTaskStatus(params: {
  taskGuid: string;
  completed: boolean;
  accountId: string;
  cfg: ClawdbotConfig;
}): Promise<void> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createFeishuClient(account);

  await (client.task.v2.task.patch as any)({
    path: { task_guid: params.taskGuid },
    data: {
      task: { completed_at: params.completed ? Date.now().toString() : "" },
      update_fields: ["completed_at"],
    },
  });
}

/**
 * 创建任务评论
 */
async function createTaskComment(params: {
  taskGuid: string;
  content: string;
  accountId: string;
  cfg: ClawdbotConfig;
}): Promise<void> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createFeishuClient(account);

  await (client.task.v2.comment.create as any)({
    path: { task_guid: params.taskGuid },
    data: { content: params.content },
  });
}

/**
 * 获取评论内容
 * 注意：v1 事件不包含评论内容，需要通过 API 获取
 * 由于 v1 API 的限制，这里返回空字符串，实际使用时需要通过 task.comment.list 获取
 */
async function fetchCommentContent(params: {
  taskGuid: string;
  commentId: string;
  accountId: string;
  cfg: ClawdbotConfig;
}): Promise<string> {
  // v1 API 的事件不包含评论内容
  // 需要通过 task.comment.list API 获取评论列表，然后找到对应的评论
  // 这里简化处理，返回空字符串
  // 实际实现需要调用飞书 API 获取评论详情

  // 注意：由于 v1 API 的限制，可能无法直接通过 comment_id 获取单个评论
  // 需要使用 task.comment.list 获取任务的所有评论，然后匹配 comment_id

  return "";
}
