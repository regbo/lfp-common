from __future__ import annotations

import collections.abc
import contextlib
import datetime as dt
import importlib
import inspect
import json
import keyword
import re
import sys
import types
import typing
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any

from cyclopts import App

from .models import CodegenRequest

codegen_app = App(name="pynect-codegen", help="Generate Pynect TypeScript bindings from a JSON request.")


def annotation_to_typescript(annotation: Any) -> str:
    if annotation in {
        inspect.Signature.empty,
        inspect.Parameter.empty,
        Any,
        typing.Any,
    }:
        return "unknown"
    if annotation in {None, type(None)}:
        return "null"
    primitives = {
        str: "string",
        int: "number",
        float: "number",
        complex: "{ readonly real: number; readonly imag: number }",
        bool: "boolean",
        bytes: "Uint8Array",
        bytearray: "Uint8Array",
        dt.datetime: "Date",
        dt.date: "Date",
        dt.time: "string",
        Decimal: "string",
        uuid.UUID: "string",
    }
    if annotation in primitives:
        return primitives[annotation]

    origin = typing.get_origin(annotation)
    arguments = typing.get_args(annotation)
    if origin in {typing.Union, types.UnionType}:
        return " | ".join(dict.fromkeys(annotation_to_typescript(item) for item in arguments))
    if origin is typing.Literal:
        return " | ".join(json.dumps(item) for item in arguments)
    if origin in {list, set, frozenset, collections.abc.Sequence, collections.abc.Set}:
        item = annotation_to_typescript(arguments[0]) if arguments else "unknown"
        return f"ReadonlyArray<{item}>"
    if origin is tuple:
        if len(arguments) == 2 and arguments[1] is Ellipsis:
            return f"ReadonlyArray<{annotation_to_typescript(arguments[0])}>"
        return f"readonly [{', '.join(annotation_to_typescript(item) for item in arguments)}]"
    if origin in {dict, collections.abc.Mapping}:
        key = annotation_to_typescript(arguments[0]) if arguments else "string"
        value = annotation_to_typescript(arguments[1]) if len(arguments) > 1 else "unknown"
        return f"Readonly<Record<string, {value}>>" if key == "string" else f"ReadonlyMap<{key}, {value}>"
    if origin in {collections.abc.Iterable, collections.abc.Iterator}:
        item = annotation_to_typescript(arguments[0]) if arguments else "unknown"
        return f"AsyncIterable<{item}>"
    if origin in {collections.abc.AsyncIterable, collections.abc.AsyncIterator}:
        item = annotation_to_typescript(arguments[0]) if arguments else "unknown"
        return f"AsyncIterable<{item}>"
    if origin in {collections.abc.Callable, typing.Callable}:
        if len(arguments) != 2:
            return "((...args: unknown[]) => unknown | Promise<unknown>)"
        parameter_annotations, return_annotation = arguments
        result = annotation_to_typescript(return_annotation)
        if parameter_annotations is Ellipsis:
            parameters = "...args: unknown[]"
        elif isinstance(parameter_annotations, (list, tuple)):
            parameters = ", ".join(
                f"arg{index}: {annotation_to_typescript(item)}" for index, item in enumerate(parameter_annotations)
            )
        else:
            parameters = "...args: unknown[]"
        return f"(({parameters}) => {result} | Promise<{result}>)"
    if isinstance(annotation, typing.TypeVar):
        return "unknown"
    if inspect.isclass(annotation):
        return typescript_identifier(annotation.__name__)
    forward = getattr(annotation, "__forward_arg__", None)
    if isinstance(forward, str):
        return typescript_identifier(forward.rsplit(".", 1)[-1])
    return "unknown"


