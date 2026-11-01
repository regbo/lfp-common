/**
 * pynect - Thread Pool Header
 * Manages a pool of worker threads for executing Python code
 * without blocking the Node.js event loop.
 *
 * Design:
 * - Worker threads acquire the GIL before running Python
 * - Tasks are queued using a lock-free MPMC queue
 * - Results are delivered back to Node.js via libuv async handles
 * - Backpressure is applied when queue exceeds maxQueueSize
 */

#pragma once

#include <napi.h>
#include <functional>
#include <memory>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <deque>
#include <atomic>
#include <string>
#include <vector>
#include <chrono>

namespace pynect {

/**
 * Task result - carries either a success value or an error.
 */
struct TaskResult {
  bool success = false;
  std::string resultJson;   // JSON-encoded result for JS
  std::string errorType;    // Python exception type
  std::string errorMessage; // Python exception message
  std::string errorTraceback; // Full Python traceback
  uint32_t objectId = 0;    // For Python object references
  bool isObject = false;    // Whether result is a Python object ref
};

/**
 * A task to be executed in the Python thread pool.
 */
struct PythonTask {
  /** Unique task ID for tracking */
  uint64_t id;
  /** The actual Python work to do (runs with GIL held) */
  std::function<TaskResult()> work;
  /** Callback invoked in the event loop thread with the result */
  std::function<void(TaskResult)> callback;
  /** Timestamp when task was submitted (for timeout tracking) */
  std::chrono::steady_clock::time_point submittedAt;
  /** Timeout in milliseconds (0 = no timeout) */
  uint32_t timeoutMs;
  /** Optional external cancellation key. */
  std::string cancelKey;
};

/**
 * Pool statistics for monitoring.
 */
struct PoolStats {
  std::atomic<uint64_t> totalTasksSubmitted{0};
  std::atomic<uint64_t> totalTasksCompleted{0};
  std::atomic<uint64_t> totalTasksFailed{0};
  std::atomic<uint64_t> totalTasksTimedOut{0};
  std::atomic<uint64_t> currentQueueSize{0};
  std::atomic<uint32_t> activeThreads{0};
  std::atomic<uint64_t> totalExecutionTimeUs{0};
};

/**
 * PythonThreadPool - manages N worker threads that execute Python tasks.
 *
 * Thread lifecycle:
 * 1. Worker thread starts and calls PyEval_RestoreThread to get GIL state
 * 2. Worker enters wait loop (releases GIL while waiting for work)
 * 3. When task arrives, worker acquires GIL, executes task, releases GIL
 * 4. Result is posted back to JS via libuv
 */
class PythonThreadPool {
public:
  explicit PythonThreadPool(uint32_t numThreads = 4, uint32_t maxQueueSize = 1000);
  ~PythonThreadPool();

  // Non-copyable, non-movable
  PythonThreadPool(const PythonThreadPool&) = delete;
  PythonThreadPool& operator=(const PythonThreadPool&) = delete;
  PythonThreadPool(PythonThreadPool&&) = delete;
  PythonThreadPool& operator=(PythonThreadPool&&) = delete;

  /**
   * Initialize the thread pool. Must be called from the main thread
   * after Python is initialized (Py_Initialize() called).
   */
  void initialize(Napi::Env env);

  /**
   * Submit a task to the pool. Thread-safe.
   *
   * @param work - Function to run with GIL held in a worker thread
   * @param callback - Function to call in event loop with result
   * @param timeoutMs - Task timeout in milliseconds (0 = no timeout)
   * @returns task ID, or 0 if queue is full
   */
  uint64_t submit(
    std::function<TaskResult()> work,
    std::function<void(TaskResult)> callback,
    uint32_t timeoutMs = 0,
    std::string cancelKey = {}
  );

  /** Cancel a task that has not started. */
  bool cancel(const std::string& cancelKey);

  /**
   * Resize the thread pool. Blocks until all queued tasks complete.
   */
  void resize(uint32_t newNumThreads);

  /**
   * Graceful shutdown - waits for all queued tasks to complete.
   */
  void shutdown();

  /**
   * Force shutdown - cancels queued tasks, waits for active tasks.
   */
  void forceShutdown();

  /** Get current pool statistics */
  const PoolStats& getStats() const noexcept { return _stats; }

  /** Get number of pending tasks in queue */
  size_t getQueueSize() const;

  /** Get number of active worker threads */
  uint32_t getActiveThreadCount() const noexcept { return _stats.activeThreads.load(); }

  /** Get total thread count */
  uint32_t getThreadCount() const noexcept { return static_cast<uint32_t>(_threads.size()); }

  /** Check if pool is running */
  bool isRunning() const noexcept { return _running.load(); }

  /**
   * Release the GIL and keep servicing queued Python work until a JavaScript
   * callback completes. This preserves progress for reentrant calls even with
   * a one-thread pool.
   */
  void pumpUntil(const std::atomic<bool>& completed);

  /** Wake workers that may be waiting for callback completion. */
  void notifyWaiters();

private:
  /** Worker thread entry point */
  void _workerThread(uint32_t threadId);

  /** Execute and deliver one task while the caller holds the GIL. */
  void _executeTask(PythonTask task);

  /** Post result back to event loop via libuv */
  void _postResult(uint64_t taskId, TaskResult result, std::function<void(TaskResult)> callback);

  /** Allow process exit while idle without dropping callbacks for active tasks. */
  void _resultDelivered(Napi::Env env);

  /** Check and handle task timeout */
  bool _isTimedOut(const PythonTask& task) const;

  uint32_t _numThreads;
  uint32_t _maxQueueSize;
  std::atomic<bool> _running{false};
  std::atomic<bool> _draining{false};
  std::atomic<uint64_t> _nextTaskId{1};

  // Task queue
  std::deque<PythonTask> _queue;
  mutable std::mutex _queueMutex;
  std::condition_variable _queueCv;
  std::condition_variable _drainCv;

  // Worker threads
  std::vector<std::thread> _threads;

  // libuv async handle for posting results back to JS
  // (Using Napi::ThreadSafeFunction for safe cross-thread callback)
  Napi::ThreadSafeFunction _tsfn;
  napi_env _env{nullptr};
  std::atomic<uint32_t> _pendingResults{0};

  // Statistics
  PoolStats _stats;
};

} // namespace pynect
