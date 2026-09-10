"""异常分类：前端/调用方可据此映射错误码。"""


class DocumentAssistantError(Exception):
    """本包所有受控异常的基类。"""


class InvalidArguments(DocumentAssistantError):
    """参数非法（org/sum 配对、空插件名等）。"""


class PromptNotFound(DocumentAssistantError):
    """prompts/ 下指定的提示词文件不存在。"""

    def __init__(self, kind: str, name: str, available: list[str]):
        self.kind, self.name, self.available = kind, name, available
        super().__init__(f"提示词不存在：{kind}/{name}（可用：{available}）")


class ArtifactMissing(DocumentAssistantError):
    """所需中间产物不存在。"""


class OCRError(DocumentAssistantError):
    """OCR 任务失败。"""


class LLMError(DocumentAssistantError):
    """LLM 调用最终失败。"""


class Md2PdfError(DocumentAssistantError):
    """Markdown -> PDF 转换失败（浏览器缺失/被占用/渲染出错）。"""
