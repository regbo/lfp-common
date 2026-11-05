print("BENCHMARK_START python", flush=True)

import json
import sys
import time


def main(warmup_iterations: int, measured_iterations: int) -> None:
    """Measure the weather operation with the same JSON response payload."""
    from pynect_example.domain import WeatherQuery, observe_weather

    query = WeatherQuery()
    print(json.dumps({"event": "ready"}), flush=True)

    def operation() -> str:
        return observe_weather(query).model_dump_json()

    first = operation()
    if json.loads(first)["location"] != query.location:
        raise RuntimeError("Native get_weather baseline returned an unexpected location")
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
