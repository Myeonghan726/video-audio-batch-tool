#!/usr/bin/env python3
import fcntl
import json
import mimetypes
import os
import re
import socket
import subprocess
import threading
import time
import uuid
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
INPUTS = ROOT / "输入缓存"
OUTPUTS = ROOT / "处理完成"
ENGINE = ROOT / "bin" / "bgm_mux"
SESSION = ROOT / ".batch-session.json"
SERVER_LOCK = ROOT / ".server.lock"
SERVER_INFO = ROOT / ".server-info.json"
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v"}
AUDIO_EXTENSIONS = {".mp3", ".m4a", ".wav", ".aac"}
DEFAULT_SETTINGS = {
    "audioMode": "replace",
    "originalDb": -60,
    "bgmDb": 0,
    "renameOutputs": False,
}
INPUTS.mkdir(exist_ok=True)
OUTPUTS.mkdir(exist_ok=True)

state_lock = threading.Lock()
state = {
    "bgms": {},
    "videos": {},
    "batches": {},
    "activeBatchId": None,
    "processing": False,
    "startedAt": None,
    "settings": dict(DEFAULT_SETTINGS),
}


def persist_state():
    snapshot = {
        "bgms": state["bgms"],
        "videos": state["videos"],
        "batches": state["batches"],
        "activeBatchId": state["activeBatchId"],
        "processing": False,
        "startedAt": state["startedAt"],
        "settings": state["settings"],
    }
    temporary = SESSION.with_suffix(".tmp")
    temporary.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
    temporary.replace(SESSION)


def restore_state():
    if not SESSION.is_file():
        return
    try:
        saved = json.loads(SESSION.read_text(encoding="utf-8"))
        state["bgms"] = saved.get("bgms", {})
        state["videos"] = saved.get("videos", {})
        state["batches"] = saved.get("batches", {})
        state["settings"] = {**DEFAULT_SETTINGS, **saved.get("settings", {})}
        state["activeBatchId"] = None
        # Older sessions did not have batches; preserve their outputs as one history batch.
        legacy = [video for video in state["videos"].values() if video.get("status") == "done" and not video.get("batchId")]
        if legacy:
            legacy_id = "history"
            state["batches"][legacy_id] = {"id": legacy_id, "label": "历史处理", "startedAt": saved.get("startedAt") or time.time(), "total": len(legacy), "done": len(legacy), "failed": 0, "status": "done"}
            for video in legacy:
                video["batchId"] = legacy_id
        recovered = False
        for video in state["videos"].values():
            if video.get("status") == "processing":
                video["status"] = "error"
                video["error"] = "上次处理被中断，可重新处理"
                recovered = True
        for batch in state["batches"].values():
            if batch.get("status") == "processing":
                batch["status"] = "done"
                recovered = True
        state["processing"] = False
        state["startedAt"] = saved.get("startedAt")
        if recovered:
            persist_state()
    except Exception:
        pass


restore_state()


def safe_name(name):
    name = Path(name or "file").name
    name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", name).strip(" .")
    if len(name) > 180:
        suffix = Path(name).suffix
        name = f"{name[:180 - len(suffix)]}{suffix}" if 0 < len(suffix) < 20 else name[:180]
    return name or "file"


def unique_path(directory, filename):
    candidate = directory / filename
    stem, suffix = candidate.stem, candidate.suffix
    index = 2
    while candidate.exists():
        candidate = directory / f"{stem}_{index}{suffix}"
        index += 1
    return candidate


def build_archive(videos, label):
    archive = OUTPUTS / f"{safe_name(label)}_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.zip"
    added = 0
    used_names = set()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_STORED) as bundle:
        outputs = [(video.get("output"), video.get("outputName") or video.get("output")) for video in videos if video.get("status") == "done" and video.get("output")]
        for name, download_name in outputs:
            path = OUTPUTS / safe_name(name)
            if path.is_file():
                archive_name = safe_name(download_name)
                stem, suffix = Path(archive_name).stem, Path(archive_name).suffix
                index = 2
                while archive_name.casefold() in used_names:
                    archive_name = f"{stem}_{index}{suffix}"
                    index += 1
                used_names.add(archive_name.casefold())
                bundle.write(path, archive_name)
                added += 1
    if not added:
        archive.unlink(missing_ok=True)
        raise ValueError("没有可下载的成品文件")
    return archive


