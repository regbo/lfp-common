"""Test harness that gives Bun deterministic control of a production Pynect server."""

from __future__ import annotations

import json
import os
import sys
import threading

from pynect_worker.models import ServerOptions
from pynect_worker.server import PynectServer


def main() -> None:
    options = ServerOptions.model_validate_json(sys.argv[1])
    server = PynectServer(options)
    thread = threading.Thread(target=server.serve_forever, name="pynect-test-server")
    thread.start()
    print(
        json.dumps({"event": "listening", "pid": os.getpid(), "url": server.url}),
        flush=True,
    )
    try:
        sys.stdin.read()
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.close()


if __name__ == "__main__":
    main()
