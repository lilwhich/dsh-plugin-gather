# 🤖 AI Issue Triage

新 issue 一打开，自动完成 **摘要 → 分类打标签 → 生成回复草稿**，全程无人值守。

```
有人提 issue
    │
    ▼
GitHub Actions 触发（on: issues: types: [opened]）
    │
    ▼
scripts/triage.py 读取 issue 标题 + 正文
    │
    ▼
调用大模型（OpenAI 兼容接口）→ 强制 JSON 结构化输出
    │
    ▼
解析 & 清洗（去代码块 / 中文标签映射 / 非法值收敛）
    │
    ├──→ POST  /issues/:number/comments   贴上分诊报告
    └──→ POST  /issues/:number/labels     打上分类标签
```

## 文件结构

```
.github/workflows/issue-triage.yml   触发器与权限声明
scripts/triage.py                    主逻辑（仅标准库，无第三方依赖）
scripts/test_triage_parse.py         JSON 解析容错测试
```

## 启用步骤

1. **（可选）配置大模型密钥**：仓库 `Settings → Secrets and variables → Actions → New repository secret`
   - `LLM_API_KEY` —— DeepSeek / 通义 / OpenAI 均可
   - `LLM_BASE_URL` —— 默认 `https://api.deepseek.com`
   - `LLM_MODEL` —— 默认 `deepseek-chat`

2. **触发一次**：提一个新 issue，或在 Actions 面板手动 `Run workflow` 填 issue 编号

3. **不配密钥也能跑**：自动降级为关键词兜底分类（见下）

## 设计要点

| 关注点 | 做法 |
|--------|------|
| **密钥安全** | API Key 只走 `secrets`，从不硬编码进代码 |
| **最小权限** | workflow 仅申请 `issues: write` + `contents: read` |
| **输出可靠性** | `response_format: json_object` + 自研兜底解析（去 ``` 代码块、括号配对提取） |
| **容错降级** | 大模型失败 / 无 Key / 返回非法标签 → 自动切关键词分类，流程不中断 |
| **成本控制** | issue 正文截断 4000 字符，temperature 0.2 |
| **人工把关** | 评论注明「内容仅供参考」，回复草稿不自动对外发送 |
| **可测试** | `DRY_RUN=1` 本地预览不写回；`test_triage_parse.py` 覆盖 4 种脏输入 |

## 本地调试

```bash
# 造一个假事件
echo '{"issue":{"number":1,"title":"安装后报错","body":"Traceback..."}}' > /tmp/event.json

# 干跑：只打印，不写回 GitHub
GITHUB_EVENT_PATH=/tmp/event.json \
GITHUB_REPOSITORY=owner/repo \
DRY_RUN=1 \
python scripts/triage.py
```

## 分类标签

`bug` · `feature` · `question` · `docs` · `enhancement` · `invalid`
（模型返回中文如「缺陷」会自动映射；非法标签收敛为 `question`）

优先级：`P0`（阻断/安全） · `P1`（影响使用） · `P2`（一般建议）
