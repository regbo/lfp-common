print("BENCHMARK_START python", flush=True)

import json
import sys
import time


def main(warmup_iterations: int, measured_iterations: int) -> None:
    """Measure the model-list operation with the same JSON response payload."""
    from pynect_example.catalog import MODEL_COUNT, ModelFilters, filter_models

    filters = ModelFilters()
    print(json.dumps({"event": "ready"}), flush=True)

    def operation() -> str:
        models = filter_models(filters)
        return json.dumps([model.model_dump(mode="json") for model in models], separators=(",", ":"))

    first = operation()
    if len(json.loads(first)) != MODEL_COUNT:
        raise RuntimeError("Native list_models baseline returned an unexpected count")
    print(
        json.dumps({"event": "first-response"}),
        flush=True,
    )

    for _ in range(warmup_iterations):
        operation()

    warm_samples_ms: list[float] = []
    for _ in range(measured_iterations):
        started_at = time.perf_counter_ns()
        operation()
        warm_samples_ms.append((time.perf_counter_ns() - started_at) / 1_000_000)
    print(json.dumps({"event": "complete", "warmSamplesMs": warm_samples_ms}), flush=True)


if __name__ == "__main__":
    main(int(sys.argv[1]), int(sys.argv[2]))
