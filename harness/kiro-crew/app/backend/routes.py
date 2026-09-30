"""Owner-guarded, bounded progress reads through the installed project engine.

Observe-only is an application guarantee, not a sandbox: project records are
read-only. A disposable reader HOME and host-managed logs/audit/bytecode may be written.
"""
from __future__ import annotations

import asyncio
import ctypes
import errno
import hashlib
import json
import logging
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from collections import namedtuple
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

MAX_BINDINGS = 1000
MAX_FILE_BYTES = 64 * 1024
MAX_SESSION_BYTES = 4 * 1024 * 1024
MAX_SESSION_ENTRIES = 10000
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_JSON_NODES = 100000
MAX_JSON_DEPTH = 64
MAX_STDOUT = 1024 * 1024
MAX_STDERR = 64 * 1024
READER_TIMEOUT = 10.0
TERM_GRACE = 1.0
POLL_INTERVAL = 0.025
MAX_SPACE = 128
MAX_INTENT = 256
DISCLOSURE = "Observe-only is an application guarantee: this route runs unsandboxed inside the Crew gateway under the App Kit's local-app trust and never writes AIDLC state."

try:
    from kiro_crew.dashboard.handlers.source_providers import is_owner_dashboard_request
    from kiro_crew.apps.route_registry import AppRoute, web
    from kiro_crew.apps.manager import is_app_enabled
    _GUARD_AVAILABLE = True
except ImportError:
    _GUARD_AVAILABLE = False
    # Retain the host's actual route class when only an auth import failed.
    try:
        from kiro_crew.apps.route_registry import AppRoute, web
    except ImportError:
        # Importable fail-closed description even without the host API. A host
        # lacking route_registry cannot mount ANY app; this is not a substitute.
        AppRoute = namedtuple("AppRoute", "method path handler")
        web = SimpleNamespace(json_response=lambda body, status, headers: SimpleNamespace(
            status=status, text=json.dumps(body), headers=headers))


class Failure(Exception):
    def __init__(self, code, status=503, state="unavailable"):
        super().__init__(code)
        self.code, self.status, self.state = code, status, state


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _error(code, status=503, state="unavailable"):
    return status, {"schemaVersion": 1, "state": state, "error": {
        "code": code, "message": code.replace("_", " ").capitalize()},
        "disclosure": DISCLOSURE, "generatedAt": _now()}


def _response(result):
    status, body = result
    return web.json_response(body, status=status, headers={"Cache-Control": "no-store"})


async def _offload(fn, *args):
    """Shield the worker, not the request: cancellation signals then joins it.

    Oracle is asyncio cancellation, observed before spawn and every I/O poll.
    No response/cancellation escapes with an owned worker still running. Repeated
    cancellation cannot detach cleanup. No disable switch; thread I/O itself is
    not preemptible (bounded regular local files only, not a remote-FS deadline).
    """
    cancelled = threading.Event()
    worker = asyncio.create_task(asyncio.to_thread(fn, *args, cancelled))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        cancelled.set()
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                continue
        # Retrieve exceptions even when the HTTP consumer has disappeared.
        worker.result()
        raise


def _owner_cookie_request(request):
    """Admission oracle: Crew's validated identity/provenance, not cookie presence.

    Read before any session state or execution on every request. All five
    middleware fields must be present/non-None; only literal dashboard True and
    query-token False plus the live owner predicate admit. Missing evidence or
    non-owner => audited 403 via _guarded; predicate failure => 503. No bypass.
    The SDK header remains host-UI attribution, NOT server attestation.
    """
    return all(request.get(k) is not None for k in (
        "user", "app", "auth_token", "is_dashboard_user", "auth_from_query_token")) and (
        request.get("is_dashboard_user") is True and
        request.get("auth_from_query_token") is False and is_owner_dashboard_request(request))


def _guarded(handler, *, owner_cookie=False):
    """Admission oracle: imports, live Crew enabled state, then owner predicate.

    Checked on EVERY request before data reads/spawn; missing imports or a
    failing predicate => 503, disabled/non-owner => audited 403. No config or
    environment bypass. Enabled-state I/O and logger I/O stay off the loop.
    """
    async def wrapped(request, ctx):
        if not _GUARD_AVAILABLE:
            return _response(_error("GUARD_UNAVAILABLE"))
        try:
            enabled = await asyncio.to_thread(is_app_enabled, ctx.name)
            allowed = enabled and (_owner_cookie_request(request) if owner_cookie else
                                   is_owner_dashboard_request(request))
        except Exception:
            return _response(_error("GUARD_UNAVAILABLE"))
        if not allowed:
            await asyncio.to_thread(ctx.logger.warning,
                                    "aidlc progress access denied: %s",
                                    "non-owner" if enabled else "app-disabled")
            return _response(_error("FORBIDDEN", 403, "error"))
        return _response(await _offload(handler, request, ctx))
    return wrapped


def register_routes(ctx) -> list[AppRoute]:
    """Enable INFO on Crew's mutable app-owned logger before serving requests.

    Crew supplies kirocrew.app.aidlc, otherwise inheriting root WARNING.
    Only this child level changes; host levels, handlers and propagation stay
    untouched. Host handler filters can still suppress INFO (notably detached
    default logging); the optional audit SDK is the independent diagnostic sink.
    """
    ctx.logger.setLevel(logging.INFO)
    return [AppRoute("GET", "/projects", _guarded(_projects)),
            AppRoute("GET", "/progress", _guarded(_progress)),
            AppRoute("GET", "/session-progress", _guarded(_session_progress, owner_cookie=True))]


