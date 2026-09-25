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
import json
import os
from pathlib import Path
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

    def test_only_two_get_routes(self):
        self.assertEqual([(r.method, r.path) for r in self.module.register_routes(self.ctx)],
                         [("GET", "/projects"), ("GET", "/progress")])

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
            clock = SimpleNamespace(monotonic=Mock(side_effect=[100.0, 109.999, 110.0]), sleep=Mock())
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
                self.assertEqual(clock.monotonic.call_count, 3)
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


if __name__ == "__main__":
    if sys.version_info[:2] != (3, 12):
        sys.exit("Route tests require Python 3.12")
    unittest.main(verbosity=2)