def public_state():
    with state_lock:
        batch_summaries = []
        for batch in state["batches"].values():
            summary = dict(batch)
            records = [video for video in state["videos"].values() if video.get("batchId") == batch["id"]]
            summary["done"] = sum(video.get("status") == "done" for video in records)
            summary["failed"] = sum(video.get("status") == "error" for video in records)
            summary["total"] = len(records) if batch.get("status") == "done" else batch.get("total", len(records))
            batch_summaries.append(summary)
        return {
            "bgms": [
                {"id": key, "name": value["name"]}
                for key, value in state["bgms"].items()
            ],
            "videos": [
                {key: value for key, value in item.items() if key != "path"}
                for item in state["videos"].values()
            ],
            "processing": state["processing"],
            "startedAt": state["startedAt"],
            "activeBatchId": state["activeBatchId"],
            "settings": dict(state["settings"]),
            "batches": sorted(batch_summaries, key=lambda batch: batch.get("startedAt", 0), reverse=True),
        }


def process_batch(items, batch_id):
    try:
        for position, item in enumerate(items, 1):
            video_id = item.get("videoId")
            bgm_id = item.get("bgmId")
            start = max(0.0, float(item.get("start") or 0))
            mode = "mix" if item.get("audioMode") == "mix" else "replace"
            original_db = min(12.0, max(-60.0, float(item.get("originalDb") or 0)))
            bgm_db = min(12.0, max(-60.0, float(item.get("bgmDb") if item.get("bgmDb") is not None else -8)))
            with state_lock:
                video = state["videos"].get(video_id)
                bgm = state["bgms"].get(bgm_id)
                if not video or not bgm:
                    continue
                video["status"] = "processing"
                video["error"] = ""
                video["bgmId"] = bgm_id
                video["start"] = start
                video["audioMode"] = mode
                video["originalDb"] = original_db
                video["bgmDb"] = bgm_db
                video["batchId"] = batch_id
                source = Path(video["path"])
                bgm_path = Path(bgm["path"])
                persist_state()

            original_stem = Path(video["name"]).stem
            output_name = f"{position}.mp4" if item.get("renameOutputs") else f"{original_stem}_BGM.mp4"
            output_path = unique_path(OUTPUTS, safe_name(output_name))
            try:
                result = subprocess.run(
                    [str(ENGINE), str(source), str(bgm_path), str(start), str(output_path), mode, str(original_db), str(bgm_db)],
                    capture_output=True,
                    text=True,
                    timeout=1800,
                )
                if result.returncode != 0:
                    raise RuntimeError((result.stderr or result.stdout or "未知处理错误").strip())
                with state_lock:
                    video["status"] = "done"
                    video["output"] = output_path.name
                    video["outputName"] = output_name
                    state["batches"][batch_id]["done"] += 1
                    persist_state()
            except Exception as exc:
                try:
                    output_path.unlink(missing_ok=True)
                except Exception:
                    pass
                with state_lock:
                    video["status"] = "error"
                    video["error"] = str(exc)
                    state["batches"][batch_id]["failed"] += 1
                    persist_state()
    finally:
        with state_lock:
            state["processing"] = False
            state["activeBatchId"] = None
            if batch_id in state["batches"]:
                state["batches"][batch_id]["status"] = "done"
            persist_state()


