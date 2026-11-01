/**
 * pynect - Thread Pool Implementation
 * Worker thread management for executing Python code off the event loop.
 */

#include "thread_pool.h"
#include "gil_guard.h"

#include <Python.h>
#include <algorithm>
#include <cassert>
#include <stdexcept>
#include <iostream>

namespace pynect {

// Constructor / Destructor

PythonThreadPool::PythonThreadPool(uint32_t numThreads, uint32_t maxQueueSize)
  : _numThreads(numThreads > 0 ? numThreads : 1)
  , _maxQueueSize(maxQueueSize > 0 ? maxQueueSize : 1000)
{
  // Validate parameters
  if (_numThreads > 64) {
    std::cerr << "[pynect] Warning: Thread pool size " << _numThreads
              << " is very large. Consider using <= 16 threads.\n";
  }
}

PythonThreadPool::~PythonThreadPool() {
  if (_running.load()) {
    forceShutdown();
  }
}

// Initialization

void PythonThreadPool::initialize(Napi::Env env) {
  if (_running.load()) {
    throw std::runtime_error("PythonThreadPool already initialized");
  }

  // Create a ThreadSafeFunction for delivering results back to the JS event loop.
  // This is the safe way to call JS functions from non-JS threads.
  _tsfn = Napi::ThreadSafeFunction::New(
    env,
    Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),  // dummy JS function
    "PythonThreadPoolCallback",
    0,   // unlimited queue size
    1    // initial thread count (we manage threads ourselves)
  );
  _env = env;
  _tsfn.Unref(env);

  _running.store(true);
  _draining.store(false);

  // Spawn worker threads
  _threads.reserve(_numThreads);
  for (uint32_t i = 0; i < _numThreads; ++i) {
    _threads.emplace_back(&PythonThreadPool::_workerThread, this, i);
  }
}

// Task Submission

uint64_t PythonThreadPool::submit(
  std::function<TaskResult()> work,
  std::function<void(TaskResult)> callback,
  uint32_t timeoutMs,
  std::string cancelKey
) {
  if (!_running.load()) {
    TaskResult errorResult;
    errorResult.success = false;
    errorResult.errorType = "RuntimeError";
    errorResult.errorMessage = "Thread pool is shut down";
    errorResult.errorTraceback = "";
    callback(std::move(errorResult));
    return 0;
  }

  // Check queue capacity
  {
    std::lock_guard<std::mutex> lock(_queueMutex);
    if (_queue.size() >= _maxQueueSize) {
      // Backpressure: queue is full
      TaskResult errorResult;
      errorResult.success = false;
      errorResult.errorType = "RuntimeError";
      errorResult.errorMessage = "Python thread pool queue is full (max: " +
                                  std::to_string(_maxQueueSize) + "). " +
                                  "Consider increasing threadPoolSize or maxQueueSize.";
      errorResult.errorTraceback = "";
      callback(std::move(errorResult));
      return 0;
    }
  }

  uint64_t taskId = _nextTaskId.fetch_add(1, std::memory_order_relaxed);

  PythonTask task;
  task.id = taskId;
  task.work = std::move(work);
  task.callback = std::move(callback);
  task.submittedAt = std::chrono::steady_clock::now();
  task.timeoutMs = timeoutMs;
  task.cancelKey = std::move(cancelKey);

  // Keep Node alive only while a submitted task still owes JavaScript a result.
  if (_pendingResults.fetch_add(1, std::memory_order_acq_rel) == 0) {
    _tsfn.Ref(_env);
  }

  {
    std::lock_guard<std::mutex> lock(_queueMutex);
    _queue.push_back(std::move(task));
    _stats.totalTasksSubmitted.fetch_add(1, std::memory_order_relaxed);
    _stats.currentQueueSize.fetch_add(1, std::memory_order_relaxed);
  }

  _queueCv.notify_one();
  return taskId;
}

