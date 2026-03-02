/**
 * 智能任务处理系统 - 使用 LLM 分析任务评论并自动更新状态
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

// LLM 分析结果
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
    log(`[TaskIntel] 🔍 收到任务评论，任务: ${event.task.guid}`);
    log(`[TaskIntel] 📝 评论内容: ${event.comment.content.slice(0, 100)}...`);

    // 1. 收集任务上下文
    const context = await gatherTaskContext({
      taskGuid: event.task.guid,
      accountId,
      cfg,
    });

    log(`[TaskIntel] 📊 任务上下文: ${context.comments.length}条评论, ${context.attachments.length}个附件`);

    // 2. 构建 LLM Prompt
    const prompt = buildAnalysisPrompt({
      task: context.task,
      comments: context.comments,
      attachments: context.attachments,
      newComment: event.comment,
    });

    // 3. 调用 LLM 分析
    const analysis = await analyzeWithLLM(prompt, runtime);

    log(`[TaskIntel] 🤖 分析结果: ${analysis.decision}, 置信度: ${analysis.confidence}`);
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
 * 构建 LLM 分析 Prompt
 */
export function buildAnalysisPrompt(params: {
  task: any;
  comments: any[];
  attachments: any[];
  newComment: TaskCommentEvent["comment"];
}): string {
  const { task, comments, attachments, newComment } = params;

  const taskInfo = task ? {
    title: task.summary ?? "未知",
    description: task.description ?? "无",
    status: task.completed_at ? "已完成" : "进行中",
    due: task.due ? new Date(parseInt(task.due.timestamp)).toISOString() : "未设置",
    members: task.members?.map((m: any) => m.id).join(", ") ?? "未分配",
  } : { title: "未知", description: "无", status: "未知", due: "未设置", members: "未分配" };

  const recentComments = comments
    .slice(-5)
    .map((c: any, i: number) => `${i + 1}. [${c.creator?.id ?? "unknown"}] ${c.content?.slice(0, 100) ?? ""}`)
    .join("\n");

  const attachmentList = attachments
    .map((a: any) => `- ${a.name ?? "未命名"} (${((a.size ?? 0) / 1024).toFixed(1)} KB)`)
    .join("\n") || "无";

  return `你是一个任务管理助手，需要判断用户评论是否表示任务真实完成。

## 任务信息
- 标题: ${taskInfo.title}
- 描述: ${taskInfo.description}
- 当前状态: ${taskInfo.status}
- 截止时间: ${taskInfo.due}
- 负责人: ${taskInfo.members}

## 历史评论 (${comments.length}条，显示最近5条)
${recentComments || "无"}

## 附件 (${attachments.length}个)
${attachmentList}

## 新评论
评论者ID: ${newComment.creator.id}
内容: "${newComment.content}"
时间: ${newComment.create_time}

## 判断标准
1. "完成"必须包含实质性的完成证据或明确声明
2. 模糊的"好了"、"ok"不算完成
3. 如果提到"部分完成"、"进行中"不算完成
4. 如果有截止时间，检查是否超时
5. 如果有附件，可能是交付物

## 请输出 JSON

输出格式：
{
  "decision": "complete" | "incomplete" | "unclear" | "rejected",
  "confidence": 0.0-1.0,
  "actions": {
    "updateStatus": {
      "completed": true/false,
      "reason": "为什么更新这个状态"
    },
    "replyComment": {
      "content": "回复给用户的话（简洁友好）",
      "tone": "friendly" | "formal" | "urgent"
    }
  },
  "reasoning": "你的思考过程（一句话）"
}

只输出 JSON，不要其他内容。`;
}

/**
 * 调用 LLM 分析
 */
async function analyzeWithLLM(prompt: string, runtime?: RuntimeEnv): Promise<TaskAnalysisResult> {
  const log = runtime?.log ?? console.log;

  // 获取 API Key
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    throw new Error("未设置 CLAUDE_API_KEY 环境变量");
  }

  log(`[TaskIntel] 🌐 调用 LLM 分析，Prompt 长度: ${prompt.length}`);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API 错误: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text ?? "";

  // 提取 JSON
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`LLM 返回格式错误: ${content.slice(0, 200)}`);
  }

  return JSON.parse(jsonMatch[0]) as TaskAnalysisResult;
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
