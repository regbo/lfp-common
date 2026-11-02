from __future__ import annotations

import argparse
import collections.abc
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
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class GeneratorSettings:
    class_name: str
    modules: dict[str, str]
    no_project: bool
    out: Path
    project: str | None
    with_requirements: tuple[str, ...]
    with_values: tuple[str, ...]


def annotation_to_typescript(annotation: Any) -> str:
    if annotation in {inspect.Signature.empty, inspect.Parameter.empty, Any, typing.Any}:
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
        return "(...args: unknown[]) => unknown | Promise<unknown>"
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
        parameters.append(
            f"keywordArguments?: PythonKeywordArguments<{{ {keyword_shape} }}>"
        )
    result = annotation_to_typescript(hints.get("return", signature.return_annotation))
    return f"({', '.join(parameters)}): Promise<{result}>"


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
            declarations.append(render_class_interface(class_name, value))
            constructor = callable_signature(value.__init__, skip_receiver=True)
            members.append(
                f"  readonly {property_name(name)}: {replace_promise_result(constructor, class_name)};"
            )

    if not members:
        members.append("  readonly [name: string]: unknown;")
    declarations.append(
        f"export interface {module_interface} {{\n" + "\n".join(members) + "\n}"
    )
    return module_interface, declarations


def render_class_interface(class_name: str, value: type[Any]) -> str:
    members: list[str] = []
    annotations = getattr(value, "__annotations__", {})
    try:
        annotations = typing.get_type_hints(value, include_extras=True)
    except (NameError, TypeError):
        pass
    for name, annotation in sorted(annotations.items()):
        if not name.startswith("_"):
            members.append(
                f"  readonly {property_name(name)}: Promise<{annotation_to_typescript(annotation)}>;"
            )
    for name, function in sorted(inspect.getmembers(value, predicate=inspect.isfunction)):
        if not name.startswith("_"):
            members.append(
                f"  readonly {property_name(name)}: {callable_signature(function, skip_receiver=True)};"
            )
    members.extend(
        [
            "  $release(): Promise<void>;",
            "  $repr(): Promise<string>;",
            "  $value(): Promise<unknown>;",
        ]
    )
    return f"export interface {class_name} {{\n" + "\n".join(members) + "\n}"


def render(settings: GeneratorSettings) -> str:
    declarations: list[str] = []
    module_types: dict[str, str] = {}
    for alias, import_name in settings.modules.items():
        module_type, module_declarations = inspect_module(alias, import_name)
        module_types[alias] = module_type
        declarations.extend(module_declarations)

    defaults: dict[str, Any] = {"modules": settings.modules}
    if settings.no_project:
        defaults["project"] = False
    elif settings.project is not None:
        defaults["project"] = settings.project
    if settings.with_values:
        defaults["with"] = list(settings.with_values)
    if settings.with_requirements:
        defaults["withRequirements"] = list(settings.with_requirements)

    module_map = "\n".join(
        f"  readonly {property_name(alias)}: {module_type};"
        for alias, module_type in module_types.items()
    )
    getters = "\n\n".join(
        "  get {name}(): Promise<{module_type}> {{\n"
        "    return this.venv.import({alias});\n"
        "  }}".format(
            name=typescript_identifier(alias),
            module_type=module_type,
            alias=json.dumps(alias),
        )
        for alias, module_type in module_types.items()
        if is_typescript_identifier(alias)
    )
    serialized_defaults = json.dumps(defaults, indent=2).replace("\n", "\n  ")

    sections = [
        "// Generated by pynect_codegen.py. Do not edit by hand.",
        "import { createVenv, type CreateVenvOptions, type PythonKeywordArguments, type PythonVenv } from 'pynect';",
        *declarations,
        f"export interface {settings.class_name}Modules {{\n{module_map}\n}}",
        f"const defaults = {serialized_defaults} as const satisfies CreateVenvOptions;",
        (
            f"export class {settings.class_name} implements AsyncDisposable {{\n"
            f"  readonly venv: PythonVenv<{settings.class_name}Modules>;\n\n"
            "  constructor(options: CreateVenvOptions = {}) {\n"
            f"    this.venv = createVenv<{settings.class_name}Modules>({{\n"
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


def replace_promise_result(signature: str, result: str) -> str:
    return re.sub(r"Promise<.*>$", f"Promise<{result}>", signature)


def property_name(value: str) -> str:
    return value if is_typescript_identifier(value) else json.dumps(value)


def is_typescript_identifier(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", value)) and value not in {
        "break", "case", "catch", "class", "const", "continue", "debugger", "default",
        "delete", "do", "else", "export", "extends", "finally", "for", "function",
        "if", "import", "in", "instanceof", "let", "new", "return", "super",
        "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with",
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


def parse_module(value: str) -> tuple[str, str]:
    alias, separator, import_name = value.partition("=")
    if not separator:
        import_name = alias
        alias = import_name.rsplit(".", 1)[-1]
    if not alias or not import_name:
        raise argparse.ArgumentTypeError("modules must be ALIAS=IMPORT_NAME or IMPORT_NAME")
    return alias, import_name


def load_settings(arguments: argparse.Namespace) -> GeneratorSettings:
    config: dict[str, Any] = {}
    if arguments.config:
        config = json.loads(Path(arguments.config).read_text(encoding="utf-8"))
    modules = dict(config.get("modules", {}))
    modules.update(dict(arguments.module or []))
    if not modules:
        raise ValueError("At least one module must be configured")
    project = arguments.project if arguments.project is not None else config.get("project")
    no_project = arguments.no_project or bool(config.get("noProject", False))
    if project is not None and no_project:
        raise ValueError("project and noProject cannot be used together")
    class_name = arguments.class_name or config.get("className") or "PythonProject"
    out = Path(arguments.out or config.get("out") or "pynect.generated.ts")
    with_values = tuple(arguments.with_values or config.get("with", []))
    with_requirements = tuple(
        arguments.with_requirements or config.get("withRequirements", [])
    )
    return GeneratorSettings(
        class_name=typescript_identifier(class_name),
        modules=modules,
        no_project=no_project,
        out=out,
        project=project,
        with_requirements=with_requirements,
        with_values=with_values,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate typed Pynect module interfaces and a lazy project class."
    )
    parser.add_argument("--module", action="append", type=parse_module)
    parser.add_argument("--config")
    parser.add_argument("--out")
    parser.add_argument("--class-name")
    project = parser.add_mutually_exclusive_group()
    project.add_argument("--project")
    project.add_argument("--no-project", action="store_true")
    parser.add_argument("--with", dest="with_values", action="append")
    parser.add_argument("--with-requirements", action="append")
    return parser


def main() -> None:
    parser = build_parser()
    arguments = parser.parse_args()
    try:
        settings = load_settings(arguments)
        working_directory = str(Path.cwd())
        if working_directory not in sys.path:
            sys.path.insert(0, working_directory)
        if settings.project:
            project_root = str(Path(settings.project).resolve())
            if project_root not in sys.path:
                sys.path.insert(0, project_root)
        output = render(settings)
        settings.out.parent.mkdir(parents=True, exist_ok=True)
        settings.out.write_text(output, encoding="utf-8", newline="\n")
    except Exception as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