bool PythonThreadPool::cancel(const std::string& cancelKey) {
  if (cancelKey.empty()) return false;
  PythonTask task;
  {
    std::lock_guard<std::mutex> lock(_queueMutex);
    auto found = std::find_if(_queue.begin(), _queue.end(), [&cancelKey](const PythonTask& candidate) {
      return candidate.cancelKey == cancelKey;
    });
    if (found == _queue.end()) return false;
    task = std::move(*found);
    _queue.erase(found);
    _stats.currentQueueSize.fetch_sub(1, std::memory_order_relaxed);
    _stats.totalTasksFailed.fetch_add(1, std::memory_order_relaxed);
  }
  TaskResult cancelled;
  cancelled.success = false;
  cancelled.errorType = "CancelledError";
  cancelled.errorMessage = "Python call was cancelled before execution";
  _postResult(task.id, std::move(cancelled), std::move(task.callback));
  if (_draining.load()) _drainCv.notify_all();
  return true;
}

// Worker Thread

void PythonThreadPool::_workerThread(uint32_t threadId) {
  // Give the thread a name for debugging
  // Note: thread naming is platform-specific
#ifdef __linux__
  pthread_setname_np(pthread_self(), ("pynect-worker-" + std::to_string(threadId)).c_str());
#endif

  while (_running.load()) {
    PythonTask task;

    // Wait for a task
    {
      std::unique_lock<std::mutex> lock(_queueMutex);
      _queueCv.wait(lock, [this] {
        return !_queue.empty() || !_running.load();
      });

      if (!_running.load() && _queue.empty()) {
        break;
      }

      if (_queue.empty()) {
        continue;
      }

      task = std::move(_queue.front());
      _queue.pop_front();
      _stats.currentQueueSize.fetch_sub(1, std::memory_order_relaxed);
    }

    {
      GILAcquire gil;
      _executeTask(std::move(task));
    }
  }
}

void PythonThreadPool::_executeTask(PythonTask task) {
  _stats.activeThreads.fetch_add(1, std::memory_order_relaxed);
  const auto startTime = std::chrono::steady_clock::now();
  TaskResult result;

  try {
    if (_isTimedOut(task)) {
      result.success = false;
      result.errorType = "TimeoutError";
      result.errorMessage = "Python task timed out after " +
        std::to_string(task.timeoutMs) + "ms in queue";
      _stats.totalTasksTimedOut.fetch_add(1, std::memory_order_relaxed);
    } else {
      result = task.work();
    }
  } catch (const std::exception& e) {
    result.success = false;
    result.errorType = "RuntimeError";
    result.errorMessage = std::string("C++ exception in worker thread: ") + e.what();
  } catch (...) {
    result.success = false;
    result.errorType = "RuntimeError";
    result.errorMessage = "Unknown C++ exception in worker thread";
  }

  const auto durationUs = std::chrono::duration_cast<std::chrono::microseconds>(
    std::chrono::steady_clock::now() - startTime
  ).count();
  _stats.totalExecutionTimeUs.fetch_add(static_cast<uint64_t>(durationUs), std::memory_order_relaxed);
  if (result.success) _stats.totalTasksCompleted.fetch_add(1, std::memory_order_relaxed);
  else _stats.totalTasksFailed.fetch_add(1, std::memory_order_relaxed);
  _stats.activeThreads.fetch_sub(1, std::memory_order_relaxed);
  _postResult(task.id, std::move(result), std::move(task.callback));

  if (_draining.load()) _drainCv.notify_all();
}

void PythonThreadPool::pumpUntil(const std::atomic<bool>& completed) {
  PyThreadState* state = PyEval_SaveThread();
  while (!completed.load(std::memory_order_acquire) && _running.load()) {
    PythonTask task;
    bool hasTask = false;
    {
      std::unique_lock<std::mutex> lock(_queueMutex);
      _queueCv.wait(lock, [this, &completed] {
        return completed.load(std::memory_order_acquire) ||
          !_queue.empty() || !_running.load();
      });
      if (!completed.load(std::memory_order_acquire) && !_queue.empty()) {
        task = std::move(_queue.front());
        _queue.pop_front();
        _stats.currentQueueSize.fetch_sub(1, std::memory_order_relaxed);
        hasTask = true;
      }
    }
    if (hasTask) {
      PyEval_RestoreThread(state);
      _executeTask(std::move(task));
      state = PyEval_SaveThread();
    }
  }
  PyEval_RestoreThread(state);
}

