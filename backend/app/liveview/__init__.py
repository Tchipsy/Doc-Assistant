"""实时渲染子系统。

设计（按需求重新设计，非 md 拼装）：
- 服务端维护权威组件树 LiveTree（节点 = 目录/节/摘要框/插件框），
  一切变更以 render.op 事件推送前端（事件溯源）；
- Pass1StreamParser 消费 pass1 的 LLM delta：标题流入即建节 + 目录条目
  （增量编号与 finalize 同算法，实时编号=最终编号）；@@summary 头到达即在
  当前节挂摘要框，内容流入框内；页标记过滤；图片引用即时重写；
- Pass2StreamParser 消费 pass2 delta：块外内容丢弃，@@<插件> <编号> 头到达
  即在对应节挂插件框，内容流入框内；
- 检查点回滚：树 + 解析器状态快照，rollback 后以 op=replace 全量替换；
- build_from_artifacts：从磁盘产物构建同构树（完成态预览 / pass2 基底）。

树节点（前后端共同契约）：
    root            根（children 顺序即文档顺序）
    toc / toc_entry 目录（entry.props.target -> 节点 id）
    section         节（props: num/level/title/anchor；md 为正文）
    summary_box     摘要框（props.anchor = "summary:<num>"）
    plugin_box      插件框（props: plugin/num；anchor = "plugin:<plugin>:<num>"）
"""
from app.liveview.tree import (LiveTree, LiveSession, live_sessions,  # noqa: F401
                               get_or_create_session, drop_session)
from app.liveview.parser import Pass1StreamParser, Pass2StreamParser  # noqa: F401
from app.liveview.build import build_tree_from_artifacts  # noqa: F401
