import importlib.util

spec = importlib.util.spec_from_file_location("t", "scripts/triage.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

FENCE = "```"

cases = {
    "带代码块+中文标签+前后废话": (
        "好的，分析结果如下：\n" + FENCE + "json\n"
        + '{"summary": "安装后启动崩溃", "labels": ["缺陷"], "priority": "P0",'
          ' "reply": "已收到，复现后尽快修复。"}\n' + FENCE + "\n以上。"
    ),
    "纯 JSON 无代码块": '{"summary": "希望支持深色模式", "labels": ["feature"], '
                        '"priority": "P2", "reply": "好建议，已加入待办。"}',
    "非法标签自动收敛": '{"summary": "乱来的标签", "labels": ["瞎写的"], '
                        '"priority": "P9", "reply": "测试"}',
    "完全不是 JSON": "抱歉我无法处理这个问题。",
}

for name, raw in cases.items():
    parsed = m.extract_json_object(raw)
    if not parsed:
        print(f"[{name}] -> 解析失败（将回退关键词兜底）")
        continue
    print(f"[{name}]")
    print(f"   标签: {m.normalize_labels(parsed.get('labels'))}")
    print(f"   优先级: {m.normalize_priority(parsed.get('priority'))}")
    print(f"   摘要: {str(parsed.get('summary'))[:30]}")