void PythonThreadPool::notifyWaiters() {
  _queueCv.notify_all();
}

// Result Delivery

void PythonThreadPool::_postResult(
  uint64_t taskId,
  TaskResult result,
  std::function<void(TaskResult)> callback
) {
  // Package the callback + result into a heap allocation
  // that will be freed in the JS thread
  auto* payload = new std::pair<std::function<void(TaskResult)>, TaskResult>(
    std::move(callback),
    std::move(result)
  );

  // Use ThreadSafeFunction to invoke the callback in the JS event loop
  napi_status status = _tsfn.NonBlockingCall(
    payload,
    [this](Napi::Env env, Napi::Function jsCallback, void* data) {
      auto* p = static_cast<std::pair<std::function<void(TaskResult)>, TaskResult>*>(data);
      try {
        p->first(std::move(p->second));
      } catch (...) {
        // Don't let JS callback exceptions crash the worker
      }
      delete p;
      _resultDelivered(env);
    }
  );

  if (status != napi_ok) {
    // This can happen during shutdown; just clean up
    auto* p = static_cast<std::pair<std::function<void(TaskResult)>, TaskResult>*>(payload);
    try {
      // Try to call with error result
      TaskResult shutdownResult;
      shutdownResult.success = false;
      shutdownResult.errorType = "RuntimeError";
      shutdownResult.errorMessage = "Thread pool shut down while task was running";
      p->first(std::move(shutdownResult));
    } catch (...) {}
    delete p;
    _pendingResults.fetch_sub(1, std::memory_order_acq_rel);
  }
}

void PythonThreadPool::_resultDelivered(Napi::Env env) {
  if (_pendingResults.fetch_sub(1, std::memory_order_acq_rel) == 1) {
    _tsfn.Unref(env);
  }
}

// Timeout Check

bool PythonThreadPool::_isTimedOut(const PythonTask& task) const {
  if (task.timeoutMs == 0) return false;

  auto now = std::chrono::steady_clock::now();
  auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
    now - task.submittedAt
  ).count();

  return elapsed >= static_cast<long long>(task.timeoutMs);
}

// Resize

void PythonThreadPool::resize(uint32_t newNumThreads) {
  if (!_running.load()) return;
  if (newNumThreads == 0) newNumThreads = 1;

  // For simplicity: add threads if growing, remove by setting flag if shrinking
  // A production implementation would use a more sophisticated approach
  uint32_t current = static_cast<uint32_t>(_threads.size());

  if (newNumThreads > current) {
    for (uint32_t i = current; i < newNumThreads; ++i) {
      _threads.emplace_back(&PythonThreadPool::_workerThread, this, i);
    }
  }
  // Shrinking is complex and rarely needed; skip for now
  _numThreads = newNumThreads;
}

// Shutdown

void PythonThreadPool::shutdown() {
  if (!_running.load()) return;

  // Drain the queue first
  _draining.store(true);
  {
    std::unique_lock<std::mutex> lock(_queueMutex);
    _drainCv.wait_for(lock, std::chrono::seconds(30), [this] {
      return _queue.empty() && _stats.activeThreads.load() == 0;
    });
  }
  _draining.store(false);

  forceShutdown();
}

void PythonThreadPool::forceShutdown() {
  if (!_running.load()) return;

  _running.store(false);
  _queueCv.notify_all();

  // Wait for all threads to finish
  for (auto& thread : _threads) {
    if (thread.joinable()) {
      thread.join();
    }
  }
  _threads.clear();

  // Release ThreadSafeFunction
  _tsfn.Release();
}

// Queue Size

size_t PythonThreadPool::getQueueSize() const {
  std::lock_guard<std::mutex> lock(_queueMutex);
  return _queue.size();
}

} // namespace pynect
