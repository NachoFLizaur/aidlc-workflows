#!__PYTHON__ -IB
"""Disposable dispatcher/delegate process topology with real pipes and signals.

The test replaces the shebang and makes only its scratch copy executable.
All writes are test-owned; no Crew gateway, workflow actions or network.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def child(mode):
    if mode == "stdout":
        while True:
            os.write(1, b"x" * 8192)
    if mode == "stderr":
        while True:
            os.write(2, b"x" * 8192)
    if mode == "both":
        while True:
            os.write(1, b"x" * 4096)
            os.write(2, b"x" * 4096)
    if mode == "closed-pipes":
        os.close(1)
        os.close(2)
    time.sleep(60)


def main():
    if sys.argv[1:2] == ["--child"]:
        child(sys.argv[2])
        return
    project = Path.cwd()
    config = json.loads((project / "fake-config.json").read_text())
    mode = config["mode"]
    if mode == "orphan":
        delegate = subprocess.Popen([sys.executable, "-I", "-B", __file__, "--child", "hang"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (project / "child-pids.json").write_text(json.dumps({"parent": os.getpid(), "child": delegate.pid}))
        print(json.dumps(config["body"]))
        return
    if mode in {"hang", "stdout", "stderr", "both", "closed-pipes"}:
        delegate = subprocess.Popen([sys.executable, "-I", "-B", __file__, "--child", mode])

        def terminate(signum, frame):
            try:
                delegate.wait(timeout=0.3)
            except subprocess.TimeoutExpired:
                delegate.kill()
                delegate.wait()
            sys.exit(0)

        signal.signal(signal.SIGTERM, terminate)
        (project / "child-pids.json").write_text(json.dumps({"parent": os.getpid(), "child": delegate.pid}))
        if mode == "closed-pipes":
            os.close(1)
            os.close(2)
        delegate.wait()
        return
    if mode == "ignore-term":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        (project / "child-pids.json").write_text(json.dumps({"parent": os.getpid()}))
        time.sleep(60)
        return
    if mode == "malformed":
        print("not JSON")
        return
    body = config["body"]
    if mode == "environment":
        body = {**body, "environment": dict(os.environ), "cwd": str(project), "argv": sys.argv[1:]}
    print(json.dumps(body))
    sys.exit(config.get("exit", 0))


if __name__ == "__main__":
    main()