def _same(a, b):
    return (a.st_dev, a.st_ino, a.st_mode, a.st_size, a.st_mtime_ns, a.st_ctime_ns) == (
        b.st_dev, b.st_ino, b.st_mode, b.st_size, b.st_mtime_ns, b.st_ctime_ns)


@contextmanager
def _directory(path):
    """No-follow descriptor walk from an already canonical absolute root.

    Oracle: each opened component is O_DIRECTORY|O_NOFOLLOW, before any read.
    A replaced component/link/special file fails closed; no traversal bypass.
    Project root aliases are canonicalized once for deduplication, but no
    links below the root are accepted, including internal stamp/engine links.
    """
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise Failure("UNSAFE_PATH")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def _json(raw):
    def invalid_constant(value):
        raise ValueError("non-JSON number")
    return json.loads(raw, object_pairs_hook=_pairs, parse_constant=invalid_constant)


class Reader:
    """Budget oracle is bytes actually read plus decoded JSON nodes, per call.

    Checks precede parsing/consumption; stat+descriptor checks bracket each read.
    Exhaustion never yields a truncated success. Bad individual bindings alone
    may be skipped with a counted warning; global budgets always stop the call.
    No configurable disabling conditions. This is a bounded snapshot, not a lock.
    """
    def __init__(self, cancelled):
        self.bytes = self.nodes = 0
        self.cancelled = cancelled

    def checkpoint(self):
        if self.cancelled.is_set():
            raise Failure("READER_CANCELLED")

    def read(self, path, maximum=MAX_FILE_BYTES):
        self.checkpoint()
        path = Path(path)
        with _directory(path.parent) as parent:
            before = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(before.st_mode):
                raise Failure("UNSAFE_FILE_KIND")
            if before.st_size > maximum or self.bytes + before.st_size > MAX_TOTAL_BYTES:
                raise Failure("LIMIT_EXCEEDED")
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                if not _same(before, os.fstat(fd)):
                    raise Failure("SOURCE_CHANGED")
                chunks, count = [], 0
                while count <= before.st_size:
                    self.checkpoint()
                    chunk = os.read(fd, min(65536, before.st_size + 1 - count))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    count += len(chunk)
                self.bytes += count
                if self.bytes > MAX_TOTAL_BYTES:
                    raise Failure("LIMIT_EXCEEDED")
                if count != before.st_size or not _same(before, os.fstat(fd)) or not _same(
                        before, os.stat(path.name, dir_fd=parent, follow_symlinks=False)):
                    raise Failure("SOURCE_CHANGED")
                return b"".join(chunks).decode("utf-8", errors="strict")
            finally:
                os.close(fd)

    def document(self, path, maximum=MAX_FILE_BYTES):
        value = _json(self.read(path, maximum))
        pending = [(value, 0)]
        while pending:
            item, depth = pending.pop()
            self.nodes += 1
            if self.nodes > MAX_JSON_NODES or depth > MAX_JSON_DEPTH:
                raise Failure("LIMIT_EXCEEDED")
            if isinstance(item, dict):
                pending.extend((v, depth + 1) for v in item.values())
            elif isinstance(item, list):
                pending.extend((v, depth + 1) for v in item)
        if not isinstance(value, dict):
            raise ValueError("expected object")
        return value


def _timestamp(value):
    if not isinstance(value, str) or not re.match(r"^\d{4}-\d\d-\d\dT", value):
        raise ValueError("invalid timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp requires timezone")
    return parsed.timestamp()


def project_id(project):
    return hashlib.sha256(("aidlc-progress:" + str(project)).encode("utf-8")).hexdigest()[:16]


def _receipt(reader, data_dir):
    """Receipt oracle: own app root + crewHome relationship and setup's v1 shape.

    Read before provider join/spawn, no PATH fallback. Invalid/missing receipt
    stops the call. This checks installation self-consistency, not authenticity
    of a user-replaceable Bun/engine; existing local-app trust remains required.
    """
    root = data_dir.parent
    try:
        value = reader.document(root / ".aidlc-materialized.json")
        if type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1:
            raise ValueError("version")
        _timestamp(value.get("materializedAt"))
        digest = lambda v: isinstance(v, str) and re.fullmatch(r"[a-f0-9]{64}", v)
        if not digest(value.get("portableInventorySelfHash")):
            raise ValueError("inventory")
        for field in ("bun", "appRoot", "crewHome"):
            if not isinstance(value.get(field), str) or not Path(value[field]).is_absolute():
                raise ValueError("path")
        if Path(value["appRoot"]).resolve(strict=True) != root or (
                Path(value["crewHome"]).resolve(strict=True) / "apps" / "aidlc") != root:
            raise ValueError("installation paths")
        files = value.get("files")
        if not isinstance(files, dict) or set(files) != {"app.json", "mcp.fragment.json"}:
            raise ValueError("files")
        for item in files.values():
            if not isinstance(item, dict) or not all(digest(item.get(k)) for k in (
                    "portableSha256", "materializedSha256")):
                raise ValueError("hashes")
        if not stat.S_ISREG(os.stat(value["bun"]).st_mode) or not os.access(value["bun"], os.X_OK):
            raise ValueError("executable")
        return value
    except Failure:
        raise
    except (OSError, ValueError, RecursionError):
        raise Failure("MATERIALIZATION_INVALID") from None