class Handler(BaseHTTPRequestHandler):
    server_version = "BGMBatch/1.0"

    def log_message(self, format, *args):
        return

    def send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; media-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")

    def trusted_mutation(self):
        allowed = {"127.0.0.1", "localhost"}
        host = urlparse(f"//{self.headers.get('Host', '')}").hostname
        origin = self.headers.get("Origin")
        origin_host = urlparse(origin).hostname if origin else None
        return host in allowed and (not origin or origin_host in allowed)

    def send_json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(data)

    def serve_file(self, path, download=False, no_cache=False, download_name=None, allow_range=False):
        if not path.is_file():
            self.send_error(404)
            return
        size = path.stat().st_size
        start, end, status = 0, max(0, size - 1), 200
        range_header = self.headers.get("Range") if allow_range else None
        if range_header and size:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            first, last = match.groups()
            if first:
                start = int(first)
                end = min(int(last), size - 1) if last else size - 1
            elif last:
                start = max(0, size - int(last))
                end = size - 1
            if start >= size or end < start:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            status = 206
        length = max(0, end - start + 1) if size else 0
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_security_headers()
        if allow_range:
            self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if no_cache:
            self.send_header("Cache-Control", "no-store, max-age=0")
        if download:
            encoded = quote(safe_name(download_name or path.name))
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{encoded}")
        self.end_headers()
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining:
                chunk = handle.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            self.send_json(public_state())
            return
        if parsed.path.startswith("/inputs/"):
            _, _, kind, item_id = parsed.path.split("/", 3)
            with state_lock:
                collection = state["videos"] if kind == "video" else state["bgms"] if kind == "bgm" else {}
                item = collection.get(item_id)
                path = Path(item["path"]) if item else None
            if path:
                self.serve_file(path, allow_range=kind == "video")
            else:
                self.send_error(404)
            return
        if parsed.path == "/api/download-all":
            with state_lock:
                videos = list(state["videos"].values())
            try:
                archive = build_archive(videos, "全部处理完成")
                self.serve_file(archive, download=True, no_cache=True)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 404)
            finally:
                if 'archive' in locals():
                    archive.unlink(missing_ok=True)
            return
        if parsed.path == "/api/download-video":
            video_id = parse_qs(parsed.query).get("id", [""])[0]
            with state_lock:
                video = state["videos"].get(video_id)
                output = video.get("output") if video else None
                download_name = video.get("outputName") if video else None
            if not output:
                self.send_json({"error": "未找到该成品"}, 404)
                return
            self.serve_file(OUTPUTS / safe_name(output), download=True, no_cache=True, download_name=download_name)
            return
        if parsed.path == "/api/download-selected":
            requested_ids = set(filter(None, parse_qs(parsed.query).get("ids", [""])[0].split(",")))
            with state_lock:
                videos = [video for video_id, video in state["videos"].items() if video_id in requested_ids]
            try:
                archive = build_archive(videos, "已选成品")
                self.serve_file(archive, download=True, no_cache=True)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 404)
            finally:
                if 'archive' in locals():
                    archive.unlink(missing_ok=True)
            return
        if parsed.path == "/api/download-batch":
            batch_id = parse_qs(parsed.query).get("id", [""])[0]
            with state_lock:
                batch = state["batches"].get(batch_id)
                videos = [video for video in state["videos"].values() if video.get("batchId") == batch_id]
            if not batch:
                self.send_json({"error": "未找到该处理批次"}, 404)
                return
            if not any(video.get("status") == "done" and video.get("output") for video in videos):
                self.send_json({"error": "该批次已没有可下载的成品"}, 404)
                return
            try:
                archive = build_archive(videos, batch.get("label", "处理批次"))
                self.serve_file(archive, download=True, no_cache=True)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 404)
            finally:
                if 'archive' in locals():
                    archive.unlink(missing_ok=True)
            return
        if parsed.path.startswith("/downloads/"):
            filename = safe_name(unquote(parsed.path[len("/downloads/"):]))
            self.serve_file(OUTPUTS / filename, download=True, no_cache=True)
            return

        relative = "index.html" if parsed.path == "/" else parsed.path.lstrip("/")
        path = (STATIC / relative).resolve()
        if STATIC.resolve() not in path.parents and path != STATIC.resolve():
            self.send_error(403)
            return
        # The UI evolves frequently during a local session. Never let a stale
        # HTML document keep pointing at an older CSS/JavaScript bundle.
        self.serve_file(path, no_cache=path.suffix in {".html", ".js", ".css"})

    def do_POST(self):
        if not self.trusted_mutation():
            self.send_json({"error": "请求来源无效"}, 403)
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/upload":
            query = parse_qs(parsed.query)
            self.handle_upload(query.get("kind", [""])[0], query.get("name", [""])[0])
            return
        if parsed.path == "/api/process":
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
                items = payload.get("items", [])
                if not items:
                    raise ValueError("没有待处理的视频")
                with state_lock:
                    if state["processing"]:
                        self.send_json({"error": "已有批次正在处理"}, 409)
                        return
                    seen = set()
                    for item in items:
                        video_id, bgm_id = item.get("videoId"), item.get("bgmId")
                        video = state["videos"].get(video_id)
                        if not video or video.get("status") not in {"ready", "error"}:
                            raise ValueError("队列中包含无法处理的视频")
                        if not bgm_id or bgm_id not in state["bgms"]:
                            raise ValueError(f"{video.get('name', '视频')} 未分配有效 BGM")
                        if video_id in seen:
                            raise ValueError("同一视频不能重复加入一个批次")
                        seen.add(video_id)
                    state["processing"] = True
                    state["startedAt"] = time.time()
                    batch_id = uuid.uuid4().hex
                    state["batches"][batch_id] = {"id": batch_id, "label": time.strftime("%m/%d %H:%M"), "startedAt": state["startedAt"], "total": len(items), "done": 0, "failed": 0, "status": "processing"}
                    state["activeBatchId"] = batch_id
                    persist_state()
                threading.Thread(target=process_batch, args=(items, batch_id), daemon=True).start()
                self.send_json({"ok": True, "batchId": batch_id})
            except Exception as exc:
                self.send_json({"error": str(exc)}, 400)
            return
        if parsed.path == "/api/update-videos":
            length = int(self.headers.get("Content-Length", 0))
            try:
                items = json.loads(self.rfile.read(length) or b"{}").get("items", [])
                with state_lock:
                    if state["processing"]:
                        raise ValueError("处理中暂时不能修改视频设置")
                    for item in items:
                        video = state["videos"].get(item.get("videoId"))
                        if not video or video.get("status") not in {"ready", "error"}:
                            continue
                        bgm_id = item.get("bgmId") or ""
                        if bgm_id and bgm_id not in state["bgms"]:
                            raise ValueError("所选 BGM 已不存在")
                        video["bgmId"] = bgm_id
                        video["start"] = max(0.0, float(item.get("start") or 0))
                    persist_state()
                self.send_json({"ok": True})
            except Exception as exc:
                self.send_json({"error": str(exc)}, 400)
            return
        if parsed.path == "/api/settings":
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
                with state_lock:
                    current = state["settings"]
                    mode = "mix" if payload.get("audioMode", current["audioMode"]) == "mix" else "replace"
                    state["settings"] = {
                        "audioMode": mode,
                        "originalDb": min(0.0, max(-60.0, float(payload.get("originalDb", current["originalDb"])))),
                        "bgmDb": min(0.0, max(-60.0, float(payload.get("bgmDb", current["bgmDb"])))),
                        "renameOutputs": bool(payload.get("renameOutputs", current["renameOutputs"])),
                    }
                    persist_state()
                self.send_json({"ok": True})
            except Exception as exc:
                self.send_json({"error": str(exc)}, 400)
            return
        if parsed.path == "/api/download-selected":
            length = int(self.headers.get("Content-Length", 0))
            try:
                body = self.rfile.read(length)
                if self.headers.get("Content-Type", "").startswith("application/x-www-form-urlencoded"):
                    requested_ids = set(filter(None, parse_qs(body.decode("utf-8")).get("ids", [""])[0].split(",")))
                else:
                    requested_ids = set(json.loads(body or b"{}").get("videoIds", []))
                with state_lock:
                    videos = [video for video_id, video in state["videos"].items() if video_id in requested_ids]
                if not videos:
                    raise ValueError("未找到已选视频")
                archive = build_archive(videos, "已选成品")
                try:
                    self.serve_file(archive, download=True, no_cache=True)
                finally:
                    archive.unlink(missing_ok=True)
            except Exception as exc:
                self.send_json({"error": str(exc)}, 400)
            return
        if parsed.path == "/api/requeue":
            length = int(self.headers.get("Content-Length", 0))
            try:
                video_id = json.loads(self.rfile.read(length) or b"{}").get("videoId")
                with state_lock:
                    if state["processing"]:
                        raise ValueError("请等待当前批次处理完成后再重新处理")
                    video = state["videos"].get(video_id)
                    if not video or video.get("status") not in {"done", "error"}:
                        raise ValueError("未找到可重新设置的视频")
                    if video.get("output"):
                        (OUTPUTS / safe_name(video["output"])).unlink(missing_ok=True)
                    video["status"] = "ready"
                    video["error"] = ""
                    video["output"] = ""
                    video["outputName"] = ""
                    video["batchId"] = ""
                    persist_state()
                self.send_json({"ok": True})
            except Exception as exc:
                self.send_json({"error": str(exc)}, 400)
            return
        if parsed.path == "/api/reorder":
            length = int(self.headers.get("Content-Length", 0))
            try:
                ids = json.loads(self.rfile.read(length) or b"{}").get("videoIds", [])
                with state_lock:
                    known = [video_id for video_id in ids if video_id in state["videos"]]
                    remainder = [video_id for video_id in state["videos"] if video_id not in known]
                    state["videos"] = {video_id: state["videos"][video_id] for video_id in known + remainder}
                    persist_state()
                self.send_json({"ok": True})
            except Exception as exc:
                self.send_json({"error": str(exc)}, 400)
            return
        self.send_error(404)

    def do_DELETE(self):
        if not self.trusted_mutation():
            self.send_json({"error": "请求来源无效"}, 403)
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/batch":
            batch_id = parse_qs(parsed.query).get("id", [""])[0]
            with state_lock:
                if state["processing"]:
                    self.send_json({"error": "请等待当前批次处理完成后再删除批次记录"}, 409)
                    return
                if not state["batches"].pop(batch_id, None):
                    self.send_json({"error": "未找到该处理批次"}, 404)
                    return
                persist_state()
            self.send_json({"ok": True})
            return
        if parsed.path != "/api/item":
            self.send_error(404)
            return
        query = parse_qs(parsed.query)
        kind = query.get("kind", [""])[0]
        item_id = query.get("id", [""])[0]
        if kind not in {"video", "bgm"} or not item_id:
            self.send_json({"error": "删除目标无效"}, 400)
            return
        with state_lock:
            if state["processing"]:
                self.send_json({"error": "请等待当前批次处理完成后再删除"}, 409)
                return
            collection = state["videos"] if kind == "video" else state["bgms"]
            item = collection.pop(item_id, None)
            if not item:
                self.send_json({"error": "未找到该素材"}, 404)
                return
            if kind == "bgm":
                for video in state["videos"].values():
                    if video.get("bgmId") == item_id and video.get("status") != "done":
                        video["bgmId"] = ""
            persist_state()
        paths_to_remove = [Path(item["path"])]
        if kind == "video" and item.get("output"):
            paths_to_remove.append(OUTPUTS / safe_name(item["output"]))
        for path in paths_to_remove:
            try:
                path.unlink(missing_ok=True)
            except Exception as exc:
                self.send_json({"error": f"已移除记录，但文件未能删除：{exc}"}, 500)
                return
        self.send_json({"ok": True})

    def handle_upload(self, kind, requested_name):
        if kind not in {"video", "bgm"}:
            self.send_json({"error": "未知文件类型"}, 400)
            return
        path = None
        try:
            filename = safe_name(requested_name)
            allowed = VIDEO_EXTENSIONS if kind == "video" else AUDIO_EXTENSIONS
            if Path(filename).suffix.lower() not in allowed:
                raise ValueError("文件格式不受支持")
            remaining = int(self.headers.get("Content-Length", 0))
            if remaining <= 0:
                raise ValueError("文件内容为空")
            item_id = uuid.uuid4().hex
            directory = INPUTS / kind
            directory.mkdir(parents=True, exist_ok=True)
            path = unique_path(directory, f"{item_id}_{filename}")
            with path.open("wb") as target:
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("上传被中断，请重新上传")
                    target.write(chunk)
                    remaining -= len(chunk)
            with state_lock:
                if kind == "bgm":
                    state["bgms"][item_id] = {"id": item_id, "name": filename, "path": str(path)}
                else:
                    state["videos"][item_id] = {
                        "id": item_id,
                        "name": filename,
                        "path": str(path),
                        "status": "ready",
                        "bgmId": "",
                        "start": 0,
                        "output": "",
                        "error": "",
                        "audioMode": "replace",
                        "originalDb": 0,
                        "bgmDb": -8,
                    }
                persist_state()
            self.send_json({"id": item_id, "name": filename})
        except Exception as exc:
            if path:
                path.unlink(missing_ok=True)
            self.send_json({"error": str(exc)}, 400)


