"""Application target that marks completion of imports for benchmarks."""

from pynect_worker_example.server import app

print("BENCHMARK_APP_READY", flush=True)

__all__ = ["app"]