def _stamp_valid(reader, project):
    """Project installation stamp: the launcher's four flat tokens, not a version pin.

    Read before discovery display and again before spawning. Missing, malformed
    or unsafe stamps refuse progress (409); budget exhaustion stays unavailable.
    No bypass. Unlike the hook entry, links are refused for bounded observation.
    """
    try:
        raw = reader.read(Path(project) / ".kiro-crew/tools/data/aidlc-stamp.json")
        if "\\" in raw:
            return False
        compact, quoted = "", False
        for line in raw.split("\n"):
            for char in line:
                if char == '"':
                    quoted = not quoted
                elif not quoted and char in " \t\r\v\f":
                    continue
                compact += char
            if quoted:
                return False
        if not compact.startswith("{") or not compact.endswith("}"):
            return False
        tokens = compact[1:-1].split(",")
        if len(tokens) != 4 or not all(re.fullmatch(r'"[^" ]+":(1|"[^" ]*")', t) for t in tokens):
            return False
        value = _json(compact)
        return set(value) == {"schemaVersion", "distribution", "harnessDir", "frameworkVersion"} and (
            type(value["schemaVersion"]) is int and value["schemaVersion"] == 1 and
            value["distribution"] == "kiro-crew" and value["harnessDir"] == ".kiro-crew" and
            isinstance(value["frameworkVersion"], str) and
            re.fullmatch(r"[0-9a-z.-]+", value["frameworkVersion"]) is not None)
    except Failure as exc:
        if exc.code in {"LIMIT_EXCEEDED", "READER_CANCELLED"}:
            raise
        return False
    except (OSError, ValueError, RecursionError):
        return False


def _bindings(reader, data_dir):
    records, corrupt = {}, 0
    try:
        with _directory(data_dir / "bindings") as fd:
            before = os.fstat(fd)
            with os.scandir(fd) as entries:
                names = []
                for entry in entries:
                    reader.checkpoint()
                    if len(names) >= MAX_BINDINGS:
                        raise Failure("LIMIT_EXCEEDED")
                    names.append(entry.name)
            for filename in sorted(names):
                if not re.fullmatch(r"[a-f0-9]{64}\.json", filename):
                    corrupt += 1
                    continue
                try:
                    value = reader.document(data_dir / "bindings" / filename)
                    raw = value.get("projectDir")
                    if not isinstance(raw, str) or not Path(raw).is_absolute():
                        raise ValueError("project path")
                    project = Path(raw).resolve(strict=True)
                    with _directory(project):
                        pass
                    stamp = _timestamp(value.get("boundAt"))
                    record = records.get(str(project))
                    key = filename[:-5]
                    if record is None:
                        records[str(project)] = {"project": str(project), "boundAt": value["boundAt"],
                                                 "time": stamp, "keys": [key]}
                    else:
                        record["keys"].append(key)
                        if stamp > record["time"]:
                            record.update(boundAt=value["boundAt"], time=stamp)
                except Failure as exc:
                    if exc.code in {"LIMIT_EXCEEDED", "READER_CANCELLED"}:
                        raise
                    corrupt += 1
                except (OSError, ValueError, RecursionError):
                    corrupt += 1
            if not _same(before, os.fstat(fd)):
                raise Failure("SOURCE_CHANGED")
    except FileNotFoundError:
        return {}, []
    projects = {}
    for record in sorted(records.values(), key=lambda r: (-r["time"], r["project"])):
        identifier = project_id(record["project"])
        if identifier in projects:
            raise Failure("PROJECT_ID_COLLISION")
        projects[identifier] = record
    warnings = [{"code": "CORRUPT_BINDINGS", "count": corrupt}] if corrupt else []
    return projects, warnings


def _providers(reader, receipt, projects):
    """Provider oracle: current session_map raw-key SHA256 joins binding filenames.

    Read on each request; no provider guessing from titles/config/binding labels.
    Missing map => unknown; malformed/unsafe/over-budget present map fails closed.
    Project responses expose label/source/conflict. Mixed labels => unknown+conflict;
    one observation => that label (including codex), never execution admission.
    Missing entries count as unknown; no bypass and neither record is modified.
    Return the same bounded join so the session caller can report exact-key
    presence, including unknown-valued entries, without a second map read.
    Project callers retain their aggregate label/source/conflict contract.
    """
    try:
        mapping = reader.document(Path(receipt["crewHome"]).resolve(strict=True) / "session_map.json",
                                  MAX_SESSION_BYTES)
    except FileNotFoundError:
        mapping = {}
    if len(mapping) > MAX_SESSION_ENTRIES:
        raise Failure("LIMIT_EXCEEDED")
    labels = {"acp": "kiro", "kiro": "kiro", "kas": "kiro", "claude_code": "claude", "codex": "codex"}
    wanted = {key for record in projects.values() for key in record["keys"]}
    joined = {}
    for raw_key, entry in mapping.items():
        reader.checkpoint()
        key = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()
        if key in wanted:
            provider = entry.get("provider") if isinstance(entry, dict) else None
            joined[key] = labels.get(provider, "unknown") if isinstance(provider, str) else "unknown"
    for record in projects.values():
        observed = {joined.get(key, "unknown") for key in record["keys"]}
        record["provider"] = {"label": next(iter(observed)) if len(observed) == 1 else "unknown",
                              "source": "crew-session-map", "conflict": len(observed) > 1}
    return joined


