"""Python handler, schema, and IPC adapters for Pynect."""

from pynect_worker._generated.metadata import PACKAGE_NAME, PACKAGE_VERSION
from pynect_worker.handlers import ws_handler
from pynect_worker.websocket import AsyncJsonWebsocketConsumer

__all__ = ["AsyncJsonWebsocketConsumer", "PACKAGE_NAME", "PACKAGE_VERSION", "ws_handler"]
