"""Stdlib route tests against a minimal host boundary and real child processes.

Spec-load the authored routes; isolate host imports to test-owned support.
The delegate models process topology, not the engine's progress calculation.
"""
import asyncio
import builtins
from contextlib import contextmanager
from datetime import datetime, timezone
import ctypes
import errno
import hashlib
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[3]
SUPPORT = ROOT / "tests/harness/kiro-crew"
SOURCE = ROOT / "harness/kiro-crew/app/backend/routes.py"
CORPUS = json.loads((ROOT / "tests/fixtures/kiro-crew/progress-payloads.json").read_text())
PANEL = json.loads((ROOT / "tests/fixtures/kiro-crew/panel-payloads.json").read_text())
sys.path.insert(0, str(SUPPORT / "fake_kiro_crew"))
from kiro_crew.apps import manager
from kiro_crew.dashboard.handlers import source_providers


def load_module():
    spec = importlib.util.spec_from_file_location("aidlc_progress_routes_test", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def at(hour):
    return datetime(2000, 1, 2, hour, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def snapshot(root):
    result = []
    for path in sorted([root, *root.rglob("*")]):
        info = path.lstat()
        payload = os.readlink(path) if path.is_symlink() else path.read_bytes() if path.is_file() else None
        result.append((str(path.relative_to(root)), info.st_mode, info.st_mtime_ns, info.st_ctime_ns, payload))
    return result


class RoutesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="aidlc-shim-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / "crew-home"
        self.data = self.home / "apps/aidlc/data"
        self.bindings = self.data / "bindings"
        self.bindings.mkdir(parents=True)
        self.project = self.root / "project with spaces"
        self.tools = self.project / ".kiro-crew/tools"
        (self.tools / "data").mkdir(parents=True)
        self.stamp = self.tools / "data/aidlc-stamp.json"
        self.write_json(self.stamp, CORPUS["stamp"])
        (self.tools / "aidlc.ts").write_text("// delegate boundary\n")
        self.bun = self.root / "fake-bun"
        self.bun.write_text((SUPPORT / "fake_delegate.py").read_text().replace("__PYTHON__", sys.executable))
        self.bun.chmod(0o700)
        self.materialization = self.data.parent / ".aidlc-materialized.json"
        self.write_json(self.materialization, {
            "schemaVersion": 1, "bun": str(self.bun), "appRoot": str(self.data.parent),
            "crewHome": str(self.home), "materializedAt": at(6),
            "portableInventorySelfHash": self.key_hash("inventory"),
            "files": {name: {"portableSha256": self.key_hash(name), "materializedSha256": self.key_hash(name + " installed")}
                      for name in ("app.json", "mcp.fragment.json")}})
        self.key = "dashboard:reader"
        self.write_json(self.home / "session_map.json", {
            self.key: {"provider": "codex"}, "dashboard:second": {"provider": "claude_code"}})
        self.bind(self.key)
        sessions = self.project / "aidlc/.aidlc-sessions"
        sessions.mkdir(parents=True)
        self.recorded = sessions / ("crew-" + self.key_hash(self.key) + ".binding.json")
        self.write_json(self.recorded, {"schemaVersion": 1, "projectDir": str(self.project),
                                        "boundAt": at(6), "backend": "kiro"})
        self.module = load_module()
        self.ctx = SimpleNamespace(name="aidlc", data_dir=self.data, config={}, logger=Mock())
        manager.ENABLED = source_providers.OWNER = True
        manager.CALLS.clear()
        source_providers.CALLS.clear()
        self.configure("ok")

    @staticmethod
    def key_hash(key):
        return hashlib.sha256(key.encode()).hexdigest()

    @staticmethod
    def write_json(path, value):
        path.write_text(json.dumps(value))

    def bind(self, key, project=None, bound_at=None):
        self.write_json(self.bindings / (self.key_hash(key) + ".json"), {
            "projectDir": str(project or self.project), "boundAt": bound_at or at(6), "source": "test"})

    def payload(self, state="ok"):
        body = {"schemaVersion": 1, "generatedAt": at(8), "state": state,
                "project": {"dir": str(self.project), "stamp": CORPUS["stamp"]},
                "intents": CORPUS["intents"] if state != "empty" else []}
        if state == "ok":
            body["selected"] = CORPUS["selected"]
        if state == "error":
            body["error"] = {"code": "INVALID_SELECTION", "message": "Choose an eligible intent"}
        return body

    def configure(self, mode, body=None, exit_code=0):
        self.write_json(self.project / "fake-config.json", {
            "mode": mode, "body": self.payload() if body is None else body, "exit": exit_code})

    def query(self, **extra):
        return {"project": self.module.project_id(str(self.project)), **extra}

    async def async_request(self, path="/progress", query=None):
        route = next(r for r in self.module.register_routes(self.ctx) if r.path == path)
        request = SimpleNamespace(query=query if query is not None else self.query())
        response = await route.handler(request, self.ctx)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        body = json.loads(response.text)
        self.assertEqual(body["disclosure"], CORPUS["disclosure"])
        return response.status, body

    def request(self, path="/progress", query=None):
        return asyncio.run(self.async_request(path, query))

    def assert_code(self, code, status, path="/progress", query=None):
        actual, body = self.request(path, query)
        self.assertEqual(actual, status)
        self.assertEqual(body["error"]["code"], code)
        self.assertNotIn("selected", body)
        return body

    def assert_no_processes(self):
        pids = json.loads((self.project / "child-pids.json").read_text())
        for pid in pids.values():
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        with self.assertRaises(ProcessLookupError):
            os.killpg(pids["parent"], 0)

    @contextmanager
    def captured_processes(self):
        processes = []
        original = self.module.subprocess.Popen

        def spawn(*args, **kwargs):
            process = original(*args, **kwargs)
            processes.append(process)
            return process

        with patch.object(self.module.subprocess, "Popen", side_effect=spawn):
            try:
                yield processes
            finally:
                # Retain the leader identity until the final group signal.
                for process in processes:
                    if process.returncode is None:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except (ProcessLookupError, PermissionError):
                            pass
                        process.wait(timeout=3)
                    process.stdout.close()
                    process.stderr.close()

    def assert_reaped_and_closed(self, process):
        self.assertIsNotNone(process.returncode)
        with self.assertRaises(ChildProcessError):
            os.waitpid(process.pid, os.WNOHANG)
        self.assertTrue(process.stdout.closed)
        self.assertTrue(process.stderr.closed)

    def test_only_three_get_routes(self):
        self.assertEqual([(r.method, r.path) for r in self.module.register_routes(self.ctx)],
                         [("GET", "/projects"), ("GET", "/progress"), ("GET", "/session-progress")])

    def test_guard_allows_owner(self):
        self.assertEqual(self.request("/projects", {})[0], 200)
        self.assertEqual(manager.CALLS, ["aidlc"])
        self.assertEqual(len(source_providers.CALLS), 1)

    def test_guard_denies_non_owner_before_any_read(self):
        source_providers.OWNER = False
        with patch.object(self.module, "_bindings", side_effect=AssertionError("handler reached")), \
                patch.object(self.module, "_run_reader", side_effect=AssertionError("spawn reached")):
            self.assert_code("FORBIDDEN", 403)
        self.ctx.logger.warning.assert_called_once()

    def test_guard_disabled_precedes_owner_check(self):
        manager.ENABLED = False
        self.assert_code("FORBIDDEN", 403)
        self.assertEqual(source_providers.CALLS, [])
        self.ctx.logger.warning.assert_called_once()

    def test_guard_import_failure_registers_unavailable_routes(self):
        original = builtins.__import__
        for missing in ("kiro_crew.dashboard.handlers.source_providers", "kiro_crew.apps.manager", "kiro_crew.apps.route_registry"):
            with self.subTest(missing=missing):
                def importer(name, *args, **kwargs):
                    if name == missing:
                        raise ImportError("host import failure")
                    return original(name, *args, **kwargs)
                with patch("builtins.__import__", side_effect=importer):
                    self.module = load_module()
                with patch.object(self.module, "_bindings", side_effect=AssertionError("handler reached")):
                    for route in ("/projects", "/progress"):
                        self.assert_code("GUARD_UNAVAILABLE", 503, route, {})
                self.assertEqual(manager.CALLS, [])

    def test_guard_predicate_failure_is_unavailable(self):
        with patch.object(self.module, "is_owner_dashboard_request", side_effect=RuntimeError):
            self.assert_code("GUARD_UNAVAILABLE", 503)

    def test_id_dedup_recency_corruption_and_no_private_keys(self):
        alias = self.root / "project-alias"
        alias.symlink_to(self.project, target_is_directory=True)
        self.bind("dashboard:second", alias, at(8))
        (self.bindings / (self.key_hash("corrupt") + ".json")).write_text("{broken")
        before = snapshot(self.root)
        status, body = self.request("/projects", {})
        self.assertEqual(status, 200)
        self.assertEqual(len(body["projects"]), 1)
        item = body["projects"][0]
        self.assertEqual(item["id"], self.key_hash("aidlc-progress:" + str(self.project))[:16])
        self.assertEqual(item["boundAt"], at(8))
        self.assertEqual(item["displayName"], self.project.name)
        self.assertTrue(item["stampValid"])
        self.assertEqual(body["warnings"], [{"code": "CORRUPT_BINDINGS", "count": 1}])
        for private in (self.key, self.key_hash(self.key), str(self.project)):
            self.assertNotIn(private, json.dumps(body))
        self.assertEqual(before, snapshot(self.root))

    def test_projects_order_by_latest_binding(self):
        second = self.root / "newer"
        second.mkdir()
        self.bind("newer", second, at(9))
        _, body = self.request("/projects", {})
        self.assertEqual([p["displayName"] for p in body["projects"]], ["newer", self.project.name])
        self.assertFalse(body["projects"][0]["stampValid"])

    def test_projects_empty_without_receipt(self):
        shutil.rmtree(self.bindings)
        self.materialization.unlink()
        self.assertEqual(self.request("/projects", {})[1]["projects"], [])

    def test_project_missing_relative_and_special_binding_counted(self):
        self.bind("relative", Path("relative"))
        self.bind("missing", self.root / "absent")
        os.mkfifo(self.bindings / (self.key_hash("fifo") + ".json"))
        _, body = self.request("/projects", {})
        self.assertEqual(body["warnings"], [{"code": "CORRUPT_BINDINGS", "count": 3}])

    def test_unknown_id_refused(self):
        self.assert_code("UNKNOWN_PROJECT", 404, query={"project": self.key_hash("absent")[:16]})

    def test_invalid_stamp_refused_before_spawn(self):
        with patch.object(self.module, "_run_reader", side_effect=AssertionError("spawn reached")):
            for value in (None, {}, {"schemaVersion": True}, {"schemaVersion": 1, "distribution": "claude"}):
                with self.subTest(value=value):
                    if value is None:
                        self.stamp.unlink()
                    else:
                        self.write_json(self.stamp, value)
                    self.assert_code("INVALID_STAMP", 409)

    def test_stamp_links_and_escapes_refused(self):
        original = self.root / "stamp.json"
        self.stamp.rename(original)
        self.stamp.symlink_to(original)
        self.assert_code("INVALID_STAMP", 409)
        self.stamp.unlink()
        self.tools.rename(self.root / "tools")
        self.tools.symlink_to(self.root / "tools", target_is_directory=True)
        self.assert_code("INVALID_STAMP", 409)

    def test_stamp_exact_fields(self):
        source = self.stamp.read_text()
        for raw in (source.replace('"1.0.0"', '"1\\u002e0.0"'),
                    source.replace('"1.0.0"', '"UPPER"'),
                    source.replace('"schemaVersion": 1', '"schemaVersion": 1.0'),
                    source.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1'),
                    source[:-1] + ', "nested": {}}', source.replace('"kiro-crew"', '"claude"')):
            with self.subTest(raw=raw):
                self.stamp.write_text(raw)
                self.assert_code("INVALID_STAMP", 409)

    def test_argv_exact_optional_flags(self):
        prefix = [str(self.bun), str(self.tools / "aidlc.ts"), "engine", "progress", "--json", "--project-dir", str(self.project)]
        for extra, suffix in (({}, []), ({"space": "design"}, ["--space", "design"]),
                              ({"space": "design", "intent": "record:123"}, ["--space", "design", "--intent", "record:123"])):
            with patch.object(self.module.subprocess, "Popen", wraps=self.module.subprocess.Popen) as spawn:
                self.assertEqual(self.request(query=self.query(**extra))[0], 200)
                self.assertEqual(spawn.call_args.args[0], prefix + suffix)

    def test_invalid_query_never_spawns(self):
        invalid = [{}, self.query(intent="record"), self.query(space=""), self.query(space="../else"),
                   self.query(space="--help"), self.query(intent="a/b", space="main"),
                   self.query(space="x" * 129), self.query(intent="x" * 257, space="main"),
                   self.query(extra="1"), {"project": str(self.project)}]
        with patch.object(self.module, "_run_reader", side_effect=AssertionError("spawn reached")):
            for query in invalid:
                with self.subTest(query=query):
                    self.assert_code("INVALID_QUERY", 400, query=query)

    def test_duplicate_query_refused(self):
        class Multi(dict):
            def getall(self, key):
                return [self[key], self[key]]
        self.assert_code("INVALID_QUERY", 400, query=Multi(self.query()))

    def test_materialization_invalid_no_path_fallback(self):
        original = json.loads(self.materialization.read_text())
        variants = [None, {**original, "files": {}}, {**original, "appRoot": str(self.root)},
                    {**original, "bun": "relative"}, {**original, "bun": str(self.root / "absent")},
                    {**original, "portableInventorySelfHash": "invalid"}]
        with patch.object(self.module, "_run_reader", side_effect=AssertionError("spawn reached")):
            for value in variants:
                if value is None:
                    self.materialization.unlink()
                else:
                    self.write_json(self.materialization, value)
                self.assert_code("MATERIALIZATION_INVALID", 503)
            self.write_json(self.materialization, original)
            self.bun.chmod(0o600)
            self.assert_code("MATERIALIZATION_INVALID", 503)

    def test_materialization_home_must_match_own_root(self):
        value = json.loads(self.materialization.read_text())
        value["crewHome"] = str(self.root)
        self.write_json(self.materialization, value)
        self.assert_code("MATERIALIZATION_INVALID", 503)

    def test_provider_kiro_to_codex_preserves_both_records_and_labels(self):
        before = snapshot(self.root)
        status, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(body["provider"], {"label": "codex", "source": "crew-session-map", "conflict": False})
        self.assertEqual(body["selected"]["backend"]["asRecorded"], "kiro")
        self.assertEqual(snapshot(self.root), before)

    def test_provider_families_and_unknown(self):
        for provider, expected in (("acp", "kiro"), ("kiro", "kiro"), ("kas", "kiro"),
                                   ("claude_code", "claude"), ("codex", "codex"), ("other", "unknown")):
            with self.subTest(provider=provider):
                self.write_json(self.home / "session_map.json", {self.key: {"provider": provider}})
                self.assertEqual(self.request("/projects", {})[1]["projects"][0]["providerLabel"], expected)

    def test_provider_join_conflict(self):
        self.bind("dashboard:second")
        self.assertEqual(self.request()[1]["provider"], {"label": "unknown", "source": "crew-session-map", "conflict": True})

    def test_missing_provider_map_is_unknown(self):
        (self.home / "session_map.json").unlink()
        self.assertEqual(self.request("/projects", {})[1]["projects"][0]["providerLabel"], "unknown")

    def test_malformed_provider_is_unavailable_not_unknown(self):
        for raw in ("{broken", "[]", '{"key":1,"key":2}', b"\xff"):
            path = self.home / "session_map.json"
            path.write_bytes(raw if isinstance(raw, bytes) else raw.encode())
            self.assert_code("SOURCE_MALFORMED", 503)

    def test_environment_is_allowlist_and_home_is_removed(self):
        self.configure("environment")
        with patch.dict(os.environ, {"AWS_SECRET_ACCESS_KEY": "test", "AIDLC_PROJECT_DIR": str(self.root),
                                     "KIROCREW_HOME": str(self.home), "CODEX_HOME": str(self.root),
                                     "ANTHROPIC_API_KEY": "test", "BUN_OPTIONS": "--preload=never"}), \
                patch.object(self.module.subprocess, "Popen", wraps=self.module.subprocess.Popen) as spawn:
            _, body = self.request(query=self.query(space="other", intent="id:123"))
        spawn.assert_called_once()
        env = spawn.call_args.kwargs["env"]
        self.assertEqual(set(env), {"PATH", "HOME", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "LANG", "LC_ALL"})
        self.assertEqual(env["PATH"], str(self.bun.parent))
        self.assertEqual(env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"], "0")
        self.assertFalse(Path(env["HOME"]).exists())
        self.assertEqual(body["cwd"], str(self.project))
        self.assertEqual(body["argv"], self.module.build_argv(str(self.bun), str(self.project), "other", "id:123")[1:])

    def test_reader_nonzero_error_envelope_passthrough(self):
        body = self.payload("error")
        self.configure("ok", body, 1)
        status, actual = self.request()
        self.assertEqual(status, 502)
        self.assertEqual(actual["error"], body["error"])
        self.assertEqual(actual["state"], "error")

    def test_reader_empty_and_selection_required_passthrough(self):
        for state in ("empty", "selection-required"):
            self.configure("ok", self.payload(state))
            status, actual = self.request()
            self.assertEqual(status, 200)
            self.assertEqual(actual["state"], state)
            self.assertNotIn("selected", actual)

    def test_malformed_stdout(self):
        self.configure("malformed")
        self.assert_code("READER_MALFORMED", 502)

    def test_malformed_reader_shapes(self):
        for body in ([], {"schemaVersion": 1, "state": []}, {"schemaVersion": 1, "state": "ok"},
                     {"schemaVersion": 2, "state": "error", "error": {"code": "BAD"}}):
            with self.subTest(body=body):
                self.configure("ok", body)
                self.assert_code("READER_MALFORMED", 502)
        self.configure("ok", exit_code=1)
        self.assert_code("READER_MALFORMED", 502)

    def test_stdout_exact_boundary_and_one_byte_over(self):
        body = json.loads((self.project / "fake-config.json").read_text())["body"]
        size = len((json.dumps(body) + "\n").encode())
        with patch.object(self.module, "MAX_STDOUT", size):
            self.assertEqual(self.request()[0], 200)
        with patch.object(self.module, "MAX_STDOUT", size - 1):
            self.assert_code("READER_OUTPUT_OVERFLOW", 502)

    def test_spawn_contract_and_spawn_failure(self):
        with patch.object(self.module.subprocess, "Popen", wraps=self.module.subprocess.Popen) as spawn:
            self.assertEqual(self.request()[0], 200)
            self.assertEqual(spawn.call_args.kwargs["cwd"], str(self.project))
            self.assertIs(spawn.call_args.kwargs["shell"], False)
            self.assertIs(spawn.call_args.kwargs["start_new_session"], True)
            self.assertEqual(spawn.call_args.args[0], self.module.build_argv(str(self.bun), str(self.project)))
        with patch.object(self.module.subprocess, "Popen", side_effect=OSError):
            self.assert_code("READER_START_FAILED", 502)

    @unittest.skipUnless(sys.platform == "darwin", "Darwin zombie-group cleanup requires macOS")
    def test_darwin_exited_unreaped_leader_cleanup_passthrough(self):
        cleanup = self.module._cleanup
        observed = []

        def clean(process):
            deadline = time.monotonic() + 3
            while not self.module._exited_unreaped(process.pid):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)
            self.assertIs(self.module._group_only_zombies(process.pid), True)
            observed.append(process.pid)
            cleanup(process)
            self.assert_reaped_and_closed(process)

        with self.captured_processes() as processes, patch.object(self.module, "_cleanup", side_effect=clean):
            status, body = self.request()
            self.assertEqual(status, 200)
            self.assertEqual(body["selected"], self.payload()["selected"])
            self.assertEqual(observed, [processes[0].pid])

    @unittest.skipUnless(sys.platform == "darwin", "Darwin orphan reaping requires macOS")
    def test_darwin_live_descendant_after_leader_exit(self):
        self.configure("orphan")
        cleanup = self.module._cleanup

        def clean(process):
            self.assertTrue(self.module._exited_unreaped(process.pid))
            self.assertIs(self.module._group_only_zombies(process.pid), False)
            cleanup(process)

        with self.captured_processes() as processes, patch.object(self.module, "_cleanup", side_effect=clean):
            self.assertEqual(self.request()[0], 200)
            self.assert_reaped_and_closed(processes[0])
            deadline = time.monotonic() + 3
            while True:
                try:
                    self.assert_no_processes()
                    break
                except (AssertionError, PermissionError):
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.01)

    def test_genuine_eperm_fails_closed_and_logs(self):
        for proof in (False, None):
            with self.subTest(proof=proof), self.captured_processes() as processes:
                self.ctx.logger.reset_mock()
                denied = PermissionError(errno.EPERM, "permission denial", "private-group")
                with patch.object(self.module.sys, "platform", "darwin"), \
                        patch.object(self.module, "_exited_unreaped", return_value=True), \
                        patch.object(self.module, "_group_only_zombies", return_value=proof), \
                        patch.object(self.module.os, "killpg", side_effect=denied):
                    body = self.assert_code("SOURCE_UNREADABLE", 503)
                self.assert_reaped_and_closed(processes[0])
                self.ctx.logger.error.assert_called_once()
                args = self.ctx.logger.error.call_args.args
                self.assertEqual(args[1:6], ("_progress", "PermissionError", errno.EPERM, "permission denial", "private-group"))
                self.assertEqual(args[6:], (processes[0].pid, processes[0].pid, "term"))
                self.assertNotIn("private-group", json.dumps(body))
                self.assertNotIn("reader_lifecycle", json.dumps(body))

    def test_unverifiable_enumeration_reraises_original_eperm(self):
        denied = PermissionError(errno.EPERM, "denied")
        with patch.object(self.module.sys, "platform", "darwin"), \
                patch.object(self.module, "_exited_unreaped", return_value=True), \
                patch.object(self.module, "_darwin_group_members", return_value=None), \
                patch.object(self.module.os, "killpg", side_effect=denied):
            self.assertIsNone(self.module._group_only_zombies(123))
            with self.assertRaises(PermissionError) as caught:
                self.module._signal_group(123, signal.SIGTERM)
            self.assertIs(caught.exception, denied)

    def test_eperm_requires_platform_errno_and_exited_leader(self):
        for platform, code, exited in (("linux", errno.EPERM, True), ("darwin", errno.EACCES, True), ("darwin", errno.EPERM, False)):
            denied = PermissionError(code, "denied")
            with self.subTest(platform=platform, code=code, exited=exited), \
                    patch.object(self.module.sys, "platform", platform), \
                    patch.object(self.module, "_exited_unreaped", return_value=exited), \
                    patch.object(self.module, "_group_only_zombies", return_value=True) as census, \
                    patch.object(self.module.os, "killpg", side_effect=denied):
                with self.assertRaises(PermissionError) as caught:
                    self.module._signal_group(123, signal.SIGTERM)
                self.assertIs(caught.exception, denied)
                census.assert_not_called()

    def test_zombie_census_requires_leader_and_every_member(self):
        for members, expected in (([], False), ([(456, 5)], False), ([(123, 2)], False),
                                   ([(123, 5), (456, 2)], False), ([(123, 5)], True),
                                   ([(456, 5), (123, 5)], True), (None, None)):
            with self.subTest(members=members), patch.object(self.module, "_darwin_group_members", return_value=members):
                self.assertIs(self.module._group_only_zombies(123), expected)

    def test_sysctl_census_bounds_abi_and_read_failures(self):
        record = self.module._DarwinKinfoProc
        self.assertEqual((ctypes.sizeof(record), record.p_stat.offset, record.p_pid.offset), (648, 36, 40))
        cases = ((648, 648, 0, 0, 123, 5, [(123, 5)]), (648, 0, 0, 0, 123, 5, []),
                 (4096 * 648, 648, 0, 0, 123, 5, [(123, 5)]), (4097 * 648, 648, 0, 0, 123, 5, None),
                 (649, 648, 0, 0, 123, 5, None), (648, 649, 0, 0, 123, 5, None),
                 (648, 4097 * 648, 0, 0, 123, 5, None), (648, 648, -1, 0, 123, 5, None),
                 (648, 648, 0, -1, 123, 5, None), (648, 648, 0, 0, 0, 5, None), (648, 648, 0, 0, 123, 0, None))
        for initial, actual, first_rc, second_rc, pid, state, expected in cases:
            def sysctl(mib, count, output, length, new, new_length):
                self.assertEqual(list(mib), [1, 14, 2, 123])
                self.assertEqual((count, new, new_length), (4, None, 0))
                size = ctypes.cast(length, ctypes.POINTER(ctypes.c_size_t))
                if output is None:
                    size[0] = initial
                    return first_rc
                self.assertLessEqual(size[0], 4096 * 648)
                output[0].p_pid, output[0].p_stat = pid, state
                size[0] = actual
                return second_rc

            with self.subTest(case=(initial, actual, first_rc, second_rc, pid, state)), \
                    patch.object(self.module.sys, "platform", "darwin"), \
                    patch.object(self.module.ctypes, "CDLL", return_value=SimpleNamespace(sysctl=Mock(side_effect=sysctl))):
                self.assertEqual(self.module._darwin_group_members(123), expected)
        with patch.object(self.module.sys, "platform", "darwin"), patch.object(self.module.ctypes, "CDLL", side_effect=OSError):
            self.assertIsNone(self.module._darwin_group_members(123))

    def test_cleanup_always_waits_and_closes_preserving_first_error(self):
        denied = PermissionError(errno.EPERM, "first error")
        process = SimpleNamespace(pid=123, wait=Mock(side_effect=OSError("wait failed")),
                                  stdout=SimpleNamespace(close=Mock(side_effect=OSError("close failed"))),
                                  stderr=SimpleNamespace(close=Mock()))
        with patch.object(self.module, "_signal_group", side_effect=denied):
            with self.assertRaises(PermissionError) as caught:
                self.module._cleanup(process)
        self.assertIs(caught.exception, denied)
        self.assertEqual(denied.reader_lifecycle, {"pid": 123, "pgid": 123, "phase": "term"})
        process.wait.assert_called_once()
        process.stdout.close.assert_called_once()
        process.stderr.close.assert_called_once()

    def test_reader_failure_not_masked_by_cleanup_failure(self):
        self.configure("hang")
        cleanup = self.module._cleanup

        def fail_after_cleanup(process):
            cleanup(process)
            raise PermissionError(errno.EPERM, "later cleanup error")

        with self.captured_processes() as processes, patch.object(self.module, "READER_TIMEOUT", 0.5), \
                patch.object(self.module, "_cleanup", side_effect=fail_after_cleanup):
            self.assert_code("READER_TIMEOUT", 504)
            self.assert_reaped_and_closed(processes[0])
        self.assert_no_processes()

    def test_generic_converter_logs_site_and_oserror_fields_only_server_side(self):
        denied = PermissionError(errno.EPERM, "private detail", "private-filename")
        with patch.object(self.module, "_bindings", side_effect=denied):
            body = self.assert_code("SOURCE_UNREADABLE", 503, "/projects", {})
        self.assertEqual(self.ctx.logger.error.call_args.args[1:], (
            "_projects", "PermissionError", errno.EPERM, "private detail", "private-filename", None, None, "source"))
        self.assertNotIn("private", json.dumps(body))

    def test_reader_default_deadline_bounds_pipe_and_leader_waits(self):
        # Leave READER_TIMEOUT untouched. Straddle the documented ten-second
        # deadline with a controlled clock, including after both pipes close.
        for pipes_open in (True, False):
            process = Mock()
            clock = SimpleNamespace(monotonic=Mock(side_effect=[100.0, 100.0, 109.999, 110.0]), sleep=Mock())
            with self.subTest(pipes_open=pipes_open), \
                    patch.object(self.module, "time", clock), \
                    patch.object(self.module.subprocess, "Popen", return_value=process) as spawn, \
                    patch.object(self.module.selectors, "DefaultSelector") as factory, \
                    patch.object(self.module.os, "set_blocking"), \
                    patch.object(self.module, "_exited_unreaped", return_value=False), \
                    patch.object(self.module, "_cleanup") as cleanup:
                selector = factory.return_value.__enter__.return_value
                selector.get_map.return_value = {"stdout": object()} if pipes_open else {}
                selector.select.return_value = []
                with self.assertRaises(self.module.Failure) as caught:
                    self.module._run_reader(self.module.build_argv(str(self.bun), str(self.project)),
                                            str(self.project), threading.Event())
                self.assertEqual((caught.exception.code, caught.exception.status), ("READER_TIMEOUT", 504))
                self.assertEqual(clock.monotonic.call_count, 4)
                if pipes_open:
                    selector.select.assert_called_once_with(self.module.POLL_INTERVAL)
                    clock.sleep.assert_not_called()
                else:
                    selector.select.assert_not_called()
                    clock.sleep.assert_called_once_with(self.module.POLL_INTERVAL)
                spawn.assert_called_once()
                cleanup.assert_called_once_with(process)

    def test_timeout_reaps_delegate_tree(self):
        self.configure("hang")
        with self.captured_processes() as processes, patch.object(self.module, "READER_TIMEOUT", 0.5):
            start = time.monotonic()
            self.assert_code("READER_TIMEOUT", 504)
            self.assertLessEqual(time.monotonic() - start, 2.5)
            self.assert_reaped_and_closed(processes[0])
        self.assert_no_processes()

    def test_stdout_overflow_reaps_delegate_tree(self):
        self.configure("stdout")
        start = time.monotonic()
        self.assert_code("READER_OUTPUT_OVERFLOW", 502)
        self.assertLess(time.monotonic() - start, 3)
        self.assert_no_processes()

    def test_stderr_overflow_reaps_delegate_tree(self):
        self.configure("stderr")
        self.assert_code("READER_OUTPUT_OVERFLOW", 502)
        self.assert_no_processes()

    def test_both_pipes_flood_without_deadlock(self):
        self.configure("both")
        self.assert_code("READER_OUTPUT_OVERFLOW", 502)
        self.assert_no_processes()

    def test_closed_pipes_still_obey_deadline(self):
        self.configure("closed-pipes")
        with patch.object(self.module, "READER_TIMEOUT", 0.5):
            self.assert_code("READER_TIMEOUT", 504)
        self.assert_no_processes()

    def test_sigkill_escalation(self):
        self.configure("ignore-term")
        with patch.object(self.module, "READER_TIMEOUT", 0.5), patch.object(self.module.os, "killpg", wraps=os.killpg) as send:
            self.assert_code("READER_TIMEOUT", 504)
            self.assertIn(signal.SIGKILL, [call.args[1] for call in send.call_args_list])
        self.assert_no_processes()

    def test_cancellation_joins_worker_before_propagating(self):
        self.configure("hang")

        async def scenario():
            task = asyncio.create_task(self.async_request())
            deadline = time.monotonic() + 3
            while not (self.project / "child-pids.json").exists():
                self.assertLess(time.monotonic(), deadline)
                await asyncio.sleep(0.01)
            task.cancel()
            await asyncio.sleep(0.02)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assert_no_processes()
        with self.captured_processes() as processes:
            asyncio.run(scenario())
            self.assert_reaped_and_closed(processes[0])

    def test_filesystem_work_is_off_loop(self):
        loop_thread = threading.get_ident()
        original = self.module._bindings

        def off_loop(*args):
            self.assertNotEqual(threading.get_ident(), loop_thread)
            return original(*args)
        with patch.object(self.module, "_bindings", side_effect=off_loop):
            self.assertEqual(self.request("/projects", {})[0], 200)

    def test_binding_directory_budget_at_and_over_boundary(self):
        with patch.object(self.module, "MAX_BINDINGS", 1):
            self.assertEqual(self.request("/projects", {})[0], 200)
            self.bind("second")
            self.assert_code("LIMIT_EXCEEDED", 503, "/projects", {})

    def test_binding_file_and_aggregate_byte_limits(self):
        path = self.bindings / (self.key_hash(self.key) + ".json")
        raw = path.read_text()
        path.write_text(raw.ljust(self.module.MAX_FILE_BYTES))
        self.assertEqual(self.request("/projects", {})[0], 200)
        path.write_text(raw.ljust(self.module.MAX_FILE_BYTES + 1))
        self.assert_code("LIMIT_EXCEEDED", 503, "/projects", {})
        self.bind(self.key)
        total = sum(p.stat().st_size for p in (path, self.materialization, self.home / "session_map.json", self.stamp))
        with patch.object(self.module, "MAX_TOTAL_BYTES", total):
            self.assertEqual(self.request("/projects", {})[0], 200)
        with patch.object(self.module, "MAX_TOTAL_BYTES", total - 1):
            self.assert_code("LIMIT_EXCEEDED", 503, "/projects", {})

    def test_provider_entry_and_byte_limits(self):
        with patch.object(self.module, "MAX_SESSION_ENTRIES", 2):
            self.assertEqual(self.request()[0], 200)
        with patch.object(self.module, "MAX_SESSION_ENTRIES", 1):
            self.assert_code("LIMIT_EXCEEDED", 503)
        path = self.home / "session_map.json"
        raw = path.read_text()
        path.write_text(raw.ljust(self.module.MAX_SESSION_BYTES))
        self.assertEqual(self.request()[0], 200)
        path.write_text(raw.ljust(self.module.MAX_SESSION_BYTES + 1))
        self.assert_code("LIMIT_EXCEEDED", 503)

    def test_json_node_and_depth_limits(self):
        path = self.root / "bounded.json"
        self.write_json(path, {"a": {"b": 1}})
        with patch.object(self.module, "MAX_JSON_NODES", 3), patch.object(self.module, "MAX_JSON_DEPTH", 2):
            self.assertEqual(self.module.Reader(threading.Event()).document(path), {"a": {"b": 1}})
        for name, limit in (("MAX_JSON_NODES", 2), ("MAX_JSON_DEPTH", 1)):
            with patch.object(self.module, name, limit):
                with self.assertRaises(self.module.Failure) as caught:
                    self.module.Reader(threading.Event()).document(path)
                self.assertEqual(caught.exception.code, "LIMIT_EXCEEDED")
        with patch.object(self.module, "MAX_JSON_NODES", 1):
            self.assert_code("LIMIT_EXCEEDED", 503)

    def test_receipt_and_provider_special_files_never_block(self):
        for path in (self.materialization, self.home / "session_map.json", self.tools / "aidlc.ts"):
            with self.subTest(path=path):
                original = path.read_bytes()
                path.unlink()
                os.mkfifo(path)
                self.assert_code("UNSAFE_FILE_KIND", 503)
                path.unlink()
                path.write_bytes(original)

    def test_binding_and_engine_symlinks_refused(self):
        path = self.bindings / (self.key_hash(self.key) + ".json")
        backup = self.root / "binding.json"
        path.rename(backup)
        path.symlink_to(backup)
        _, body = self.request("/projects", {})
        self.assertEqual(body["projects"], [])
        self.assertEqual(body["warnings"], [{"code": "CORRUPT_BINDINGS", "count": 1}])
        path.unlink()
        self.bind(self.key)
        engine = self.tools / "aidlc.ts"
        engine.unlink()
        engine.symlink_to(self.bun)
        self.assert_code("UNSAFE_FILE_KIND", 503)

    def test_changed_snapshot_refuses_instead_of_partial_success(self):
        with patch.object(self.module, "_same", return_value=False):
            self.assert_code("SOURCE_CHANGED", 503, "/projects", {})

    def test_no_memo_rebuilds_project_map(self):
        self.assertEqual(self.request("/projects", {})[0], 200)
        (self.bindings / (self.key_hash(self.key) + ".json")).unlink()
        self.assert_code("UNKNOWN_PROJECT", 404)

    def test_no_write_primitives_or_template_tokens(self):
        # Observe real calls, including failed reads, rather than source spelling.
        for route, query, status in (("/projects", {}, 200), ("/progress", self.query(), 200),
                                     ("/progress", self.query(space="../escape"), 400)):
            before = snapshot(self.root)
            self.assertEqual(self.request(route, query)[0], status)
            self.assertEqual(snapshot(self.root), before)
        self.stamp.write_text("{}")
        before = snapshot(self.root)
        self.assert_code("INVALID_STAMP", 409)
        self.assertEqual(snapshot(self.root), before)

    def test_response_fixtures_pin_disclosure(self):
        # Every request helper checks no-store and the public disclosure on the
        # actual response; this case also covers empty and unavailable results.
        for state in ("ok", "empty", "selection-required", "error"):
            self.configure("ok", self.payload(state), int(state == "error"))
            self.assertEqual(self.request()[1]["disclosure"], CORPUS["disclosure"])
        manager.ENABLED = False
        self.assert_code("FORBIDDEN", 403)
        manager.ENABLED = True
        with patch.object(self.module, "is_owner_dashboard_request", side_effect=RuntimeError):
            self.assert_code("GUARD_UNAVAILABLE", 503)


class SessionRoutesTest(unittest.TestCase):
    """Exercise the exact-session route through the owner-cookie host boundary."""
    key_hash = staticmethod(RoutesTest.key_hash)
    write_json = staticmethod(RoutesTest.write_json)
    bind = RoutesTest.bind
    configure = RoutesTest.configure

    def payload(self):
        body = RoutesTest.payload(self)
        body = json.loads(json.dumps(body))
        body["intents"] = [dict(PANEL["intent"])]
        body["selected"].update({key: PANEL["intent"][key] for key in ("space", "id", "displayName")})
        return body

    reader_body = payload

    def setUp(self):
        RoutesTest.setUp(self)
        self.key = PANEL["sessionKey"]
        self.bind(self.key)
        self.recorded = self.project / "aidlc/.aidlc-sessions" / ("crew-" + self.key_hash(self.key) + ".binding.json")
        self.base = self.project / "aidlc/spaces/non-default/intents"
        self.base.mkdir(parents=True)
        self.engine_binding("delivery-selected")
        self.registry([{"uuid": "record-123", "slug": "delivery", "dirName": "delivery-selected", "status": "active"}],
                      ["delivery-selected"])
        self.identity = {"user": "fixture-owner", "app": "", "auth_token": "fixture-validated-cookie",
                         "is_dashboard_user": True, "auth_from_query_token": False}
        owner = patch.object(self.module, "is_owner_dashboard_request", side_effect=lambda r:
                             r.get("user") == "fixture-owner" and r.get("app") == "")
        owner.start()
        self.addCleanup(owner.stop)
        self.write_json(self.home / "session_map.json", {self.key: {"provider": "codex"}})

    def engine_binding(self, intent, key=None, space="non-default"):
        path = self.project / "aidlc/.aidlc-sessions" / ("crew-" + self.key_hash(key or self.key) + ".binding.json")
        self.write_json(path, {"space": space, "intent": intent, "boundAt": at(8)})

    def registry(self, rows, directories):
        for child in self.base.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
        for directory in directories:
            (self.base / directory).mkdir()
            (self.base / directory / "aidlc-state.md").write_text("**Scope**: feature\n**Status**: active\n")
        self.write_json(self.base / "intents.json", rows)

    def request(self, key="default", identity=None, query=None):
        class Request(dict):
            pass
        request = Request(self.identity if identity is None else identity)
        request.query = {} if query is None else query
        request.headers = {} if key is None else {"X-Session-Key": self.key if key == "default" else key}
        request.app = {"state": SimpleNamespace(owner_id="fixture-owner")}
        route = next(r for r in self.module.register_routes(self.ctx) if r.path == "/session-progress")
        response = asyncio.run(route.handler(request, self.ctx))
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        body = json.loads(response.text)
        self.assertEqual(body["disclosure"], CORPUS["disclosure"])
        # Check correlation on every real response, including converted failures.
        stamped = request.headers.get("X-Session-Key")
        valid = isinstance(stamped, str) and re.fullmatch(r"dashboard:[A-Za-z0-9._:-]{1,128}", stamped)
        admitted = body.get("error", {}).get("code") not in ("FORBIDDEN", "GUARD_UNAVAILABLE")
        if valid and stamped != "dashboard:ui" and admitted:
            self.assertEqual(body.get("conversationRef"), self.key_hash(stamped)[:8])
        else:
            self.assertNotIn("conversationRef", body)
        self.assertNotRegex(response.text, r"[0-9a-fA-F]{64}")
        if stamped:
            self.assertNotIn(stamped, response.text)
            self.assertNotIn(self.key_hash(stamped), response.text)
        return response.status, body

    def assert_code(self, code, status, **kwargs):
        actual, body = self.request(**kwargs)
        self.assertEqual(actual, status)
        self.assertEqual(body["error"]["code"], code)
        self.assertNotIn("selected", body)
        return body

    def test_session_cookie_owner_success_one_spawn(self):
        before = snapshot(self.root)
        with patch.object(self.module, "_run_reader", wraps=self.module._run_reader) as runner:
            status, body = self.request()
        self.assertEqual((status, body["state"]), (200, "ok"))
        self.assertEqual(body["selected"]["id"], "record-123")
        self.assertEqual(body["project"], {"displayName": self.project.name, "stampValid": True})
        self.assertEqual(body["provider"]["label"], "codex")
        self.assertEqual(body["selected"]["backend"]["asRecorded"], "kiro")
        runner.assert_called_once()
        self.assertEqual(runner.call_args.args[0][-2:], ["--space", "non-default"])
        self.assertEqual(before, snapshot(self.root))

    def test_session_provider_own_key_absent(self):
        self.write_json(self.home / "session_map.json", {"dashboard:other-fixture": {"provider": "codex"}})
        before = snapshot(self.root)
        status, body = self.request()
        self.assertEqual((status, body["state"]), (200, "ok"))
        self.assertEqual(body["provider"], {"label": "unknown", "source": "crew-session-map",
                                           "present": False, "conflict": False})
        self.assertEqual(body["selected"]["backend"]["asRecorded"], "kiro")
        self.assertEqual(before, snapshot(self.root))

    def test_session_provider_two_keys_no_cross_conflict(self):
        second = "dashboard:provider-b-fixture"
        self.bind(second)
        self.engine_binding("delivery-selected", second)
        self.write_json(self.home / "session_map.json", {self.key: {"provider": "acp"}, second: {"provider": "codex"}})
        before = snapshot(self.root)
        for key, label in ((self.key, "kiro"), (second, "codex")):
            status, body = self.request(key=key)
            self.assertEqual((status, body["state"]), (200, "ok"))
            self.assertEqual(body["provider"], {"label": label, "source": "crew-session-map",
                                               "present": True, "conflict": False})
        self.assertEqual(before, snapshot(self.root))

    def test_session_provider_unknown_entry_is_present(self):
        for entry in ({"provider": "future-provider"}, {"provider": None}, {}, None):
            with self.subTest(entry=entry):
                self.write_json(self.home / "session_map.json", {self.key: entry})
                status, body = self.request()
                self.assertEqual((status, body["state"]), (200, "ok"))
                self.assertEqual(body["provider"], {"label": "unknown", "source": "crew-session-map",
                                                   "present": True, "conflict": False})

    def test_session_default_logger_and_audit_visibility(self):
        parent = logging.Logger("fixture-root", logging.WARNING)
        logger = logging.Logger("kirocrew.app.aidlc")
        logger.parent = parent
        sibling = logging.Logger("kirocrew.app.other")
        sibling.parent = parent
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        parent.addHandler(handler)
        self.addCleanup(handler.close)
        self.ctx.logger, self.ctx.audit = logger, Mock()
        self.assertEqual(logger.getEffectiveLevel(), logging.WARNING)
        self.module.register_routes(self.ctx)
        self.assertEqual(logger.getEffectiveLevel(), logging.INFO)
        self.assertEqual((parent.level, sibling.getEffectiveLevel()), (logging.WARNING, logging.WARNING))
        self.assertEqual(logger.handlers, [])
        self.assertEqual(parent.handlers, [handler])
        self.assertEqual(handler.level, logging.NOTSET)
        self.assertTrue(logger.propagate)
        with patch.object(self.module, "_run_reader", return_value=(200, self.reader_body())):
            for key, state, present in ((self.key, "ok", True), ("dashboard:log-unbound", "unbound", "-")):
                stream.seek(0)
                stream.truncate(0)
                self.ctx.audit.reset_mock()
                status, body = self.request(key=key)
                self.assertEqual((status, body["state"]), (200, state))
                fields = f"key={self.key_hash(key)[:8]} state={state} present={present} status=200"
                self.assertEqual(stream.getvalue(), "aidlc session-progress " + fields + "\n")
                self.ctx.audit.record.assert_called_once_with("session-progress", state, resources=fields)
                for captured in (stream.getvalue(), repr(self.ctx.audit.mock_calls), json.dumps(body)):
                    self.assertNotIn(key, captured)
                    self.assertNotIn(self.key_hash(key), captured)
        stream.seek(0)
        stream.truncate(0)
        handler.setLevel(logging.WARNING)
        self.ctx.audit.reset_mock()
        self.request(key="dashboard:log-unbound")
        self.assertEqual(stream.getvalue(), "")
        self.ctx.audit.record.assert_called_once()
        self.ctx.audit.reset_mock()
        self.assert_code("FORBIDDEN", 403, identity={**self.identity, "auth_from_query_token": True})
        self.ctx.audit.record.assert_not_called()
        self.assertNotIn("aidlc session-progress", stream.getvalue())
        # The host SDK, not the route, owns best-effort sink exception handling.
        sink = Mock(side_effect=OSError("audit sink unavailable"))
        def sdk_record(*args, **kwargs):
            try:
                sink(*args, **kwargs)
            except OSError:
                pass
        self.ctx.audit = SimpleNamespace(record=sdk_record)
        self.assertEqual(self.request(key="dashboard:log-unbound")[1]["state"], "unbound")
        sink.assert_called_once()
        self.ctx.audit = None
        self.assertEqual(self.request(key="dashboard:log-unbound")[1]["state"], "unbound")
        del self.ctx.audit
        self.assertEqual(self.request(key="dashboard:log-unbound")[1]["state"], "unbound")

    def test_session_diagnostic_two_keys_redacted_and_ordered(self):
        second = "dashboard:diagnostic-b-fixture"
        self.bind(second)
        self.engine_binding(None, second)
        self.write_json(self.home / "session_map.json", {self.key: {"provider": "acp"}})
        bodies = []
        with patch.object(self.module, "_run_reader", return_value=(200, self.reader_body())):
            for key, state, present in ((self.key, "ok", True), (second, "census", "-")):
                status, body = self.request(key=key)
                bodies.append(body)
                self.assertEqual((status, body["state"]), (200, state))
                self.assertEqual(self.ctx.logger.info.call_args.args,
                                 ("aidlc session-progress key=%s state=%s present=%s status=%d",
                                  self.key_hash(key)[:8], state, present, status))
        calls = self.ctx.logger.info.call_args_list
        self.assertEqual(len(calls), 2)
        prefixes = [call.args[1] for call in calls]
        self.assertEqual(len(set(prefixes)), 2)
        for prefix in prefixes:
            self.assertRegex(prefix, r"^[a-f0-9]{8}$")
        for key in (self.key, second):
            for captured in (repr(self.ctx.logger.mock_calls), json.dumps(bodies)):
                self.assertNotIn(key, captured)
                self.assertNotIn(self.key_hash(key), captured)
        for body, key, other in ((bodies[0], self.key, second), (bodies[1], second, self.key)):
            self.assertEqual(body["conversationRef"], self.key_hash(key)[:8])
            self.assertNotIn(self.key_hash(other)[:8], json.dumps(body))
            self.assertNotRegex(json.dumps(body), r"[0-9a-fA-F]{64}")

    def test_session_query_refusal_uses_header_not_query_identity(self):
        for key in (None, "dashboard:bad/key", "dashboard:a\n", "dashboard:ui", self.key):
            with self.subTest(key=key):
                body = self.assert_code("INVALID_QUERY", 400, key=key, query={"session": "dashboard:other-fixture"})
                self.assertNotIn(self.key_hash("dashboard:other-fixture")[:8], json.dumps(body))

    def test_session_reserved_unsupported_and_reader_error_carry_reference(self):
        # The wrapper reserves unsupported; the route does not classify linkage.
        for status, payload in ((200, self.module._session_payload("unsupported", reason=PANEL["reason"])),
                                (502, self.module._session_payload("error", error={"code": "READER_ERROR", "message": "Failed"}))):
            with self.subTest(state=payload["state"]):
                with patch.object(self.module, "_session_progress_read", return_value=(status, payload)):
                    actual, body = self.request()
                self.assertEqual((actual, body["state"]), (status, payload["state"]))
                self.assertEqual(body["conversationRef"], self.key_hash(self.key)[:8])

    def test_session_diagnostic_unbound_and_converted_refusals(self):
        cases = [("dashboard:unbound-diagnostic", {}, 200, "unbound"),
                 (self.key, {"session": self.key}, 400, "error"),
                 (None, {}, 400, "error"), ("dashboard:bad/key", {}, 400, "error"),
                 ("dashboard:ui", {}, 409, "unavailable")]
        for key, query, expected_status, expected_state in cases:
            with self.subTest(key=key):
                self.ctx.logger.reset_mock()
                status, body = self.request(key=key, query=query)
                self.assertEqual((status, body["state"]), (expected_status, expected_state))
                prefix = self.key_hash(key)[:8] if key and "/" not in key else "-"
                self.ctx.logger.info.assert_called_once_with(
                    "aidlc session-progress key=%s state=%s present=%s status=%d",
                    prefix, expected_state, "-", expected_status)
                if key:
                    for captured in (repr(self.ctx.logger.mock_calls), json.dumps(body)):
                        self.assertNotIn(key, captured)
                        self.assertNotIn(self.key_hash(key), captured)
        failures = [(self.module.Failure("READER_TIMEOUT", 504), 504, "unavailable"),
                    (ValueError(self.key), 503, "unavailable"),
                    (RecursionError(self.key_hash(self.key)), 503, "unavailable"),
                    (self.module._BindingChanged(self.key_hash("new binding")[:16]), 200, "unavailable")]
        for failure, status, state in failures:
            with self.subTest(failure=type(failure).__name__):
                self.ctx.logger.reset_mock()
                with patch.object(self.module, "_session_progress_read", side_effect=failure):
                    actual, body = self.request()
                self.assertEqual((actual, body["state"]), (status, state))
                self.ctx.logger.info.assert_called_once_with(
                    "aidlc session-progress key=%s state=%s present=%s status=%d",
                    self.key_hash(self.key)[:8], state, "-", status)
                self.assertEqual(self.ctx.logger.mock_calls[-1][0], "info")
                for captured in (repr(self.ctx.logger.mock_calls), json.dumps(body)):
                    self.assertNotIn(self.key, captured)
                    self.assertNotIn(self.key_hash(self.key), captured)

    def test_session_diagnostic_oserror_identity_redaction(self):
        digest = self.key_hash(self.key)
        for number, code in ((errno.EPERM, "SOURCE_UNREADABLE"), (errno.ELOOP, "UNSAFE_FILE_KIND")):
            self.ctx.logger.reset_mock()
            failure = OSError(number, "cannot read " + self.key, str(self.bindings / (digest + ".json")))
            failure.reader_lifecycle = {"pid": 123, "pgid": 123, "phase": "read"}
            with patch.object(self.module, "_session_progress_read", side_effect=failure):
                body = self.assert_code(code, 503)
            self.ctx.logger.error.assert_called_once()
            self.assertEqual(self.ctx.logger.error.call_args.args[1:4],
                             ("_session_progress", type(failure).__name__, number))
            self.assertEqual(self.ctx.logger.error.call_args.args[-3:], (123, 123, "read"))
            self.ctx.logger.info.assert_called_once_with(
                "aidlc session-progress key=%s state=%s present=%s status=%d",
                digest[:8], "unavailable", "-", 503)
            self.assertEqual(self.ctx.logger.mock_calls[-1][0], "info")
            for captured in (repr(self.ctx.logger.mock_calls), json.dumps(body)):
                self.assertNotIn(self.key, captured)
                self.assertNotIn(digest, captured)

    def test_session_no_diagnostic_before_guard(self):
        identities = [{**self.identity, "auth_from_query_token": True},
                      {**self.identity, "user": "not-owner"},
                      {**self.identity, "app": "aidlc"},
                      {k: v for k, v in self.identity.items() if k != "is_dashboard_user"}]
        self.ctx.audit = Mock()
        with patch.object(self.module, "_session_progress_read", side_effect=AssertionError("handler reached")):
            for identity in identities:
                self.assert_code("FORBIDDEN", 403, identity=identity)
            with patch.object(self.module, "_GUARD_AVAILABLE", False):
                self.assert_code("GUARD_UNAVAILABLE", 503)
            with patch.object(manager, "ENABLED", False):
                self.assert_code("FORBIDDEN", 403)
            with patch.object(self.module, "is_owner_dashboard_request", side_effect=RuntimeError):
                self.assert_code("GUARD_UNAVAILABLE", 503)
        self.ctx.audit.record.assert_not_called()
        self.ctx.logger.info.assert_not_called()
        self.assertNotIn("aidlc session-progress", repr(self.ctx.logger.mock_calls))
        self.assertNotIn(self.key, repr(self.ctx.logger.mock_calls))
        self.assertNotIn(self.key_hash(self.key), repr(self.ctx.logger.mock_calls))

    def test_session_query_token_owner_denied_before_reads(self):
        with patch.object(self.module.Reader, "read", side_effect=AssertionError("read reached")):
            self.assert_code("FORBIDDEN", 403, identity={**self.identity, "auth_from_query_token": True})
        self.ctx.logger.warning.assert_called_once()

    def test_session_missing_dashboard_provenance_denied(self):
        identity = dict(self.identity)
        del identity["is_dashboard_user"]
        self.assert_code("FORBIDDEN", 403, identity=identity)
        self.ctx.logger.warning.assert_called_once()

    def test_session_all_missing_none_and_nonliteral_provenance_denied(self):
        with patch.object(self.module.Reader, "read", side_effect=AssertionError("read reached")):
            for key in self.identity:
                for remove in (True, False):
                    identity = dict(self.identity)
                    if remove:
                        del identity[key]
                    else:
                        identity[key] = None
                    with self.subTest(key=key, remove=remove):
                        self.assert_code("FORBIDDEN", 403, identity=identity)
            for key, value in (("is_dashboard_user", 1), ("auth_from_query_token", 0),
                               ("is_dashboard_user", "true"), ("auth_from_query_token", "false")):
                self.assert_code("FORBIDDEN", 403, identity={**self.identity, key: value})

    def test_session_app_token_identity_denied(self):
        self.assert_code("FORBIDDEN", 403, identity={**self.identity, "app": "aidlc", "is_dashboard_user": False})
        self.assert_code("FORBIDDEN", 403, identity={**self.identity, "app": "aidlc"})

    def test_session_guard_import_disabled_and_predicate_failure(self):
        original = builtins.__import__
        for missing in ("kiro_crew.dashboard.handlers.source_providers", "kiro_crew.apps.manager", "kiro_crew.apps.route_registry"):
            def importer(name, *args, **kwargs):
                if name == missing:
                    raise ImportError("host import failure")
                return original(name, *args, **kwargs)
            with patch("builtins.__import__", side_effect=importer):
                unavailable = load_module()
            with patch.object(self, "module", unavailable):
                self.assert_code("GUARD_UNAVAILABLE", 503)
        with patch.object(manager, "ENABLED", False):
            self.assert_code("FORBIDDEN", 403)
        with patch.object(self.module, "is_owner_dashboard_request", side_effect=RuntimeError):
            self.assert_code("GUARD_UNAVAILABLE", 503)

    def test_session_missing_header(self):
        self.assert_code("MISSING_SESSION", 400, key=None)

    def test_session_invalid_header_and_accepted_grammar(self):
        for key in ("", "dashboard:", "dashboard:a/b", "dashboard:a\n", "dashboard:" + "a" * 129,
                    "other:slot", " dashboard:chat", "dashboard:chat ", "dashboard:é"):
            with self.subTest(key=key):
                self.assert_code("MISSING_SESSION", 400, key=key)
        for key in ("dashboard:a", "dashboard:chat-example", "dashboard:second-example", "dashboard:A._:-", "dashboard:" + "a" * 128):
            self.assertEqual(self.request(key=key)[1]["state"], "unbound")

    def test_session_routed_page_is_not_conversation(self):
        self.assert_code("NOT_A_CONVERSATION", 409, key="dashboard:ui")

    def test_session_forged_unbound_has_no_key_or_hash_and_no_enumeration(self):
        key = "dashboard:forged-fixture"
        before = snapshot(self.root)
        with patch.object(self.module.os, "scandir", side_effect=AssertionError("enumeration reached")), \
                patch.object(self.module, "_receipt", side_effect=AssertionError("receipt reached")), \
                patch.object(self.module, "_providers", side_effect=AssertionError("provider reached")), \
                patch.object(self.module, "_run_reader", side_effect=AssertionError("spawn reached")):
            status, body = self.request(key=key)
        self.assertEqual((status, body["state"]), (200, "unbound"))
        self.assertEqual(body["guidance"], self.module.UNBOUND_GUIDANCE)
        self.assertNotIn(key, json.dumps(body))
        self.assertNotIn(self.key_hash(key), json.dumps(body))
        self.assertNotIn("bindingRevision", body)
        self.assertEqual(before, snapshot(self.root))

    def test_session_two_conversations_same_project_different_intents(self):
        rows = [{"uuid": "record-123", "slug": "delivery", "dirName": "delivery-selected", "status": "active"},
                {"uuid": "record-456", "slug": "design", "dirName": "design-selected", "status": "active"}]
        self.registry(rows, [r["dirName"] for r in rows])
        second = "dashboard:second-fixture"
        self.bind(second)
        self.engine_binding("design-selected", second)
        self.write_json(self.home / "session_map.json", {self.key: {"provider": "codex"}, second: {"provider": "acp"}})
        calls = []
        def run(argv, project, cancelled, **kwargs):
            calls.append((argv, kwargs["deadline"]))
            body = self.reader_body()
            body["intents"] = [{"space": "non-default", "id": r["uuid"], "displayName": r["slug"], "eligible": True} for r in rows]
            if "--intent" not in argv:
                body["state"] = "selection-required"
                del body["selected"]
            else:
                row = next(r for r in rows if r["uuid"] == argv[-1])
                body["selected"].update(id=row["uuid"], displayName=row["slug"])
            return 200, body
        with patch.object(self.module, "_run_reader", side_effect=run), patch.object(self.module.time, "monotonic", return_value=100):
            for key, identifier, provider in ((self.key, "record-123", "codex"), (second, "record-456", "kiro")):
                status, body = self.request(key=key)
                self.assertEqual((status, body["selected"]["id"], body["provider"]["label"]), (200, identifier, provider))
        self.assertEqual(len(calls), 4)
        for first, second_call in (calls[:2], calls[2:]):
            self.assertEqual(first[1], 110)
            self.assertEqual(first[1], second_call[1])
            self.assertNotIn("--intent", first[0])
            self.assertEqual(second_call[0][-2], "--intent")

    def test_session_null_intent_singleton_is_census(self):
        self.engine_binding(None)
        (self.project / "aidlc/active-space").write_text("non-default")
        (self.base / "active-intent").write_text("delivery-selected")
        with patch.object(self.module, "_run_reader", wraps=self.module._run_reader) as runner:
            status, body = self.request()
        self.assertEqual((status, body["state"]), (200, "census"))
        self.assertEqual(len(body["census"]), 1)
        self.assertNotIn("selected", body)
        runner.assert_called_once()

    def test_session_missing_engine_binding_is_project_census(self):
        self.recorded.unlink()
        with patch.object(self.module, "_run_reader", wraps=self.module._run_reader) as runner:
            status, body = self.request()
        self.assertEqual((status, body["state"]), (200, "census"))
        self.assertNotIn("selected", body)
        self.assertNotIn("--space", runner.call_args.args[0])
        self.assertRegex(body["bindingRevision"], r"^[a-f0-9]{16}$")

    def test_session_malformed_engine_binding_logs_without_private_detail(self):
        for raw in ("{private-broken", "[]", '{"space":"../private","intent":null,"boundAt":"x"}'):
            self.ctx.logger.reset_mock()
            self.recorded.write_text(raw)
            body = self.assert_code("SOURCE_MALFORMED", 503)
            self.ctx.logger.error.assert_called_once()
            self.assertIn("_session_progress", self.ctx.logger.error.call_args.args)
            self.assertNotIn("private", json.dumps(body))
            self.assertNotIn("private", str(self.ctx.logger.error.call_args))

    def test_session_converter_oserror_diagnostics_before_response(self):
        denied = PermissionError(errno.EPERM, "private detail", "private filename")
        with patch.object(self.module, "_session_progress_read", side_effect=denied):
            body = self.assert_code("SOURCE_UNREADABLE", 503)
        self.ctx.logger.error.assert_called_once()
        self.assertEqual(self.ctx.logger.error.call_args.args[1:],
                         ("_session_progress", "PermissionError", errno.EPERM, "private detail", "private filename", None, None, "source"))
        self.assertNotIn("private", json.dumps(body))

    def parity_case(self, name):
        case = next(c for c in PANEL["identities"] if c["name"] == name)
        self.registry(case["rows"], case["directories"])
        self.engine_binding(case["intent"])
        body = self.reader_body()
        body["intents"] = case["census"]
        if case["state"] == "ok":
            body["selected"].update(id=case["id"], displayName=case["census"][0]["displayName"])
        else:
            body["state"] = "empty"
            del body["selected"]
        with patch.object(self.module, "_run_reader", return_value=(200, body)):
            status, actual = self.request()
        self.assertEqual((status, actual["state"]), (case["http"], case["state"]))
        if "code" in case:
            self.assertEqual(actual["error"]["code"], case["code"])
        elif case["state"] == "ok":
            self.assertEqual(actual["selected"]["id"], case["id"])
        else:
            self.assertNotIn("selected", actual)

    def test_session_parity_dirname_present(self):
        self.parity_case("dirName-present")

    def test_session_parity_slug_hex_suffix(self):
        self.parity_case("slug-hex-suffix")

    def test_session_parity_ambiguous(self):
        self.parity_case("ambiguous")
        row = {"uuid": "record-123", "slug": "delivery", "dirName": "delivery-selected", "status": "active"}
        self.registry([row, row], ["delivery-selected"])
        self.assert_code("AMBIGUOUS_INTENT", 503)

    def test_session_parity_registry_only_census(self):
        self.parity_case("registry-only")

    def test_session_multiple_directories_for_one_row_refused(self):
        self.registry([{"uuid": "00000000-0000-0000-0000-000000001111", "slug": "shared", "status": "active"}],
                      ["shared-1111", "shared-00001111"])
        self.engine_binding("shared-1111")
        self.assert_code("AMBIGUOUS_INTENT", 503)

    def test_session_registry_changes_during_reader_refused(self):
        original = (self.base / "intents.json").read_text()
        for changed in (original.replace("delivery\"", "changed-slug\""), original + " "):
            (self.base / "intents.json").write_text(original)
            def change_registry(*args, **kwargs):
                (self.base / "intents.json").write_text(changed)
                return 200, self.reader_body()
            with patch.object(self.module, "_run_reader", side_effect=change_registry):
                self.assert_code("SOURCE_CHANGED", 503)

    def test_session_invalid_engine_timestamp_and_backend_refused(self):
        original = json.loads(self.recorded.read_text())
        for extra in ({"boundAt": "not-a-timestamp"}, {"backend": "invalid"}, {"backendConflict": 1},
                      {"space": "a" * 129}, {"space": "Main"}, {"intent": "a" * 257}, {"intent": []},
                      {"intent": "../escape"}, {"boundAt": ""}):
            self.write_json(self.recorded, {**original, **extra})
            with self.subTest(extra=extra):
                self.assert_code("SOURCE_MALFORMED", 503)
        self.write_json(self.recorded, {k: v for k, v in original.items() if k != "intent"})
        self.assert_code("SOURCE_MALFORMED", 503)

    def test_session_malformed_census_is_reader_failure(self):
        body = self.reader_body()
        for census in ([None], [{**PANEL["intent"], "eligible": 1}], [PANEL["intent"]] * 501):
            with patch.object(self.module, "_run_reader", return_value=(200, {**body, "intents": census})):
                self.assert_code("READER_MALFORMED", 502)
        self.engine_binding(None)
        with patch.object(self.module, "_run_reader", return_value=(200, {**body, "intents": [PANEL["intent"]] * 500})):
            self.assertEqual(len(self.request()[1]["census"]), 500)

    def test_session_stale_or_orphan_binding_no_fallback(self):
        self.engine_binding("unknown-record")
        self.assert_code("STALE_BINDING", 503)
        self.engine_binding("delivery-selected")
        body = self.reader_body()
        for patch_row, code in (({"eligible": False, "reason": "completed"}, "STALE_BINDING"),
                                ({"displayName": "wrong-slug"}, "SOURCE_CHANGED"), ({"id": "other"}, "SOURCE_CHANGED")):
            body["intents"] = [{**PANEL["intent"], **patch_row}]
            with patch.object(self.module, "_run_reader", return_value=(200, body)):
                self.assert_code(code, 503)
        body = self.reader_body()
        body["selected"]["id"] = "wrong-selected"
        with patch.object(self.module, "_run_reader", return_value=(200, body)) as runner:
            self.assert_code("SOURCE_CHANGED", 503)
        self.assertEqual(runner.call_count, 2)

    def test_session_invalid_stamp_and_stale_project_no_spawn(self):
        with patch.object(self.module, "_run_reader", side_effect=AssertionError("spawn reached")):
            self.stamp.unlink()
            self.assert_code("INVALID_STAMP", 409)
            self.bind(self.key, self.root / "missing-project")
            self.assert_code("SOURCE_UNREADABLE", 503)

    def test_session_engine_rebind_mid_reader_and_next_call_recovers(self):
        original = self.module._run_reader
        def rebind(*args, **kwargs):
            result = original(*args, **kwargs)
            self.engine_binding(None)
            return result
        with patch.object(self.module, "_run_reader", side_effect=rebind):
            body = self.assert_code("BINDING_CHANGED", 200)
        status, recovered = self.request()
        self.assertEqual((status, recovered["state"]), (200, "census"))
        self.assertEqual(body["bindingRevision"], recovered["bindingRevision"])
        self.assertNotIn("selected", recovered)
        # A first census can require a second reader; revalidate that return too.
        self.engine_binding("delivery-selected")
        calls = []
        def rebind_selected(argv, *args, **kwargs):
            calls.append(kwargs["deadline"])
            body = self.reader_body()
            if "--intent" not in argv:
                body["state"] = "selection-required"
                del body["selected"]
            else:
                self.engine_binding(None)
            return 200, body
        with patch.object(self.module, "_run_reader", side_effect=rebind_selected):
            self.assert_code("BINDING_CHANGED", 200)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(self.request()[1]["state"], "census")

    def test_session_app_rebind_mid_reader_and_next_call_recovers(self):
        other = self.root / "other-project"
        shutil.copytree(self.project, other)
        def rebind(*args, **kwargs):
            self.bind(self.key, other)
            return 200, self.reader_body()
        with patch.object(self.module, "_run_reader", side_effect=rebind):
            self.assert_code("BINDING_CHANGED", 200)
        status, body = self.request()
        self.assertEqual((status, body["state"], body["project"]["displayName"]), (200, "ok", "other-project"))

    def test_session_rebind_removal_and_reader_failure_discard_selected(self):
        def rebind(*args, **kwargs):
            self.recorded.unlink()
            raise self.module.Failure("READER_TIMEOUT", 504)
        with patch.object(self.module, "_run_reader", side_effect=rebind):
            self.assert_code("BINDING_CHANGED", 200)
        self.assertEqual(self.request()[1]["state"], "census")
        self.engine_binding("delivery-selected")
        app = self.bindings / (self.key_hash(self.key) + ".json")
        def remove_app(*args, **kwargs):
            app.unlink()
            return 200, self.reader_body()
        with patch.object(self.module, "_run_reader", side_effect=remove_app):
            self.assert_code("BINDING_CHANGED", 200)
        self.assertEqual(self.request()[1]["state"], "unbound")

    def test_session_revision_is_hash_of_exact_pair_and_newline(self):
        app_path = self.bindings / (self.key_hash(self.key) + ".json")
        for suffix in (b"", b" \n"):
            app_path.write_bytes(app_path.read_bytes() + suffix)
            app, engine = app_path.read_bytes(), self.recorded.read_bytes()
            expected = hashlib.sha256(app + engine + b"\n").hexdigest()[:16]
            self.assertEqual(self.request()[1]["bindingRevision"], expected)

    def test_session_keys_only_cannot_classify_linked_slot(self):
        self.write_json(self.home / "open_slots.json", {"keys": ["linked-fixture"], "ts": 1})
        before = snapshot(self.root)
        status, body = self.request(key="dashboard:linked-fixture")
        self.assertEqual((status, body["state"]), (200, "unbound"))
        self.assertNotIn("reason", body)
        self.assertEqual(before, snapshot(self.root))

    def test_session_any_query_parameter_refused_before_reads(self):
        class Multi(dict):
            def getall(self, key):
                return [self[key], self[key]]
        with patch.object(self.module.Reader, "read", side_effect=AssertionError("read reached")):
            for query in ({"session": self.key}, {"unknown": ""}, {"token": "fixture"},
                          {"project": "selected"}, {"space": "non-default", "intent": "record-123"}, Multi(session=self.key)):
                self.assert_code("INVALID_QUERY", 400, query=query)

    def test_session_binding_no_follow_and_byte_bound(self):
        app = self.bindings / (self.key_hash(self.key) + ".json")
        for path in (app, self.recorded):
            original = path.read_bytes()
            path.write_bytes(original.ljust(self.module.MAX_FILE_BYTES))
            self.assertEqual(self.request()[0], 200)
            path.write_bytes(original.ljust(self.module.MAX_FILE_BYTES + 1))
            self.assert_code("LIMIT_EXCEEDED", 503)
            path.unlink()
            backup = self.root / (path.name + ".backup")
            backup.write_bytes(original)
            path.symlink_to(backup)
            self.assert_code("UNSAFE_FILE_KIND", 503)
            path.unlink()
            os.mkfifo(path)
            self.assert_code("UNSAFE_FILE_KIND", 503)
            path.unlink()
            path.write_bytes(original)
            def unsafe_reread(*args, **kwargs):
                path.unlink()
                path.symlink_to(backup)
                return 200, self.reader_body()
            with patch.object(self.module, "_run_reader", side_effect=unsafe_reread):
                self.assert_code("UNSAFE_FILE_KIND", 503)
            path.unlink()
            path.write_bytes(original)
        original = app.read_bytes()
        for value in ([], {"projectDir": "relative"}, {"projectDir": None}):
            self.write_json(app, value)
            self.assert_code("SOURCE_MALFORMED", 503)
        app.write_bytes(original)
        # The directory bound includes the registry itself: 1 + 1999 is admitted.
        for index in range(1998):
            (self.base / f"extra-{index}").mkdir()
        self.assertEqual(self.request()[0], 200)
        (self.base / "overflow").mkdir()
        self.assert_code("LIMIT_EXCEEDED", 503)
        (self.base / "overflow").rmdir()
        rows = json.loads((self.base / "intents.json").read_text())
        rows.extend({"uuid": f"extra-{i}", "slug": f"extra-{i}", "status": "active"} for i in range(499))
        self.write_json(self.base / "intents.json", rows)
        self.assertEqual(self.request()[0], 200)
        self.write_json(self.base / "intents.json", rows + [{"uuid": "overflow", "slug": "overflow", "status": "active"}])
        self.assert_code("LIMIT_EXCEEDED", 503)


if __name__ == "__main__":
    if sys.version_info[:2] != (3, 12):
        sys.exit("Route tests require Python 3.12")
    unittest.main(verbosity=2)