def _selection(query):
    duplicates = hasattr(query, "getall") and any(len(query.getall(k)) != 1 for k in query)
    if set(query) - {"project", "space", "intent"} or duplicates:
        raise Failure("INVALID_QUERY", 400, "error")
    project, space, intent = (query.get(k) for k in ("project", "space", "intent"))
    if not isinstance(project, str) or not re.fullmatch(r"[a-f0-9]{16}", project):
        raise Failure("INVALID_QUERY", 400, "error")
    for value, maximum, pattern in ((space, MAX_SPACE, r"[A-Za-z0-9][A-Za-z0-9._-]*"),
                                     (intent, MAX_INTENT, r"[A-Za-z0-9][A-Za-z0-9_.:-]*")):
        if value is not None and (not isinstance(value, str) or len(value) > maximum or not re.fullmatch(pattern, value)):
            raise Failure("INVALID_QUERY", 400, "error")
    if intent is not None and space is None:
        raise Failure("INVALID_QUERY", 400, "error")
    return project, space, intent


def build_argv(bun, project, space=None, intent=None):
    return [bun, f"{project}/.kiro-crew/tools/aidlc.ts", "engine", "progress", "--json", "--project-dir", project,
            *(["--space", space] if space else []), *(["--intent", intent] if intent else [])]


