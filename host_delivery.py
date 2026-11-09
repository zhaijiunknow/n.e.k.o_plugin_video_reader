"""Deliver sampled video images through the host, without a separate model slot."""
from __future__ import annotations

import asyncio
import base64
import binascii
import math
from io import BytesIO

from .model_analysis import AnalysisError

MAX_SHEETS = 128
MAX_SOURCE_BYTES = 64 * 1024 * 1024
MAX_IMAGE_BYTES = 350 * 1024
MAX_EDGE = 2048
SUMMARY_NOTE = (
    "视频抽帧已经结束，以下图片是同一次视频任务的全部已采样拼图。"
    "请结合所有图片，只回复一次连贯的中文概况，不要逐图回复或只说正在观看。"
    "合成图内的拼图按从左到右、从上到下排列，S 编号对应下方时间映射；"
    "每张原拼图内的格编号重新开始。图片经过缩放，小字可能不可辨认，不能猜测。"
)


def prepare_images(sheets, manifests, *, max_images=8):
    """Keep every sheet in chronological grids; bound both pixels and wire bytes."""
    from PIL import Image, ImageDraw, UnidentifiedImageError

    if not sheets or len(sheets) > MAX_SHEETS or len(manifests) != len(sheets):
        raise AnalysisError("视频拼图为空、数量超限或时间映射缺失；请缩短观看范围。")
    if not 1 <= max_images <= 8:
        raise ValueError("invalid image budget")
    payloads, mappings = [], []
    source_bytes = 0
    group_size = math.ceil(len(sheets) / max_images)
    for offset in range(0, len(sheets), group_size):
        group = sheets[offset:offset + group_size]
        columns = math.ceil(math.sqrt(len(group)))
        rows = math.ceil(len(group) / columns)
        cell_w, cell_h = MAX_EDGE // columns, MAX_EDGE // rows
        canvas = Image.new("RGB", (columns * cell_w, rows * cell_h), "white")
        draw = ImageDraw.Draw(canvas)
        mapping = []
        try:
            for index, sheet in enumerate(group):
                if not isinstance(sheet, str) or not sheet.startswith(("data:image/png;base64,", "data:image/jpeg;base64,")):
                    raise AnalysisError("视频拼图格式无效。")
                source_bytes += len(sheet)
                if source_bytes > MAX_SOURCE_BYTES:
                    raise AnalysisError("视频拼图超过内存预算，请缩短观看范围。")
                raw = base64.b64decode(sheet.split(",", 1)[1], validate=True)
                x, y = (index % columns) * cell_w, (index // columns) * cell_h
                with Image.open(BytesIO(raw)) as source:
                    if source.width * source.height > 16_000_000:
                        raise AnalysisError("单张视频拼图尺寸过大，请降低 video.quality。")
                    source.thumbnail((cell_w, cell_h - 24), Image.Resampling.LANCZOS)
                    with source.convert("RGB") as tile:
                        canvas.paste(tile, (x, y + 24))
                number = offset + index + 1
                draw.text((x + 4, y + 4), f"S{number}", fill="black")
                frames = manifests[number - 1]["frames"]
                times = "; ".join(f"格{n + 1}={frame['t']}秒" for n, frame in enumerate(frames))
                mapping.append(f"S{number}: {times}")
            # Match the SDK's JPEG quality. Reduce dimensions, not quality, so
            # a later SDK normalization does not inflate a low-quality JPEG.
            while True:
                output = BytesIO()
                canvas.save(output, format="JPEG", quality=88)
                data = output.getvalue()
                if len(data) <= MAX_IMAGE_BYTES:
                    break
                resized = canvas.resize((int(canvas.width * .8), int(canvas.height * .8)))
                canvas.close()
                canvas = resized
                if min(canvas.size) < 256:
                    raise AnalysisError("视频拼图无法压缩到宿主图片预算，请缩短观看范围。")
            payloads.append(data)
            mappings.append(f"合成图{len(payloads)}（{columns}列，按行排列）：\n" + "\n".join(mapping))
        except (ValueError, KeyError, TypeError, binascii.Error, UnidentifiedImageError, OSError) as exc:
            if isinstance(exc, AnalysisError):
                raise
            raise AnalysisError("视频拼图或时间映射无法读取，请重新抽帧。") from None
        finally:
            canvas.close()
    return payloads, mappings


async def deliver_to_host(ctx, prompt, sheets, manifests, *, target=None, return_images=False):
    payloads, mappings = await asyncio.to_thread(
        prepare_images, sheets, manifests, max_images=2 if return_images else 8,
    )
    text = SUMMARY_NOTE + "\n" + prompt + "\n" + "\n".join(mappings)
    if len(text.encode("utf-8")) > 120_000:
        raise AnalysisError("视频时间映射超过宿主消息预算，请缩短观看范围。")
    if return_images:
        # Resume the existing tool turn; a proactive push here would start a
        # second reply. The public tool-result image contract accepts 2 images.
        return {"images": [
            {"data_b64": base64.b64encode(data).decode("ascii"), "mime": "image/jpeg",
             "vision_prompt": "理解这张视频合成图，按 S 编号描述可见内容；不要猜测小字或声音。"}
            for data in payloads
        ], "prompt": text}
    if not callable(getattr(getattr(ctx, "images", None), "upload", None)):
        raise AnalysisError("当前宿主不支持插件图片上传，请更新 Steam 版 N.E.K.O 后重试；无需配置模型密钥。")
    parts = [{"type": "text", "text": text}]
    for data in payloads:
        part = await ctx.images.upload(data, mime="image/jpeg", timeout=20.0)
        if not isinstance(part, dict) or part.get("type") != "image" or not part.get("url"):
            raise AnalysisError("宿主未接收视频图片，没有提交概况请求，请重试。")
        parts.append(part)
    # Uploading is silent. Only after ALL images succeeded do we request ONE
    # reply, with no retries (submission is not a generation acknowledgement).
    submitted = ctx.push_message(
        visibility=[], ai_behavior="respond", parts=parts,
        source="video_reader", target_lanlan=target,
    )
    if not isinstance(submitted, dict) or submitted.get("submitted") is not True:
        raise AnalysisError("视频图片已准备好，但宿主未接受概况请求；请确认对话已连接后重试。")
    return {"host_images": len(payloads), "submitted": True}