def callable_signature(function: Any, *, skip_receiver: bool = False) -> str:
    try:
        signature = inspect.signature(function)
        hints = typing.get_type_hints(function, include_extras=True)
    except (NameError, TypeError, ValueError):
        return "(...args: unknown[]): Promise<unknown>"

    parameters: list[str] = []
    keyword_fields: list[str] = []
    has_varargs = False
    for index, parameter in enumerate(signature.parameters.values()):
        if skip_receiver and index == 0 and parameter.name in {"self", "cls"}:
            continue
        annotation = hints.get(parameter.name, parameter.annotation)
        value_type = annotation_to_typescript(annotation)
        name = typescript_identifier(parameter.name)
        optional = parameter.default is not inspect.Parameter.empty
        if parameter.kind is inspect.Parameter.VAR_POSITIONAL:
            parameters.append(f"...{name}: {value_type}[]")
            has_varargs = True
        elif parameter.kind is inspect.Parameter.VAR_KEYWORD:
            keyword_fields.append(f"readonly [name: string]: {value_type}")
        elif parameter.kind is inspect.Parameter.KEYWORD_ONLY:
            keyword_fields.append(f"readonly {property_name(parameter.name)}{'?' if optional else ''}: {value_type}")
        else:
            parameters.append(f"{name}{'?' if optional else ''}: {value_type}")

    if keyword_fields and not has_varargs:
        keyword_shape = "; ".join(keyword_fields)
        parameters.append(f"keywordArguments?: PythonKeywordArguments<{{ {keyword_shape} }}>")
    result = annotation_to_typescript(hints.get("return", signature.return_annotation))
    return f"({', '.join(parameters)}) => Promise<{result}>"


def inspect_module(alias: str, import_name: str) -> tuple[str, list[str]]:
    module = importlib.import_module(import_name)
    module_interface = f"{pascal_case(alias)}Module"
    declarations: list[str] = []
    members: list[str] = []

    for name, value in sorted(vars(module).items()):
        if name.startswith("_"):
            continue
        if inspect.isfunction(value) and getattr(value, "__module__", None) == module.__name__:
            members.append(f"  readonly {property_name(name)}: {callable_signature(value)};")
        elif inspect.isclass(value) and getattr(value, "__module__", None) == module.__name__:
            class_name = typescript_identifier(value.__name__)
            if typing.is_typeddict(value):
                declarations.append(render_typed_dict_interface(class_name, value))
            else:
                declarations.append(render_class_interface(class_name, value))
                constructor = callable_signature(value.__init__, skip_receiver=True)
                members.append(f"  readonly {property_name(name)}: {replace_promise_result(constructor, class_name)};")

    if not members:
        members.append("  readonly [name: string]: unknown;")
    declarations.append(f"export interface {module_interface} {{\n" + "\n".join(members) + "\n}")
    return module_interface, declarations


def render_typed_dict_interface(class_name: str, value: type[Any]) -> str:
    try:
        annotations = typing.get_type_hints(value, include_extras=True)
    except (NameError, TypeError):
        annotations = getattr(value, "__annotations__", {})
    required_keys = getattr(value, "__required_keys__", frozenset(annotations))
    members = [
        f"  readonly {property_name(name)}{'?' if name not in required_keys else ''}: "
        f"{annotation_to_typescript(annotation)};"
        for name, annotation in sorted(annotations.items())
    ]
    return f"export interface {class_name} {{\n" + "\n".join(members) + "\n}"


def render_class_interface(class_name: str, value: type[Any]) -> str:
    members: list[str] = []
    annotations = getattr(value, "__annotations__", {})
    with contextlib.suppress(NameError, TypeError):
        annotations = typing.get_type_hints(value, include_extras=True)
    for name, annotation in sorted(annotations.items()):
        if not name.startswith("_"):
            members.append(f"  readonly {property_name(name)}: Promise<{annotation_to_typescript(annotation)}>;")
    for name, function in sorted(inspect.getmembers(value, predicate=inspect.isfunction)):
        if not name.startswith("_"):
            members.append(f"  readonly {property_name(name)}: {callable_signature(function, skip_receiver=True)};")
    members.extend(
        [
            "  $release(): Promise<void>;",
            "  $repr(): Promise<string>;",
            "  $value(): Promise<unknown>;",
        ]
    )
    return f"export interface {class_name} {{\n" + "\n".join(members) + "\n}"


