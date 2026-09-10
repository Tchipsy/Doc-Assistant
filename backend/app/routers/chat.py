"""聊天路由：会话 CRUD（含每会话设置）+ /api/chat SSE 流 + 编辑重发/分支/对话名。

断连传播（2026-09-05 实验定稿，uvicorn 0.51 + starlette 1.3.1）：
- 同步生成器在客户端断开时收不到 GeneratorExit（GC 不可靠，worker 会跑完）；
- 改用 async 生成器，双通道检测断开：
  1) watcher 任务监听 request.receive() 的 http.disconnect（主动）；
  2) starlette listen_for_disconnect 触发任务组取消 → 生成器内抛 CancelledError（被动）。
  任一触发即调 ChatStream.abort() → worker 保存已生成部分（stopped=1）。
"""
import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.services import chat_service

router = APIRouter(prefix="/api", tags=["chat"])


class SessionCreate(BaseModel):
    title: str = "新会话"


class SessionPatch(BaseModel):
    """重命名 / 每会话设置（mode/model/kbIds/webSearch）任意子集。"""
    title: str | None = None
    mode: str | None = None
    model: str | None = None
    kbIds: list[str] | None = None
    webSearch: bool | None = None


class ChatBody(BaseModel):
    sessionId: str | None = None
    content: str
    kbIds: list[str] = []
    model: str | None = None
    mode: str = "chat"
    webSearch: bool = False    # 会话级联网开关（步骤4，仅 chat/automatic 生效）


class RegenerateBody(BaseModel):
    messageId: str
    content: str


class BranchBody(BaseModel):
    messageId: str
    includeCurrent: bool = True   # debug4 #14：false=不复制该消息本身（user 消息入输入框草稿）


async def _watch_disconnect(request: Request, stream) -> None:
    try:
        while True:
            msg = await request.receive()
            if isinstance(msg, dict) and msg.get("type") == "http.disconnect":
                stream.abort()
                return
    except Exception:  # noqa: BLE001
        pass


def _sse_response(stream: "chat_service.ChatStream", request: Request):
    async def gen():
        watcher = asyncio.ensure_future(_watch_disconnect(request, stream))
        try:
            while True:
                frame = await stream.next()
                if frame is None:
                    break
                yield f"data: {json.dumps(frame, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            stream.abort()
            raise
        except OSError:  # ASGI spec >= 2.4 时 send 对断连抛 OSError
            stream.abort()
            raise
        finally:
            watcher.cancel()
            stream.abort()  # 兜底：未完成的流中止并保存部分

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ============================ 会话 ============================

@router.get("/sessions")
def list_sessions():
    return {"sessions": chat_service.list_sessions()}


@router.post("/sessions")
def create_session(body: SessionCreate):
    return chat_service.create_session(body.title)


@router.patch("/sessions/{sid}")
def patch_session(sid: str, body: SessionPatch):
    fields = body.model_dump(exclude_unset=True)
    chat_service.update_session(sid, fields)
    return {"ok": True}


@router.delete("/sessions/{sid}")
def delete_session(sid: str):
    chat_service.delete_session(sid)
    return {"ok": True}


@router.get("/sessions/{sid}/messages")
def get_messages(sid: str):
    return {"messages": chat_service.get_messages(sid)}


@router.post("/sessions/{sid}/regenerate")
async def regenerate_session(sid: str, body: RegenerateBody, request: Request):
    try:
        stream = chat_service.start_regenerate(sid, body.messageId, body.content.strip())
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return _sse_response(stream, request)


@router.post("/sessions/{sid}/branch")
def branch_session(sid: str, body: BranchBody):
    try:
        return chat_service.branch_session(sid, body.messageId, body.includeCurrent)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/sessions/{sid}/generate-title")
def generate_title(sid: str):
    try:
        return chat_service.generate_title(sid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ============================ 聊天 ============================

@router.post("/chat")
async def chat(body: ChatBody, request: Request):
    stream = chat_service.start_chat(body.model_dump())
    return _sse_response(stream, request)
