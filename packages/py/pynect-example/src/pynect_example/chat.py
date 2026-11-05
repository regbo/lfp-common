"""Lazy local text generation for the chat example."""

import os
from collections.abc import Callable
from functools import cache
from threading import Lock
from typing import Any

from pynect_example.domain import ChatMessage, ChatModelStatus

MODEL_ID = "onnx-community/SmolLM2-135M-Instruct-ONNX-MHA"
MODEL_FILE = "model_q4.onnx"
MODEL_FILES = (
    "config.json",
    "merges.txt",
    f"onnx/{MODEL_FILE}",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
)
SYSTEM_MESSAGE = {"role": "system", "content": "You are a friendly assistant. Keep responses short."}
StatusReporter = Callable[[ChatModelStatus], None]

_generator_lock = Lock()
_generator_instance: Callable[..., list[dict[str, Any]]] | None = None


@cache
def prepare_chat_runtime() -> None:
    """Import native ML dependencies on Python's main thread before serving."""
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    from huggingface_hub import logging as huggingface_logging
    from huggingface_hub.utils import disable_progress_bars
    from optimum.onnxruntime import ORTModelForCausalLM  # noqa: F401
    from transformers import AutoTokenizer, pipeline  # noqa: F401
    from transformers.utils.logging import set_verbosity_error

    disable_progress_bars()
    huggingface_logging.set_verbosity_error()
    set_verbosity_error()


def load_chat_model(report: StatusReporter | None = None) -> None:
    """Load the cached or downloaded model once and report lifecycle changes."""
    global _generator_instance

    reporter = report or (lambda _status: None)
    reporter(ChatModelStatus(stage="loading", message="Loading SmolLM2"))
    if _generator_instance is not None:
        reporter(ChatModelStatus(stage="ready", message="SmolLM2 ready"))
        return

    with _generator_lock:
        if _generator_instance is not None:
            reporter(ChatModelStatus(stage="ready", message="SmolLM2 ready"))
            return

        prepare_chat_runtime()
        from huggingface_hub import snapshot_download, try_to_load_from_cache
        from optimum.onnxruntime import ORTModelForCausalLM
        from transformers import AutoTokenizer, pipeline

        cached = all(isinstance(try_to_load_from_cache(MODEL_ID, filename), str) for filename in MODEL_FILES)
        if cached:
            reporter(ChatModelStatus(stage="cache_hit", message="Using cached SmolLM2 model"))
        else:
            reporter(ChatModelStatus(stage="downloading", message="Downloading SmolLM2 from Hugging Face"))

        model_root = snapshot_download(MODEL_ID, allow_patterns=list(MODEL_FILES))
        if not cached:
            reporter(ChatModelStatus(stage="downloaded", message="Download complete; loading SmolLM2"))

        tokenizer = AutoTokenizer.from_pretrained(model_root, local_files_only=True)
        model = ORTModelForCausalLM.from_pretrained(
            model_root,
            subfolder="onnx",
            file_name=MODEL_FILE,
        )
        _generator_instance = pipeline("text-generation", model=model, tokenizer=tokenizer)
        reporter(ChatModelStatus(stage="ready", message="SmolLM2 ready"))


def generate_reply(messages: list[ChatMessage]) -> str:
    """Generate one assistant turn from the Python-owned transcript."""
    if _generator_instance is None:
        load_chat_model()
    generator = _generator_instance
    if generator is None:
        raise RuntimeError("SmolLM2 did not produce a text-generation pipeline")
    conversation = [SYSTEM_MESSAGE, *(message.model_dump() for message in messages)]
    result = generator(
        conversation,
        max_new_tokens=100,
        do_sample=False,
        repetition_penalty=1.15,
    )
    generated = result[0].get("generated_text") if result else None
    if isinstance(generated, list) and generated:
        content = generated[-1].get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
    if isinstance(generated, str) and generated.strip():
        return generated.strip()
    raise RuntimeError("The text-generation pipeline returned no assistant message")
