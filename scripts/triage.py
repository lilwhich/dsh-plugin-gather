#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI Issue Triage —— 新 issue 自动摘要 / 分类打标签 / 生成回复草稿

触发方式：GitHub Actions（on: issues: types: [opened]）或手动 workflow_dispatch
依赖：仅标准库（urllib），无需 pip install

环境变量：
  GITHUB_TOKEN     必填  Actions 自动提供，需 issues: write 权限
  GITHUB_REPOSITORY     形如 owner/repo
  GITHUB_EVENT_PATH     事件 payload 路径（Actions 自动提供）
  LLM_API_KEY      选填  不填则走本地关键词兜底分类
  LLM_BASE_URL     选填  默认 https://api.deepseek.com
  LLM_MODEL        选填  默认 deepseek-chat
  DRY_RUN          选填  1 = 只打印不写回 GitHub（本地调试用）
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# ---------------------------------------------------------------- 配置

ALLOWED_LABELS = ["bug", "feature", "question", "docs", "enhancement", "invalid"]

# 大模型可能返回中文或变体标签，统一映射到标准标签
LABEL_ALIASES = {
    "缺陷": "bug", "错误": "bug", "报错": "bug", "故障": "bug", "问题": "bug",
    "功能请求": "feature", "新功能": "feature", "需求": "feature", "特性": "feature",
    "咨询": "question", "疑问": "question", "提问": "question", "使用问题": "question",
    "文档": "docs", "文档问题": "docs",
    "优化": "enhancement", "改进": "enhancement", "增强": "enhancement",
    "无效": "invalid", "重复": "invalid",
}

# 关键词兜底（无 API Key 或 LLM 调用失败时使用）
KEYWORD_RULES = [
    ("bug", ["traceback", "error", "exception", "报错", "崩溃", "失败", "无法", "不能",
             "bug", "坏了", "挂了", "闪退", "卡死"]),
    ("feature", ["希望", "建议", "能不能", "可以加", "支持", "feature", "request",
                 "新增", "想要", "期待"]),
    ("docs", ["文档", "readme", "doc", "说明", "示例写错", "拼写"]),
    ("question", ["怎么", "如何", "请问", "请教", "为什么", "?", "？", "help"]),
]

# 优先级判定
PRIORITY_RULES = [
    ("P0", ["崩溃", "数据丢失", "无法启动", "security", "安全", "严重", "阻断"]),
    ("P1", ["报错", "失败", "异常", "error", "无法使用"]),
]

MAX_BODY_CHARS = 4000  # 截断超长 issue，控制 token 成本
LLM_TIMEOUT = 45
LLM_RETRIES = 2

SYSTEM_PROMPT = """你是一个开源项目的 issue 分诊助手。
请根据用户提交的 issue 内容，输出严格的 JSON（不要 markdown 代码块，不要任何额外文字），格式如下：

{
  "summary": "一句话中文摘要，30 字以内",
  "labels": ["从 bug/feature/question/docs/enhancement/invalid 中选 1-2 个"],
  "priority": "P0 / P1 / P2 三选一",
  "reply": "给 issue 作者的中文回复草稿，150 字以内，语气友好，说明已收到并给出初步判断或后续安排"
}

判定标准：
- bug：功能异常、报错、崩溃
- feature：新功能需求
- question：使用方法咨询
- docs：文档问题
- enhancement：现有功能优化
- invalid：无效/重复/信息不足
- 优先级：P0 阻断性故障或安全问题；P1 影响使用；P2 一般建议"""


# ---------------------------------------------------------------- 工具函数


def log(msg):
    print(f"[triage] {msg}", flush=True)


def http_json(url, method="GET", headers=None, payload=None, timeout=30):
    """统一 HTTP JSON 请求，返回 dict；失败抛异常"""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw) if raw.strip() else {}


def strip_code_fence(text):
    """模型有时会用 ```json 包一层，去掉它"""
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