def find_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def acquire_server_lock():
    """Keep a single authoritative in-memory state for this tool folder."""
    handle = SERVER_LOCK.open("a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    handle.seek(0)
    handle.truncate()
    handle.write(str(os.getpid()))
    handle.flush()
    return handle


def save_server_info(url):
    temporary = SERVER_INFO.with_suffix(".tmp")
    temporary.write_text(json.dumps({"pid": os.getpid(), "url": url}), encoding="utf-8")
    temporary.replace(SERVER_INFO)


if __name__ == "__main__":
    if not ENGINE.is_file():
        raise SystemExit("视频处理引擎未准备好，请通过启动 .command 文件运行。")
    server_lock = acquire_server_lock()
    if server_lock is None:
        try:
            info = json.loads(SERVER_INFO.read_text(encoding="utf-8"))
            url = info.get("url")
            if url:
                print(f"工具已在运行：{url}")
                webbrowser.open(url)
        except Exception:
            print("工具已在运行，请关闭旧窗口后再启动。")
        raise SystemExit(0)
    port = find_port()
    url = f"http://127.0.0.1:{port}"
    save_server_info(url)
    print(f"工具已启动：{url}")
    print("关闭此终端窗口即可退出。")
    threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
    finally:
        try:
            SERVER_INFO.unlink(missing_ok=True)
        finally:
            fcntl.flock(server_lock.fileno(), fcntl.LOCK_UN)
            server_lock.close()
