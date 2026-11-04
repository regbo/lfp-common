"""Cyclopts command-line interfaces for the worker and WebSocket server."""

from __future__ import annotations

from typing import Annotated

from cyclopts import App, Parameter

from ._generated.metadata import PACKAGE_VERSION
from .models import ServerOptions

app = App(
    name="pynect-worker",
    help="Run Pynect's local worker or proxy-fronted WebSocket server.",
    version=PACKAGE_VERSION,
)
server_app = App(
    name="pynect-server",
    help="Run Pynect's proxy-fronted WebSocket server.",
    version=PACKAGE_VERSION,
)

FlatServerOptions = Annotated[ServerOptions | None, Parameter(name="*")]


def _serve(options: ServerOptions) -> None:
    from .server import run_server

    run_server(options)


@app.command
def ipc() -> None:
    """Run the private local IPC worker from its environment configuration."""

    from .bridge import main as run_ipc_worker

    run_ipc_worker()


@app.command
def serve(options: FlatServerOptions = None) -> None:
    """Serve isolated Pynect sessions over binary WebSockets."""

    _serve(options or ServerOptions())


@server_app.default
def serve_default(options: FlatServerOptions = None) -> None:
    """Serve isolated Pynect sessions over binary WebSockets."""

    _serve(options or ServerOptions())


def main() -> None:
    """Run the multi-command worker CLI."""

    app()


def server_main() -> None:
    """Run the server-only CLI."""

    server_app()