def extract_json_object(text):
    """从文本里抠出第一个完整 JSON 对象，容忍前后有多余文字"""
    text = strip_code_fence(text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def normalize_labels(raw_labels):
    """把模型返回的标签洗成标准标签，最多保留 2 个"""
    out = []
    for item in raw_labels or []:
        label = str(item).strip().lower()
        label = LABEL_ALIASES.get(str(item).strip(), label)
        if label in ALLOWED_LABELS and label not in out:
            out.append(label)
        if len(out) >= 2:
            break
    return out or ["question"]


def normalize_priority(raw):
    p = str(raw or "").strip().upper()
    return p if p in ("P0", "P1", "P2") else "P2"


# ---------------------------------------------------------------- 分类逻辑


def fallback_classify(title, body):
    """无 API Key / LLM 失败时的关键词兜底"""
    text = f"{title}\n{body}".lower()
    labels = []
    for label, keywords in KEYWORD_RULES:
        if any(kw.lower() in text for kw in keywords):
            labels.append(label)
            break
    if not labels:
        labels = ["question"]

    priority = "P2"
    for level, keywords in PRIORITY_RULES:
        if any(kw.lower() in text for kw in keywords):
            priority = level
            break

    return {
        "summary": (title or "").strip()[:30] or "（无标题）",
        "labels": labels[:2],
        "priority": priority,
        "reply": "感谢反馈！我们已收到你的 issue，维护者会尽快确认并跟进。"
                 "（本条为自动分诊兜底回复）",
        "source": "keyword-fallback",
    }


def call_llm(title, body):
    """调用 OpenAI 兼容的 chat completions 接口"""
    api_key = os.environ.get("LLM_API_KEY", "").strip()
    if not api_key:
        log("未配置 LLM_API_KEY，使用关键词兜底分类")
        return None

    base_url = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com").rstrip("/")
    model = os.environ.get("LLM_MODEL", "deepseek-chat")
    url = f"{base_url}/chat/completions"

    user_content = f"标题：{title}\n\n正文：\n{body[:MAX_BODY_CHARS]}"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {api_key}"}

    last_err = None
    for attempt in range(1, LLM_RETRIES + 1):
        try:
            log(f"调用大模型 {model}（第 {attempt} 次）")
            data = http_json(url, "POST", headers, payload, timeout=LLM_TIMEOUT)
            content = data["choices"][0]["message"]["content"]
            parsed = extract_json_object(content)
            if not parsed:
                raise ValueError(f"无法从模型输出解析 JSON：{content[:200]}")
            parsed["source"] = "llm"
            return parsed
        except Exception as e:  # noqa: BLE001 兜底要宽
            last_err = e
            log(f"调用失败：{e}")
            if attempt < LLM_RETRIES:
                time.sleep(2)

    log(f"大模型调用全部失败，回退关键词分类：{last_err}")
    return None


# ---------------------------------------------------------------- GitHub 写回


def github_request(path, method="GET", payload=None, is_graphql=False):
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token:
        raise RuntimeError("缺少 GITHUB_TOKEN")
    url = "https://api.github.com/graphql" if is_graphql else f"https://api.github.com{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "ai-issue-triage",
    }
    return http_json(url, method, headers, payload, timeout=30)


def build_comment(result, issue_number):
    labels = " · ".join(result["labels"])
    priority = result.get("priority", "P2")
    return (
        "## 🤖 AI 分诊报告\n\n"
        f"**摘要**：{result['summary']}\n\n"
        f"**分类**：`{labels}`　**优先级**：`{priority}`\n\n"
        f"**回复草稿**：\n\n> {result['reply']}\n\n"
        "---\n"
        "<sub>由 AI Issue Triage 工作流自动生成，内容仅供参考，请维护者确认后再回复。"
        f"（分类方式：{result.get('source', 'unknown')} · issue #{issue_number}）</sub>"
    )


def main():
    event_path = os.environ.get("GITHUB_EVENT_PATH", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    dry_run = os.environ.get("DRY_RUN", "0") == "1"

    if not event_path or not os.path.exists(event_path):
        log("未找到事件 payload，退出（此脚本应在 GitHub Actions 中运行）")
        return 0

    with open(event_path, "r", encoding="utf-8") as f:
        event = json.load(f)

    issue = event.get("issue") or {}
    issue_number = issue.get("number")

    # 手动触发时只有 issue_number，需要回查
    if not issue_number and event.get("inputs"):
        issue_number = int(event["inputs"].get("issue_number"))
        issue = github_request(f"/repos/{repo}/issues/{issue_number}")
        log(f"手动触发，已回查 issue #{issue_number}")

    if not issue_number:
        log("无法获取 issue 编号，退出")
        return 0

    title = (issue.get("title") or "").strip()
    body = (issue.get("body") or "").strip()
    log(f"处理 issue #{issue_number}：{title[:40]}")

    result = call_llm(title, body) or fallback_classify(title, body)
    result["labels"] = normalize_labels(result.get("labels"))
    result["priority"] = normalize_priority(result.get("priority"))
    result["summary"] = str(result.get("summary") or title)[:60]
    result["reply"] = str(result.get("reply") or "").strip() or "感谢反馈，我们会尽快跟进。"

    log(f"分类结果：{result['labels']} / {result['priority']} / {result.get('source')}")

    if dry_run:
        log("DRY_RUN 模式，不写回 GitHub。预览内容：")
        print("-" * 60)
        print(build_comment(result, issue_number))
        print("-" * 60)
        return 0

    # 1) 贴评论
    github_request(
        f"/repos/{repo}/issues/{issue_number}/comments",
        "POST",
        {"body": build_comment(result, issue_number)},
    )
    log("已发布分诊评论")

    # 2) 打标签（GitHub 会自动创建不存在的标签）
    github_request(
        f"/repos/{repo}/issues/{issue_number}/labels",
        "POST",
        {"labels": result["labels"]},
    )
    log(f"已打标签：{result['labels']}")

    # 3) 输出给 Actions 摘要面板
    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a", encoding="utf-8") as f:
            f.write(f"### Issue #{issue_number} 分诊完成\n\n")
            f.write(f"- 摘要：{result['summary']}\n")
            f.write(f"- 标签：{', '.join(result['labels'])}\n")
            f.write(f"- 优先级：{result['priority']}\n\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