def render(settings: CodegenRequest) -> str:
    class_name = typescript_identifier(settings.class_name)
    declarations: list[str] = []
    module_types: dict[str, str] = {}
    for alias, import_name in settings.modules.items():
        module_type, module_declarations = inspect_module(alias, import_name)
        module_types[alias] = module_type
        declarations.extend(module_declarations)

    defaults = bridge_defaults(settings)

    module_map = "\n".join(
        f"  readonly {property_name(alias)}: {module_type};" for alias, module_type in module_types.items()
    )
    getters = "\n\n".join(
        f"  get {typescript_identifier(alias)}(): Promise<{module_type}> {{\n"
        f"    return this.venv.import({json.dumps(alias)});\n"
        "  }"
        for alias, module_type in module_types.items()
        if is_typescript_identifier(alias)
    )
    serialized_defaults = json.dumps(defaults, indent=2)
    type_imports = ["CreateVenvOptions", "PythonVenv"]
    if any("PythonKeywordArguments" in declaration for declaration in declarations):
        type_imports.append("PythonKeywordArguments")
    pynect_import = ", ".join(["createVenv", *(f"type {name}" for name in type_imports)])

    sections = [
        "// Generated by pynect-worker codegen. Do not edit by hand.",
        f"import {{ {pynect_import} }} from 'pynect';",
        *declarations,
        f"export interface {class_name}Modules {{\n{module_map}\n}}",
        f"const defaults = {serialized_defaults} as const satisfies CreateVenvOptions;",
        (
            f"export class {class_name} implements AsyncDisposable {{\n"
            f"  readonly venv: PythonVenv<{class_name}Modules>;\n\n"
            "  constructor(options: CreateVenvOptions = {}) {\n"
            f"    this.venv = createVenv<{class_name}Modules>({{\n"
            "      ...defaults,\n"
            "      ...options,\n"
            "      modules: { ...defaults.modules, ...options.modules },\n"
            "    });\n"
            "  }\n\n"
            f"{getters}\n\n"
            "  close(): Promise<void> {\n"
            "    return this.venv.close();\n"
            "  }\n\n"
            "  async [Symbol.asyncDispose](): Promise<void> {\n"
            "    await this.close();\n"
            "  }\n"
            "}"
        ),
    ]
    return "\n\n".join(section for section in sections if section) + "\n"


def bridge_defaults(settings: CodegenRequest) -> dict[str, Any]:
    return {"modules": settings.modules, **settings.bridge}


def replace_promise_result(signature: str, result: str) -> str:
    return re.sub(r"Promise<.*>$", f"Promise<{result}>", signature)


def property_name(value: str) -> str:
    return value if is_typescript_identifier(value) else json.dumps(value)


def is_typescript_identifier(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", value)) and value not in {
        "break",
        "case",
        "catch",
        "class",
        "const",
        "continue",
        "debugger",
        "default",
        "delete",
        "do",
        "else",
        "export",
        "extends",
        "finally",
        "for",
        "function",
        "if",
        "import",
        "in",
        "instanceof",
        "let",
        "new",
        "return",
        "super",
        "switch",
        "this",
        "throw",
        "try",
        "typeof",
        "var",
        "void",
        "while",
        "with",
        "yield",
    }


def typescript_identifier(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_$]", "_", value)
    if not normalized or normalized[0].isdigit() or keyword.iskeyword(normalized):
        normalized = f"_{normalized}"
    return normalized


def pascal_case(value: str) -> str:
    parts = re.findall(r"[A-Za-z0-9]+", value)
    result = "".join(part[:1].upper() + part[1:] for part in parts) or "Python"
    return f"_{result}" if result[0].isdigit() else result


def generate(settings: CodegenRequest) -> Path:
    root = settings.root
    add_import_path(root)
    project = settings.bridge.get("project")
    if isinstance(project, str):
        project_path = Path(project)
        if not project_path.is_absolute():
            project_path = root / project_path
        add_import_path(project_path.resolve())

    output_path = settings.out
    if not output_path.is_absolute():
        output_path = root / output_path
    output_path = output_path.resolve()
    generated = render(settings)
    if output_path.is_file() and output_path.read_text(encoding="utf-8") == generated:
        return output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(generated, encoding="utf-8", newline="\n")
    return output_path


def add_import_path(path: Path) -> None:
    value = str(path)
    if value not in sys.path:
        sys.path.insert(0, value)


@codegen_app.default
def run(request: str) -> None:
    """Generate bindings from one JSON request."""

    print(generate(CodegenRequest.model_validate_json(request)))


def main() -> None:
    codegen_app()


if __name__ == "__main__":
    main()