def _environment(bun, home):
    return {"PATH": str(Path(bun).parent), "HOME": home,
            "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}


class _DarwinKinfoProc(ctypes.Structure):
    # Darwin LP64 sys/sysctl.h + sys/proc.h: sizeof(kinfo_proc) = 648,
    # extern_proc.p_stat at 36 and p_pid at 40; unconsumed fields stay opaque.
    _fields_ = [("_prefix", ctypes.c_byte * 36), ("p_stat", ctypes.c_int8),
                ("_padding", ctypes.c_byte * 3), ("p_pid", ctypes.c_int32),
                ("_suffix", ctypes.c_byte * 604)]


def _darwin_group_members(pgid):
    """Read-only sysctl oracle; at most two calls and 4,096 kinfo_proc records.

    Queried only after EPERM, before reaping the retained leader. Darwin LP64
    layout and BOTH returned byte lengths must agree with the 648-byte record;
    overflow, growth beyond capacity, malformed records or any syscall/ABI
    failure return None, never a partial census. No environment/config bypass.
    The consumer must treat None as unverified, not as an empty/exited group.
    """
    if (sys.platform != "darwin" or sys.byteorder != "little" or
            ctypes.sizeof(ctypes.c_void_p) != 8 or ctypes.sizeof(ctypes.c_long) != 8 or
            not 0 < pgid <= 0x7fffffff):
        return None
    try:
        record_size = ctypes.sizeof(_DarwinKinfoProc)
        if record_size != 648:
            return None
        sysctl = ctypes.CDLL(None, use_errno=True).sysctl
        sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p,
                          ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
        sysctl.restype = ctypes.c_int
        mib = (ctypes.c_int * 4)(1, 14, 2, pgid)  # CTL_KERN, KERN_PROC, KERN_PROC_PGRP
        size = ctypes.c_size_t(0)
        maximum = 4096 * record_size
        if sysctl(mib, 4, None, ctypes.byref(size), None, 0) != 0:
            return None
        if size.value > maximum or size.value % record_size:
            return None
        capacity = min(4096, size.value // record_size + 16)
        records = (_DarwinKinfoProc * capacity)()
        size.value = ctypes.sizeof(records)
        if sysctl(mib, 4, records, ctypes.byref(size), None, 0) != 0:
            return None
        if size.value > ctypes.sizeof(records) or size.value % record_size:
            return None
        members = [(r.p_pid, r.p_stat) for r in records[:size.value // record_size]]
        if any(pid <= 0 or state not in range(1, 7) for pid, state in members):
            return None
        return members
    except Exception:
        return None


def _group_only_zombies(pgid):
    """Require the retained leader AND every enumerated member to be SZOMB.

    Oracle is the bounded kernel census, read after exit observation and before
    wait(); missing leader/any live member is False, unreadable census is None.
    Only literal True permits EPERM acceptance; no disabling condition/bypass.
    """
    members = _darwin_group_members(pgid)
    if members is None:
        return None
    return any(pid == pgid for pid, _ in members) and all(state == 5 for _, state in members)


def _signal_group(pid, sig):
    """Signal the owned group; only proven Darwin zombie-only EPERM means done.

    Check errno/platform, WNOWAIT exit, then the kernel group census AFTER the
    failed signal and BEFORE wait. Unknown/failed proof re-raises the original
    permission error. No permission bypass on another platform or a live group.
    """
    try:
        os.killpg(pid, sig)
        return True
    except ProcessLookupError:
        return False
    except PermissionError as exc:
        if exc.errno == errno.EPERM and sys.platform == "darwin":
            try:
                if _exited_unreaped(pid) and _group_only_zombies(pid) is True:
                    return False
            except Exception:
                pass  # Unverifiable exit/census must not replace the original EPERM.
        raise


def _cleanup(process):
    """Own the session/process group until TERM, grace, KILL and parent wait.

    Oracle is Popen(start_new_session=True)'s pid, captured before polling. Used
    even on success to remove pipe-closing descendants. Keep the leader unreaped
    until the last group signal so its pid cannot be reused. Descendants inherit
    the group; their parent/OS reaps them, wait() reaps our direct child. Not a
    sandbox for an executable deliberately escaping via setsid; no such worker
    is spawned by the trusted progress reader. No cleanup disabling conditions.
    A failed signal never skips wait or either pipe close; retain the first
    cleanup error and its phase. _run_reader preserves an earlier reader error.
    """
    first_error = None
    phase = "term"
    try:
        if _signal_group(process.pid, signal.SIGTERM):
            phase = "grace"
            deadline = time.monotonic() + TERM_GRACE
            while time.monotonic() < deadline:
                if not _signal_group(process.pid, 0):
                    break
                time.sleep(POLL_INTERVAL)
            phase = "kill"
            _signal_group(process.pid, signal.SIGKILL)
    except BaseException as exc:
        exc.reader_lifecycle = {"pid": process.pid, "pgid": process.pid, "phase": phase}
        first_error = exc
    finally:
        for phase, finish in (("wait", process.wait), ("close-stdout", process.stdout.close),
                              ("close-stderr", process.stderr.close)):
            try:
                finish()
            except BaseException as exc:
                if first_error is None:
                    exc.reader_lifecycle = {"pid": process.pid, "pgid": process.pid, "phase": phase}
                    first_error = exc
    if first_error is not None:
        raise first_error


def _exited_unreaped(pid):
    """POSIX exit observation without releasing the group leader's identity.

    CPython 3.12 on macOS omits os.waitid; libc still exports POSIX waitid.
    On Darwin arm64 LP64, sys/signal.h defines siginfo_t as 104 bytes, with
    si_pid the fourth 32-bit field. A zeroed, long-aligned 1 KiB buffer covers
    it. WNOHANG leaves si_pid zero without an event; only our pid means exited.
    Never reap until the last group signal. Unsupported ABI/syscall failure
    stops and cleans up rather than guessing at process identity.
    """
    options = os.WEXITED | os.WNOHANG | os.WNOWAIT
    if hasattr(os, "waitid"):
        return os.waitid(os.P_PID, pid, options) is not None
    if sys.platform != "darwin":
        raise Failure("READER_START_FAILED", 502)
    info = (ctypes.c_long * 128)()
    waitid = ctypes.CDLL(None, use_errno=True).waitid
    waitid.argtypes = [ctypes.c_int, ctypes.c_uint, ctypes.c_void_p, ctypes.c_int]
    waitid.restype = ctypes.c_int
    if waitid(os.P_PID, pid, ctypes.byref(info), options) != 0:
        raise OSError(ctypes.get_errno(), "waitid failed")
    return ctypes.cast(info, ctypes.POINTER(ctypes.c_int))[3] == pid


def _run_reader(argv, project, cancelled, *, deadline=None):
    """Concurrent nonblocking pipe reads: limits apply before JSON decoding.

    Monotonic deadline starts before Popen; both streams have independent caps.
    Timeout/overflow/cancellation first exits the poll, then ALWAYS cleans the
    process group before returning. No communicate() buffering or shell, no
    fallback command. Cancellation is also checked immediately before spawn.
    """
    with tempfile.TemporaryDirectory(prefix="aidlc-progress-", dir="/tmp") as home:
        if cancelled.is_set():
            raise Failure("READER_CANCELLED")
        deadline = min(time.monotonic() + READER_TIMEOUT, deadline) if deadline is not None else time.monotonic() + READER_TIMEOUT
        if time.monotonic() >= deadline:
            raise Failure("READER_TIMEOUT", 504)
        try:
            process = subprocess.Popen(argv, cwd=project, env=_environment(argv[0], home),
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, shell=False, start_new_session=True)
        except OSError:
            raise Failure("READER_START_FAILED", 502) from None
        output = {"stdout": bytearray(), "stderr": bytearray()}
        reader_error = None
        try:
            with selectors.DefaultSelector() as selector:
                for stream, name, cap in ((process.stdout, "stdout", MAX_STDOUT),
                                           (process.stderr, "stderr", MAX_STDERR)):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ, (name, cap))
                # Do not poll()/wait() and release the group leader's pid yet.
                while selector.get_map():
                    if cancelled.is_set():
                        raise Failure("READER_CANCELLED")
                    if time.monotonic() >= deadline:
                        raise Failure("READER_TIMEOUT", 504)
                    for key, _ in selector.select(POLL_INTERVAL):
                        name, cap = key.data
                        chunk = os.read(key.fileobj.fileno(), min(65536, cap + 1 - len(output[name])))
                        if not chunk:
                            selector.unregister(key.fileobj)
                        else:
                            output[name].extend(chunk)
                            if len(output[name]) > cap:
                                raise Failure("READER_OUTPUT_OVERFLOW", 502)
                # Pipes can close before the leader exits; keep ownership.
                while not _exited_unreaped(process.pid):
                    if cancelled.is_set():
                        raise Failure("READER_CANCELLED")
                    if time.monotonic() >= deadline:
                        raise Failure("READER_TIMEOUT", 504)
                    time.sleep(POLL_INTERVAL)
        except BaseException as exc:
            exc.reader_lifecycle = {"pid": process.pid, "pgid": process.pid, "phase": "read"}
            reader_error = exc
            raise
        finally:
            try:
                _cleanup(process)
            except BaseException:
                if reader_error is None:
                    raise
        try:
            body = _json(output["stdout"].decode("utf-8", errors="strict"))
            if not isinstance(body, dict) or type(body.get("schemaVersion")) is not int or body["schemaVersion"] != 1:
                raise ValueError("schema")
            state = body.get("state")
            if not isinstance(state, str) or state not in {"ok", "empty", "selection-required", "unavailable", "error"}:
                raise ValueError("state")
            if state in {"ok", "empty", "selection-required"} and (
                    not isinstance(body.get("project"), dict) or not isinstance(body.get("intents"), list)):
                raise ValueError("reader envelope")
            if (state == "ok" and not isinstance(body.get("selected"), dict)) or (
                    state != "ok" and "selected" in body):
                raise ValueError("selection envelope")
            if (process.returncode != 0 or state in {"unavailable", "error"}) and (
                    state not in {"unavailable", "error"} or not isinstance(body.get("error"), dict) or
                    not isinstance(body["error"].get("code"), str)):
                raise ValueError("error envelope")
            return (502 if process.returncode != 0 or state in {"unavailable", "error"} else 200), body
        except (ValueError, RecursionError):
            raise Failure("READER_MALFORMED", 502) from None


def _serve(fn):
    def wrapped(request, ctx, cancelled):
        try:
            return fn(request, ctx, Reader(cancelled))
        except Failure as exc:
            return _error(exc.code, exc.status, exc.state)
        except OSError as exc:
            lifecycle = getattr(exc, "reader_lifecycle", {})
            ctx.logger.error("aidlc progress site=%s exception=%s errno=%r strerror=%r filename=%r pid=%r pgid=%r phase=%s",
                             fn.__name__, type(exc).__name__, exc.errno, exc.strerror, exc.filename,
                             lifecycle.get("pid"), lifecycle.get("pgid"), lifecycle.get("phase", "source"))
            return _error("UNSAFE_FILE_KIND" if exc.errno in {errno.ELOOP, errno.ENOTDIR} else "SOURCE_UNREADABLE")
        except (ValueError, RecursionError):
            return _error("SOURCE_MALFORMED")
    return wrapped


@_serve
def _projects(request, ctx, reader):
    if request.query:
        raise Failure("INVALID_QUERY", 400, "error")
    data_dir = Path(ctx.data_dir).resolve(strict=True)
    projects, warnings = _bindings(reader, data_dir)
    if projects:
        _providers(reader, _receipt(reader, data_dir), projects)
    entries = [{"id": identifier, "displayName": Path(record["project"]).name,
                "boundAt": record["boundAt"], "stampValid": _stamp_valid(reader, record["project"]),
                "providerLabel": record["provider"]["label"]} for identifier, record in projects.items()]
    return 200, {"schemaVersion": 1, "projects": entries, "warnings": warnings, "disclosure": DISCLOSURE}


@_serve
def _progress(request, ctx, reader):
    identifier, space, intent = _selection(request.query)
    data_dir = Path(ctx.data_dir).resolve(strict=True)
    projects, _ = _bindings(reader, data_dir)
    record = projects.get(identifier)
    if record is None:
        raise Failure("UNKNOWN_PROJECT", 404, "error")
    project = record["project"]
    if not _stamp_valid(reader, project):
        raise Failure("INVALID_STAMP", 409, "unavailable")
    receipt = _receipt(reader, data_dir)
    _providers(reader, receipt, projects)
    # Bound, no-follow engine-kind check; never import/execute an alternate path.
    with _directory(Path(project) / ".kiro-crew/tools") as fd:
        if not stat.S_ISREG(os.stat("aidlc.ts", dir_fd=fd, follow_symlinks=False).st_mode):
            raise Failure("UNSAFE_FILE_KIND")
    status, body = _run_reader(build_argv(receipt["bun"], project, space, intent), project, reader.cancelled)
    return status, {**body, "provider": record["provider"], "disclosure": DISCLOSURE, "generatedAt": _now()}


UNBOUND_GUIDANCE = "Bind this conversation first: in this chat, message aidlc-crew (its first call, aidlc_status, binds the conversation) — or run the operator bind procedure from the guide."


def _session_json(reader, raw):
    # Same duplicate-key/depth/node oracle as Reader.document, also for arrays
    # and already-read binding bytes (the revision must hash the parsed bytes).
    value = _json(raw)
    pending = [(value, 0)]
    while pending:
        item, depth = pending.pop()
        reader.nodes += 1
        if reader.nodes > MAX_JSON_NODES or depth > MAX_JSON_DEPTH:
            raise Failure("LIMIT_EXCEEDED")
        if isinstance(item, dict):
            pending.extend((v, depth + 1) for v in item.values())
        elif isinstance(item, list):
            pending.extend((v, depth + 1) for v in item)
    return value


def _optional_binding(reader, path):
    try:
        return reader.read(path)
    except FileNotFoundError:
        return None


def _binding_revision(app, engine):
    return hashlib.sha256(((app or "") + (engine or "") + "\n").encode("utf-8")).hexdigest()[:16]


class _BindingChanged(Exception):
    def __init__(self, revision):
        self.revision = revision


def _revalidate_session(reader, snapshot):
    """Binding oracle: exact app/engine bytes at the originally resolved paths.

    Both bounded no-follow reads precede spawn and follow EACH reader return
    (including failure). Changed/removed bytes => 200 BINDING_CHANGED without
    selected; unreadable/unsafe bytes => 503. No fallback or disable switch.
    Sequential reads are not a lock: ABA and changes after the last read are
    unobservable. The revision describes this pair, not real-time notification.
    """
    app_path, engine_path, app, engine = snapshot
    current_app = _optional_binding(reader, app_path)
    current_engine = _optional_binding(reader, engine_path)
    if (app, engine) != (current_app, current_engine):
        raise _BindingChanged(_binding_revision(current_app, current_engine))


def _session_registry_id(reader, project, space, intent):
    """Intent oracle: aidlc-progress.ts census row-to-directory rule, not a slug guess.

    Read registry + bounded direct directory census before spawning; explicit
    dirName wins, otherwise slug prefix + lowercase hex suffix + UUID (hyphens
    removed) endsWith. Duplicate claims/multiple dirs => AMBIGUOUS_INTENT, bad
    rows => SOURCE_MALFORMED. Reader census later corroborates UUID/slug and
    eligibility; the join and registry byte digest are checked again after each
    invocation so registry retargeting cannot reuse the pre-spawn identity.
    Registry-only is census; absent/orphan/ineligible is refusal.
    No auto-selection or bypass. Only this intent directory is enumerated;
    app/engine bindings are always exact reads. No state mutation.
    """
    base = Path(project) / "aidlc/spaces" / space / "intents"
    dirs = []
    try:
        with _directory(base) as fd:
            before = os.fstat(fd)
            with os.scandir(fd) as entries:
                for index, entry in enumerate(entries):
                    reader.checkpoint()
                    if index >= 2000:
                        raise Failure("LIMIT_EXCEEDED")
                    mode = os.stat(entry.name, dir_fd=fd, follow_symlinks=False).st_mode
                    if stat.S_ISDIR(mode):
                        dirs.append(entry.name)
                    elif not stat.S_ISREG(mode):
                        raise Failure("UNSAFE_FILE_KIND")
            if not _same(before, os.fstat(fd)):
                raise Failure("SOURCE_CHANGED")
    except FileNotFoundError:
        pass
    raw = _optional_binding(reader, base / "intents.json")
    rows = [] if raw is None else _session_json(reader, raw)
    if not isinstance(rows, list):
        raise ValueError("registry must be an array")
    if len(rows) > 500:
        raise Failure("LIMIT_EXCEEDED")
    safe = lambda v: isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", v)
    ids, claimed, targets = set(), set(), []
    for row in rows:
        if (not isinstance(row, dict) or not safe(row.get("uuid")) or not safe(row.get("slug")) or
                not isinstance(row.get("status"), str) or not row["status"].strip() or "\0" in row["status"] or
                ("dirName" in row and not safe(row["dirName"]))):
            raise ValueError("invalid registry row")
        if row["uuid"] in ids:
            raise Failure("AMBIGUOUS_INTENT")
        ids.add(row["uuid"])

        def matches(directory):
            if row.get("dirName"):
                return row["dirName"] == directory
            suffix = directory[len(row["slug"]) + 1:]
            return (directory.startswith(row["slug"] + "-") and
                    re.fullmatch(r"[0-9a-f]+", suffix) is not None and
                    row["uuid"].replace("-", "").endswith(suffix))

        found = [d for d in dirs if matches(d)]
        if len(found) > 1 or (found and found[0] in claimed):
            raise Failure("AMBIGUOUS_INTENT")
        claimed.update(found)
        if matches(intent):
            targets.append((row["uuid"], row["slug"]))
    if len(targets) > 1:
        raise Failure("AMBIGUOUS_INTENT")
    if not targets:
        raise Failure("STALE_BINDING")
    return (*targets[0], hashlib.sha256((raw or "").encode("utf-8")).hexdigest())


def _session_payload(state, **fields):
    return {"schemaVersion": 1, "state": state, "generatedAt": _now(),
            **fields, "disclosure": DISCLOSURE}


def _session_diagnostic(handler):
    """Correlation oracle: guarded host header and final converted response tuple.

    Runs only inside _guarded's owner-cookie admission, on its worker thread.
    After conversion, before serialization, attach only the SHA256 first eight
    as conversationRef for a valid conversation header, including refusals.
    Missing/malformed and routed-page headers get no body reference; guard
    refusals never enter here. No extra read or bypass. This guessable, collision-
    prone correlation aid never selects or authenticates a binding. Raw keys and
    full hashes are never included in the diagnostic or response metadata.
    Missing/malformed headers use '-', otherwise only the SHA256 first eight.
    Presence is response provider.present or '-'; no extra state read or bypass.
    Registration enables app INFO, but host filters/disabled logging may suppress
    it. Optional ctx.audit records the same redacted completion independently of
    verbosity; absent SDK skips that copy, and the SDK's best-effort sink failures
    do not change the response.
    """
    def wrapped(request, ctx, cancelled):
        status, body = handler(request, ctx, cancelled)
        key = request.headers.get("X-Session-Key")
        key_sha256 = hashlib.sha256(key.encode("utf-8")).hexdigest() if (
            isinstance(key, str) and re.fullmatch(r"dashboard:[A-Za-z0-9._:-]{1,128}", key)) else "-"
        if key_sha256 != "-" and key != "dashboard:ui":
            body = {**body, "conversationRef": key_sha256[:8]}
        ctx.logger.info("aidlc session-progress key=%s state=%s present=%s status=%d",
                        key_sha256[:8], body["state"], body.get("provider", {}).get("present") or "-", status)
        audit = getattr(ctx, "audit", None)
        if audit is not None:
            audit.record("session-progress", body["state"], resources=(
                "key=%s state=%s present=%s status=%d" % (
                    key_sha256[:8], body["state"], body.get("provider", {}).get("present") or "-", status)))
        return status, body
    return wrapped


@_session_diagnostic
@_serve
def _session_progress(request, ctx, reader):
    try:
        return _session_progress_read(request, ctx, reader)
    except _BindingChanged as exc:
        ctx.logger.warning("aidlc session progress unavailable: BINDING_CHANGED")
        status, body = _error("BINDING_CHANGED", 200)
        return status, {**body, "bindingRevision": exc.revision}
    except OSError as exc:
        # Redact the requesting identity BEFORE _serve logs string fields: exact
        # binding filenames contain its full hash. Keep unrelated diagnostics and
        # errno/lifecycle unchanged; page callers never enter this branch.
        key = request.headers.get("X-Session-Key")
        if isinstance(key, str) and key:
            digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
            for field in ("strerror", "filename"):
                value = getattr(exc, field, None)
                if isinstance(value, str):
                    setattr(exc, field, value.replace(digest, "[session-hash]").replace(key, "[session-key]"))
        raise
    except (Failure, ValueError, RecursionError) as exc:
        # _serve already logs OSError with site/errno/lifecycle. This route also
        # logs sanitized validation/reader failures before the same converter.
        ctx.logger.error("aidlc progress site=%s exception=%s code=%s phase=%s",
                         "_session_progress", type(exc).__name__,
                         exc.code if isinstance(exc, Failure) else "SOURCE_MALFORMED", "session-read")
        raise


def _session_progress_read(request, ctx, reader):
    if request.query:
        raise Failure("INVALID_QUERY", 400, "error")
    key = request.headers.get("X-Session-Key")
    if not isinstance(key, str) or not re.fullmatch(r"dashboard:[A-Za-z0-9._:-]{1,128}", key):
        raise Failure("MISSING_SESSION", 400, "error")
    if key == "dashboard:ui":
        raise Failure("NOT_A_CONVERSATION", 409)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    data_dir = Path(ctx.data_dir).resolve(strict=True)
    app_path = data_dir / "bindings" / (digest + ".json")
    app_raw = _optional_binding(reader, app_path)
    if app_raw is None:
        # Crew's open_slots.json contains keys/ts only, no link marker.
        # Do not infer linkage from key spelling or read/enumerate transcripts.
        return 200, _session_payload("unbound", guidance=UNBOUND_GUIDANCE)
    app = _session_json(reader, app_raw)
    if not isinstance(app, dict) or not isinstance(app.get("projectDir"), str) or not Path(app["projectDir"]).is_absolute():
        raise ValueError("invalid app binding")
    project = Path(app["projectDir"]).resolve(strict=True)
    with _directory(project):
        pass
    if not _stamp_valid(reader, project):
        raise Failure("INVALID_STAMP", 409)
    engine_path = project / "aidlc/.aidlc-sessions" / ("crew-" + digest + ".binding.json")
    engine_raw = _optional_binding(reader, engine_path)
    space = intent = None
    if engine_raw is not None:
        engine = _session_json(reader, engine_raw)
        if (not isinstance(engine, dict) or not isinstance(engine.get("space"), str) or
                len(engine["space"]) > MAX_SPACE or not re.fullmatch(r"[a-z][a-z0-9-]*", engine["space"]) or
                "intent" not in engine or (engine["intent"] is not None and (
                    not isinstance(engine["intent"], str) or len(engine["intent"]) > MAX_INTENT or
                    not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", engine["intent"]))) or
                not isinstance(engine.get("boundAt"), str) or not engine["boundAt"]):
            raise ValueError("invalid engine binding")
        _timestamp(engine["boundAt"])
        if (("backend" in engine and engine["backend"] not in ("kiro", "claude", "unknown", "codex", "blocked")) or
                ("backendConflict" in engine and type(engine["backendConflict"]) is not bool)):
            raise ValueError("invalid recorded backend")
        space, intent = engine["space"], engine["intent"]
    snapshot = (app_path, engine_path, app_raw, engine_raw)
    revision = _binding_revision(app_raw, engine_raw)
    receipt = _receipt(reader, data_dir)
    record = {"keys": [digest]}
    joined = _providers(reader, receipt, {"session": record})
    target = _session_registry_id(reader, project, space, intent) if intent is not None else None
    with _directory(project / ".kiro-crew/tools") as fd:
        if not stat.S_ISREG(os.stat("aidlc.ts", dir_fd=fd, follow_symlinks=False).st_mode):
            raise Failure("UNSAFE_FILE_KIND")
    _revalidate_session(reader, snapshot)
    deadline = time.monotonic() + READER_TIMEOUT

    def run(selected=None):
        try:
            result = _run_reader(build_argv(receipt["bun"], str(project), space, selected),
                                 str(project), reader.cancelled, deadline=deadline)
            if target is not None and _session_registry_id(reader, project, space, intent) != target:
                raise Failure("SOURCE_CHANGED")
            return result
        finally:
            _revalidate_session(reader, snapshot)

    common = {"project": {"displayName": project.name, "stampValid": True},
              "bindingRevision": revision, "provider": {**record["provider"], "present": digest in joined}}
    status, body = run()
    if status != 200:
        ctx.logger.error("aidlc progress site=%s code=%s phase=%s", "_session_progress", "READER_FAILURE", "census")
        return status, _session_payload(body["state"], error=body["error"], **common)
    census = body["intents"]
    if len(census) > 500 or any(not isinstance(c, dict) or
                              not all(isinstance(c.get(k), str) for k in ("space", "id", "displayName")) or
                              type(c.get("eligible")) is not bool for c in census):
        raise Failure("READER_MALFORMED", 502)
    if target is not None:
        matches = [c for c in census if c.get("space") == space and c.get("id") == target[0]]
        if len(matches) != 1 or matches[0].get("displayName") != target[1]:
            raise Failure("SOURCE_CHANGED")
        candidate = matches[0]
        if candidate.get("reason") != "registry-only":
            if candidate.get("eligible") is not True:
                raise Failure("STALE_BINDING")
            selected = body.get("selected", {})
            if selected.get("space") != space or selected.get("id") != target[0]:
                status, body = run(target[0])
            if status != 200:
                ctx.logger.error("aidlc progress site=%s code=%s phase=%s", "_session_progress", "READER_FAILURE", "selected")
                return status, _session_payload(body["state"], error=body["error"], **common)
            selected = body.get("selected", {})
            if body["state"] != "ok" or selected.get("space") != space or selected.get("id") != target[0]:
                raise Failure("SOURCE_CHANGED")
            return 200, _session_payload("ok", selected=selected, **common)
    # Even if the reader auto-selected a singleton, the conversation did not.
    return 200, _session_payload("census", census=census, **common)
