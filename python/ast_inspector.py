"""Static Python module inspection for safe TypeScript declaration generation."""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any


def _annotation(node: ast.expr | None) -> str:
    if node is None:
        return "Any"
    try:
        return ast.unparse(node).replace("typing.", "")
    except Exception:
        return "Any"


def _decorator_name(node: ast.expr) -> str:
    if isinstance(node, ast.Call):
        return _decorator_name(node.func)
    if isinstance(node, ast.Attribute):
        return f"{_decorator_name(node.value)}.{node.attr}".strip(".")
    if isinstance(node, ast.Name):
        return node.id
    return ""


def _decorators(node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) -> set[str]:
    return {_decorator_name(item) for item in node.decorator_list}


def _has_decorator(names: set[str], leaf: str) -> bool:
    return any(name == leaf or name.endswith(f".{leaf}") for name in names)


def _default_text(node: ast.expr | None) -> str | None:
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except Exception:
        return None


def _parameters(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[dict[str, Any]]:
    arguments = node.args
    positional = [*arguments.posonlyargs, *arguments.args]
    positional_defaults: list[ast.expr | None] = [None] * (
        len(positional) - len(arguments.defaults)
    ) + list(arguments.defaults)
    result: list[dict[str, Any]] = []

    def add(argument: ast.arg, kind: str, default: ast.expr | None = None) -> None:
        has_default = default is not None
        result.append(
            {
                "name": argument.arg,
                "type": _annotation(argument.annotation),
                "annotation": _annotation(argument.annotation),
                "optional": has_default or kind in {"var_positional", "var_keyword"},
                "has_default": has_default,
                "default": _default_text(default),
                "kind": kind,
            }
        )

    positional_only = len(arguments.posonlyargs)
    for index, (argument, default) in enumerate(zip(positional, positional_defaults)):
        kind = "positional_only" if index < positional_only else "positional_or_keyword"
        add(argument, kind, default)
    if arguments.vararg is not None:
        add(arguments.vararg, "var_positional")
    for argument, default in zip(arguments.kwonlyargs, arguments.kw_defaults):
        add(argument, "keyword_only", default)
    if arguments.kwarg is not None:
        add(arguments.kwarg, "var_keyword")
    return result


def _callable(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    *,
    qualified_name: str | None = None,
) -> dict[str, Any]:
    decorators = _decorators(node)
    parameters = _parameters(node)
    return {
        "name": node.name,
        "qual_name": qualified_name or node.name,
        "docstring": ast.get_docstring(node) or "",
        "parameters": parameters,
        "return_type": _annotation(node.returns),
        "is_method": qualified_name is not None,
        "is_class_method": _has_decorator(decorators, "classmethod"),
        "is_static_method": _has_decorator(decorators, "staticmethod"),
        "is_coroutine": isinstance(node, ast.AsyncFunctionDef),
        "is_generator": any(isinstance(item, (ast.Yield, ast.YieldFrom)) for item in ast.walk(node)),
        "exported": _has_decorator(decorators, "export"),
        "excluded": _has_decorator(decorators, "exclude"),
        "fully_typed": node.returns is not None
        and all(
            parameter["type"] != "Any"
            for parameter in parameters
            if parameter["name"] not in {"self", "cls"}
        ),
    }


def _class(node: ast.ClassDef) -> dict[str, Any]:
    decorators = _decorators(node)
    result: dict[str, Any] = {
        "name": node.name,
        "qual_name": node.name,
        "docstring": ast.get_docstring(node) or "",
        "bases": [_annotation(base) for base in node.bases],
        "members": [],
        "methods": [],
        "properties": [],
        "class_methods": [],
        "static_methods": [],
        "exported": _has_decorator(decorators, "export"),
        "excluded": _has_decorator(decorators, "exclude"),
        "fully_typed": False,
    }
    property_setters: set[str] = set()
    for item in node.body:
        if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
            result["members"].append(
                {
                    "name": item.target.id,
                    "type": _annotation(item.annotation),
                    "read_only": False,
                    "docstring": "",
                    "fully_typed": True,
                    "exported": False,
                    "excluded": False,
                }
            )
            continue
        if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        names = _decorators(item)
        qualified = f"{node.name}.{item.name}"
        inspected = _callable(item, qualified_name=qualified)
        if any(name.endswith(".setter") for name in names):
            property_setters.add(item.name)
        elif _has_decorator(names, "property"):
            result["properties"].append(
                {
                    "name": item.name,
                    "type": _annotation(item.returns),
                    "read_only": True,
                    "docstring": ast.get_docstring(item) or "",
                    "fully_typed": item.returns is not None,
                    "exported": inspected["exported"],
                    "excluded": inspected["excluded"],
                }
            )
        elif inspected["is_static_method"]:
            result["static_methods"].append(inspected)
        elif inspected["is_class_method"]:
            result["class_methods"].append(inspected)
        else:
            result["methods"].append(inspected)
    for prop in result["properties"]:
        if prop["name"] in property_setters:
            prop["read_only"] = False
    result["fully_typed"] = bool(result["members"]) or any(
        method["fully_typed"]
        for key in ("methods", "class_methods", "static_methods")
        for method in result[key]
    )
    return result


def _literal_type(node: ast.expr | None) -> str:
    if isinstance(node, ast.Constant):
        value = node.value
        if value is None:
            return "None"
        return type(value).__name__
    if isinstance(node, (ast.List, ast.ListComp)):
        return "list[Any]"
    if isinstance(node, (ast.Dict, ast.DictComp)):
        return "dict[str, Any]"
    if isinstance(node, (ast.Tuple, ast.GeneratorExp)):
        return "tuple[Any]"
    if isinstance(node, (ast.Set, ast.SetComp)):
        return "set[Any]"
    return "Any"


def inspect_file(file_path: str, module_name: str) -> dict[str, Any]:
    path = Path(file_path).resolve()
    source = path.read_text(encoding="utf-8-sig")
    tree = ast.parse(source, filename=str(path), type_comments=True)
    result: dict[str, Any] = {
        "name": module_name,
        "file": str(path),
        "docstring": ast.get_docstring(tree) or "",
        "version": None,
        "functions": [],
        "classes": [],
        "constants": [],
        "submodules": [],
        "inspection": "ast",
    }
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            result["functions"].append(_callable(node))
        elif isinstance(node, ast.ClassDef):
            result["classes"].append(_class(node))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            result["constants"].append(
                {
                    "name": node.target.id,
                    "type": _annotation(node.annotation),
                    "read_only": True,
                    "docstring": "",
                    "fully_typed": True,
                    "exported": False,
                    "excluded": False,
                }
            )
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if not isinstance(target, ast.Name):
                    continue
                if target.id == "__version__" and isinstance(node.value, ast.Constant):
                    result["version"] = str(node.value.value)
                result["constants"].append(
                    {
                        "name": target.id,
                        "type": _literal_type(node.value),
                        "read_only": True,
                        "docstring": "",
                        "fully_typed": False,
                        "exported": False,
                        "excluded": False,
                    }
                )
    return result


def inspect_file_json(file_path: str, module_name: str) -> str:
    return json.dumps(inspect_file(file_path, module_name), default=str)
