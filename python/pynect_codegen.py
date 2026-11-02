# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "cyclopts>=4.25,<5",
#   "tomli>=2.2; python_version < '3.11'",
#   "tomlkit>=0.13,<1",
# ]
# ///

from __future__ import annotations

import collections.abc
import datetime as dt
import importlib
import inspect
import json
import keyword
import os
import re
import sys
import types
import typing
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any


class BridgeSettings(typing.NamedTuple):
    auto_close: bool | None
    call_timeout_ms: int | None
    project: str | typing.Literal[False] | None
    startup_timeout_ms: int | None
    uv_args: tuple[str, ...]
    validate_pydantic: bool | None
    with_editable: tuple[str, ...]
    with_requirements: tuple[str, ...]
    with_values: tuple[str, ...]


class GeneratorSettings(typing.NamedTuple):
    bridge: BridgeSettings
    class_name: str
    modules: dict[str, str]
    out: Path


class ModuleRequest(typing.NamedTuple):
    import_name: str
    alias: str | None = None


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
        return " | ".join(
            dict.fromkeys(annotation_to_typescript(item) for item in arguments)
        )
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
        value = (
            annotation_to_typescript(arguments[1]) if len(arguments) > 1 else "unknown"
        )
        return (
            f"Readonly<Record<string, {value}>>"
            if key == "string"
            else f"ReadonlyMap<{key}, {value}>"
        )
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
            keyword_fields.append(
                f"readonly {property_name(parameter.name)}{'?' if optional else ''}: {value_type}"
            )
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
        if (
            inspect.isfunction(value)
            and getattr(value, "__module__", None) == module.__name__
        ):
            members.append(
                f"  readonly {property_name(name)}: {callable_signature(value)};"
            )
        elif (
            inspect.isclass(value)
            and getattr(value, "__module__", None) == module.__name__
        ):
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
    for name, function in sorted(
        inspect.getmembers(value, predicate=inspect.isfunction)
    ):
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

    defaults = bridge_defaults(settings)

    module_map = "\n".join(
        f"  readonly {property_name(alias)}: {module_type};"
        for alias, module_type in module_types.items()
    )
    getters = "\n\n".join(
        f"  get {typescript_identifier(alias)}(): Promise<{module_type}> {{\n"
        f"    return this.venv.import({json.dumps(alias)});\n"
        "  }"
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


def bridge_defaults(settings: GeneratorSettings) -> dict[str, Any]:
    bridge = settings.bridge
    defaults: dict[str, Any] = {"modules": settings.modules}
    optional_values = {
        "autoClose": bridge.auto_close,
        "callTimeoutMs": bridge.call_timeout_ms,
        "project": bridge.project,
        "startupTimeoutMs": bridge.startup_timeout_ms,
        "validatePydantic": bridge.validate_pydantic,
    }
    defaults.update(
        (name, value) for name, value in optional_values.items() if value is not None
    )
    sequence_values = {
        "uvArgs": bridge.uv_args,
        "with": bridge.with_values,
        "withEditable": bridge.with_editable,
        "withRequirements": bridge.with_requirements,
    }
    defaults.update(
        (name, list(value)) for name, value in sequence_values.items() if value
    )
    return defaults


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


def parse_module(value: str) -> ModuleRequest:
    alias, separator, import_name = value.partition("=")
    if separator:
        if not alias or not import_name:
            raise ValueError("modules must be ALIAS=IMPORT_NAME or IMPORT_NAME")
        return ModuleRequest(import_name=import_name, alias=alias)
    if not alias:
        raise ValueError("modules must be ALIAS=IMPORT_NAME or IMPORT_NAME")
    return ModuleRequest(import_name=alias)


def resolve_modules(
    configured: Any,
    requests: list[ModuleRequest],
) -> dict[str, str]:
    if isinstance(configured, str):
        requests = [parse_module(configured), *requests]
        configured = {}
    elif isinstance(configured, (list, tuple)):
        requests = [
            parse_module(module) for module in string_sequence(configured, "modules")
        ] + requests
        configured = {}
    elif not isinstance(configured, dict):
        raise TypeError(
            "modules must be a list or an object mapping aliases to imports"
        )

    modules: dict[str, str] = {}

    def add_explicit(alias: Any, import_name: Any) -> None:
        if not isinstance(alias, str) or not alias:
            raise ValueError("module aliases must be non-empty strings")
        if not isinstance(import_name, str) or not import_name:
            raise ValueError("module import names must be non-empty strings")
        existing = modules.get(alias)
        if existing is not None and existing != import_name:
            raise ValueError(
                f"Module alias {alias!r} refers to both {existing!r} and {import_name!r}"
            )
        modules[alias] = import_name

    for alias, import_name in configured.items():
        add_explicit(alias, import_name)
    for request in requests:
        if request.alias is not None:
            add_explicit(request.alias, request.import_name)

    explicitly_imported = set(modules.values())
    automatic_imports = list(
        dict.fromkeys(
            request.import_name
            for request in requests
            if request.alias is None and request.import_name not in explicitly_imported
        )
    )
    modules.update(resolve_automatic_aliases(automatic_imports, set(modules)))
    return modules


def resolve_automatic_aliases(
    import_names: list[str],
    reserved_aliases: set[str],
) -> dict[str, str]:
    parts = [import_name.split(".") for import_name in import_names]
    depths = [1 for _ in import_names]

    while True:
        aliases = [
            "_".join(module_parts[-depth:])
            for module_parts, depth in zip(parts, depths, strict=True)
        ]
        groups: dict[str, list[int]] = {}
        for index, alias in enumerate(aliases):
            groups.setdefault(alias, []).append(index)

        conflicts = {
            alias: indexes
            for alias, indexes in groups.items()
            if alias in reserved_aliases or len(indexes) > 1
        }
        if not conflicts:
            return dict(zip(aliases, import_names, strict=True))

        for alias, indexes in conflicts.items():
            expandable = [
                index for index in indexes if depths[index] < len(parts[index])
            ]
            fixed = [index for index in indexes if index not in expandable]
            if alias in reserved_aliases:
                if fixed:
                    import_name = import_names[fixed[0]]
                    raise ValueError(
                        f"Cannot derive a unique alias for {import_name!r}; "
                        "use ALIAS=IMPORT_NAME"
                    )
            elif len(fixed) > 1 or not expandable:
                names = ", ".join(repr(import_names[index]) for index in indexes)
                raise ValueError(
                    f"Cannot derive unique aliases for {names}; use ALIAS=IMPORT_NAME"
                )

            for index in expandable:
                depths[index] += 1


def resolve_class_name(configured: Any, modules: dict[str, str]) -> str:
    if configured is not None:
        if not isinstance(configured, str) or not configured:
            raise ValueError("className must be a non-empty string")
        return typescript_identifier(configured)
    if len(modules) != 1:
        raise ValueError(
            "--class-name or className is required when generating multiple modules"
        )

    alias = next(iter(modules))
    derived = pascal_case(alias)
    return derived if derived.endswith("Python") else f"{derived}Python"


CONFIG_KEYS = {
    "autoclose": "auto_close",
    "calltimeoutms": "call_timeout_ms",
    "classname": "class_name",
    "modules": "modules",
    "out": "out",
    "project": "project",
    "startuptimeoutms": "startup_timeout_ms",
    "uvargs": "uv_args",
    "validatepydantic": "validate_pydantic",
    "with": "with_values",
    "witheditable": "with_editable",
    "withrequirements": "with_requirements",
}

ENVIRONMENT_KEYS = {
    "auto_close": "PYNECT_CODEGEN_AUTO_CLOSE",
    "call_timeout_ms": "PYNECT_CODEGEN_CALL_TIMEOUT_MS",
    "class_name": "PYNECT_CODEGEN_CLASS_NAME",
    "modules": "PYNECT_CODEGEN_MODULES",
    "out": "PYNECT_CODEGEN_OUT",
    "project": "PYNECT_CODEGEN_PROJECT",
    "startup_timeout_ms": "PYNECT_CODEGEN_STARTUP_TIMEOUT_MS",
    "uv_args": "PYNECT_CODEGEN_UV_ARGS",
    "validate_pydantic": "PYNECT_CODEGEN_VALIDATE_PYDANTIC",
    "with_editable": "PYNECT_CODEGEN_WITH_EDITABLE",
    "with_requirements": "PYNECT_CODEGEN_WITH_REQUIREMENTS",
    "with_values": "PYNECT_CODEGEN_WITH",
}

SEQUENCE_FIELDS = {"uv_args", "with_editable", "with_requirements", "with_values"}
BOOLEAN_FIELDS = {"auto_close", "validate_pydantic"}
INTEGER_FIELDS = {"call_timeout_ms", "startup_timeout_ms"}


def load_settings(
    root: Path,
    config_path: Path | None = None,
    overrides: dict[str, Any] | None = None,
) -> tuple[Path, GeneratorSettings]:
    project_root, config = load_configuration(root, config_path)
    values = normalize_config(config)
    values.update(read_environment())
    values.update(
        (name, value) for name, value in (overrides or {}).items() if value is not None
    )

    configured_modules = values.get("modules", [])
    modules = resolve_modules(configured_modules, [])
    if not modules:
        raise ValueError("At least one module must be configured")

    project = project_value(values.get("project"))
    call_timeout_ms = timeout_value(
        values.get("call_timeout_ms"), "callTimeoutMs", allow_zero=True
    )
    startup_timeout_ms = timeout_value(
        values.get("startup_timeout_ms"), "startupTimeoutMs", allow_zero=False
    )
    settings = GeneratorSettings(
        bridge=BridgeSettings(
            auto_close=optional_bool(values.get("auto_close"), "autoClose"),
            call_timeout_ms=call_timeout_ms,
            project=project,
            startup_timeout_ms=startup_timeout_ms,
            uv_args=string_sequence(values.get("uv_args", ()), "uvArgs"),
            validate_pydantic=optional_bool(
                values.get("validate_pydantic"), "validatePydantic"
            ),
            with_editable=string_sequence(
                values.get("with_editable", ()), "withEditable"
            ),
            with_requirements=string_sequence(
                values.get("with_requirements", ()), "withRequirements"
            ),
            with_values=string_sequence(values.get("with_values", ()), "with"),
        ),
        class_name=resolve_class_name(values.get("class_name"), modules),
        modules=modules,
        out=Path(path_value(values.get("out", "pynect.generated.ts"), "out")),
    )
    return project_root, settings


def normalize_config(config: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for name, value in config.items():
        key = re.sub(r"[^a-z0-9]", "", name.lower())
        field = CONFIG_KEYS.get(key)
        if field is None:
            raise ValueError(f"Unknown Pynect codegen setting: {name}")
        normalized[field] = value
    return normalized


def load_configuration(
    root: Path,
    config_path: Path | None,
) -> tuple[Path, dict[str, Any]]:
    root = root.resolve()
    configured_path = config_path
    environment_path = os.environ.get("PYNECT_CODEGEN_CONFIG")
    if configured_path is None and environment_path:
        configured_path = Path(environment_path)
    if configured_path is not None:
        path = (
            configured_path if configured_path.is_absolute() else root / configured_path
        )
        path = path.resolve()
        return path.parent, read_config_file(path)

    for directory in (root, *root.parents):
        for filename in ("pyproject.toml", "package.json"):
            candidate = directory / filename
            if candidate.is_file():
                config = read_config_file(candidate)
                if config:
                    return directory, config
    return root, {}


def read_config_file(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"Pynect config file does not exist: {path}")
    if path.suffix.lower() == ".toml":
        document = read_toml(path)
        value = nested_mapping(document, "tool", "pynect", "codegen")
    else:
        document = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(document, dict):
            raise ValueError(f"Config must contain an object: {path}")
        value = nested_mapping(document, "pynect", "codegen")
        if value is None and path.name != "package.json":
            value = document
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise TypeError(f"Pynect codegen config must be an object: {path}")
    return dict(value)


def read_toml(path: Path) -> dict[str, Any]:
    try:
        import tomllib
    except ModuleNotFoundError:
        import tomli as tomllib
    with path.open("rb") as file:
        return tomllib.load(file)


def nested_mapping(value: Any, *names: str) -> Any:
    current = value
    for name in names:
        if not isinstance(current, dict) or name not in current:
            return None
        current = current[name]
    return current


def read_environment() -> dict[str, Any]:
    values: dict[str, Any] = {}
    for field, environment_name in ENVIRONMENT_KEYS.items():
        raw = os.environ.get(environment_name)
        if raw is None:
            continue
        if field in BOOLEAN_FIELDS:
            values[field] = parse_bool(raw, environment_name)
        elif field in INTEGER_FIELDS:
            try:
                values[field] = int(raw)
            except ValueError as error:
                raise ValueError(f"{environment_name} must be an integer") from error
        elif field in SEQUENCE_FIELDS or field == "modules":
            values[field] = parse_collection(raw, environment_name)
        elif field == "project" and raw.lower() in {"false", "no-project", "none"}:
            values[field] = False
        else:
            values[field] = raw
    return values


def parse_collection(value: str, name: str) -> Any:
    stripped = value.strip()
    if stripped.startswith(("[", "{")):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError as error:
            raise ValueError(f"{name} contains invalid JSON") from error
    return [item.strip() for item in stripped.split(",") if item.strip()]


def parse_bool(value: str, name: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")


def string_sequence(value: Any, name: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if not isinstance(value, (list, tuple)) or not all(
        isinstance(item, str) and item for item in value
    ):
        raise ValueError(f"{name} must be a string or a list of non-empty strings")
    return tuple(value)


def path_value(value: Any, name: str) -> str:
    if not isinstance(value, (str, os.PathLike)) or not str(value):
        raise ValueError(f"{name} must be a non-empty path")
    return os.fspath(value)


def project_value(value: Any) -> str | typing.Literal[False] | None:
    if value is None or value is False:
        return value
    if value is True:
        raise ValueError("project must be a path or false")
    return path_value(value, "project")


def optional_bool(value: Any, name: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise TypeError(f"{name} must be true or false")
    return value


def timeout_value(value: Any, name: str, *, allow_zero: bool) -> int | None:
    if value is None:
        return None
    minimum = 0 if allow_zero else 1
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        qualifier = "zero or a positive integer" if allow_zero else "a positive integer"
        raise ValueError(f"{name} must be {qualifier}")
    return value


def generate_project(
    root: Path = Path("."),
    config_path: Path | None = None,
    overrides: dict[str, Any] | None = None,
) -> Path:
    project_root, settings = load_settings(root, config_path, overrides)
    add_import_path(project_root)
    if isinstance(settings.bridge.project, str):
        project_path = Path(settings.bridge.project)
        if not project_path.is_absolute():
            project_path = project_root / project_path
        add_import_path(project_path.resolve())

    output_path = settings.out
    if not output_path.is_absolute():
        output_path = project_root / output_path
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


def setup_development(
    root: Path,
    script_path: Path,
    *,
    build_hook: bool,
    dry_run: bool,
) -> list[str]:
    root = root.resolve()
    pyproject_path = root / "pyproject.toml"
    if not pyproject_path.is_file():
        raise FileNotFoundError(f"Python project has no pyproject.toml: {root}")
    target = script_path if script_path.is_absolute() else root / script_path
    target = target.resolve()
    try:
        relative_script = target.relative_to(root)
    except ValueError as error:
        raise ValueError(
            "The managed codegen script must be inside the Python project"
        ) from error

    source = Path(__file__).resolve()
    changes: dict[Path, str] = {target: source.read_text(encoding="utf-8")}
    command = f'uv run --script "{relative_script.as_posix()}" generate'
    settings_path = root / ".vscode" / "settings.json"
    settings = read_json_object(settings_path)
    ignored_by = json_list(settings.get("runOnSave.ignoreFilesBy", []), settings_path)
    if ".gitignore" not in ignored_by:
        ignored_by.append(".gitignore")
    settings["runOnSave.ignoreFilesBy"] = ignored_by
    commands = json_list(settings.get("runOnSave.commands", []), settings_path)
    codegen_command = {
        "globMatch": "**/*.py",
        "command": command,
        "runIn": "backend",
        "workingDirectoryAsCWD": True,
        "commandDebounce": 250,
        "async": False,
        "runningStatusMessage": "Generating Pynect bindings...",
        "finishStatusMessage": "Pynect bindings generated",
    }
    commands = [
        item
        for item in commands
        if not isinstance(item, dict) or item.get("command") != command
    ]
    commands.append(codegen_command)
    settings["runOnSave.commands"] = commands
    changes[settings_path] = format_json(settings)

    extensions_path = root / ".vscode" / "extensions.json"
    extensions = read_json_object(extensions_path)
    recommendations = json_list(extensions.get("recommendations", []), extensions_path)
    if "pucelle.run-on-save" not in recommendations:
        recommendations.append("pucelle.run-on-save")
    extensions["recommendations"] = recommendations
    changes[extensions_path] = format_json(extensions)

    notes: list[str] = []
    if build_hook:
        configured, pyproject_text = configure_hatch_build_hook(
            pyproject_path,
            relative_script,
        )
        if configured:
            changes[pyproject_path] = pyproject_text
        else:
            notes.append(
                "Build hook skipped: Hatchling is required for custom build hooks; "
                "uv_build intentionally does not run build scripts."
            )

    changed_paths = [
        path
        for path, content in changes.items()
        if not path.is_file() or path.read_text(encoding="utf-8") != content
    ]
    if not dry_run:
        for path in changed_paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(changes[path], encoding="utf-8", newline="\n")
    action = "Would update" if dry_run else "Updated"
    notes[:0] = [f"{action} {path.relative_to(root)}" for path in changed_paths]
    if not changed_paths:
        notes.insert(0, "Development setup is already current")
    return notes


def read_json_object(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(
            f"Cannot safely update JSON with comments or syntax errors: {path}"
        ) from error
    if not isinstance(value, dict):
        raise TypeError(f"Expected a JSON object: {path}")
    return value


def format_json(value: dict[str, Any]) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def json_list(value: Any, path: Path) -> list[Any]:
    if not isinstance(value, list):
        raise TypeError(f"Expected a JSON array in {path}")
    return list(value)


def configure_hatch_build_hook(
    pyproject_path: Path,
    relative_script: Path,
) -> tuple[bool, str]:
    import tomlkit

    document = tomlkit.parse(pyproject_path.read_text(encoding="utf-8"))
    build_system = document.get("build-system")
    if not isinstance(build_system, collections.abc.MutableMapping):
        return False, tomlkit.dumps(document)
    backend = build_system.get("build-backend")
    if not isinstance(backend, str) or not backend.startswith("hatchling"):
        return False, tomlkit.dumps(document)

    requires = build_system.get("requires")
    if not isinstance(requires, collections.abc.MutableSequence):
        requires = tomlkit.array()
        build_system["requires"] = requires
    tomli_requirement = "tomli>=2.2; python_version < '3.11'"
    if not any(str(requirement).startswith("tomli") for requirement in requires):
        requires.append(tomli_requirement)

    tool = document.get("tool")
    if not isinstance(tool, collections.abc.MutableMapping):
        tool = tomlkit.table()
        document["tool"] = tool
    hatch = tool.get("hatch")
    if not isinstance(hatch, collections.abc.MutableMapping):
        hatch = tomlkit.table()
        tool["hatch"] = hatch
    build = hatch.get("build")
    if not isinstance(build, collections.abc.MutableMapping):
        build = tomlkit.table()
        hatch["build"] = build
    hooks = build.get("hooks")
    if not isinstance(hooks, collections.abc.MutableMapping):
        hooks = tomlkit.table()
        build["hooks"] = hooks
    custom = hooks.get("custom")
    if not isinstance(custom, collections.abc.MutableMapping):
        custom = tomlkit.table()
        hooks["custom"] = custom
    existing_path = custom.get("path")
    hook_path = relative_script.as_posix()
    if existing_path is not None and existing_path != hook_path:
        raise ValueError(
            f"A different Hatch custom build hook is already configured: {existing_path}"
        )
    custom["path"] = hook_path
    return True, tomlkit.dumps(document)


def generate_command(
    *,
    root: Path,
    config: Path | None,
    module: list[str] | None,
    out: Path | None,
    class_name: str | None,
    project: str | None,
    no_project: bool,
    with_values: list[str] | None,
    with_editable: list[str] | None,
    with_requirements: list[str] | None,
    uv_args: list[str] | None,
    validate_pydantic: bool | None,
    auto_close: bool | None,
    startup_timeout_ms: int | None,
    call_timeout_ms: int | None,
) -> None:
    if project is not None and no_project:
        raise ValueError("--project and --no-project cannot be used together")
    overrides = {
        "auto_close": auto_close,
        "call_timeout_ms": call_timeout_ms,
        "class_name": class_name,
        "modules": module,
        "out": out,
        "project": False if no_project else project,
        "startup_timeout_ms": startup_timeout_ms,
        "uv_args": uv_args,
        "validate_pydantic": validate_pydantic,
        "with_editable": with_editable,
        "with_requirements": with_requirements,
        "with_values": with_values,
    }
    output = generate_project(root, config, overrides)
    print(output)


def main() -> None:
    global Parameter
    from cyclopts import App, Parameter

    app = App(
        help="Generate typed Pynect bindings and configure Python project development."
    )

    @app.command
    def generate(
        *,
        root: Path = Path("."),
        config: Path | None = None,
        module: typing.Annotated[list[str] | None, Parameter(name="--module")] = None,
        out: Path | None = None,
        class_name: str | None = None,
        project: str | None = None,
        no_project: typing.Annotated[bool, Parameter(negative=())] = False,
        with_values: typing.Annotated[
            list[str] | None, Parameter(name="--with")
        ] = None,
        with_editable: list[str] | None = None,
        with_requirements: list[str] | None = None,
        uv_args: list[str] | None = None,
        validate_pydantic: bool | None = None,
        auto_close: bool | None = None,
        startup_timeout_ms: int | None = None,
        call_timeout_ms: int | None = None,
    ) -> None:
        """Generate TypeScript bindings from Python modules."""
        generate_command(
            root=root,
            config=config,
            module=module,
            out=out,
            class_name=class_name,
            project=project,
            no_project=no_project,
            with_values=with_values,
            with_editable=with_editable,
            with_requirements=with_requirements,
            uv_args=uv_args,
            validate_pydantic=validate_pydantic,
            auto_close=auto_close,
            startup_timeout_ms=startup_timeout_ms,
            call_timeout_ms=call_timeout_ms,
        )

    @app.command
    def setup_dev(
        *,
        root: Path = Path("."),
        script_path: Path = Path("scripts/pynect_codegen.py"),
        build_hook: bool = True,
        dry_run: bool = False,
    ) -> None:
        """Install the self-contained generator, VS Code integration, and Hatch hook."""
        for note in setup_development(
            root,
            script_path,
            build_hook=build_hook,
            dry_run=dry_run,
        ):
            print(note)

    app()


try:
    from hatchling.builders.hooks.plugin.interface import BuildHookInterface
except ModuleNotFoundError:
    BuildHookInterface = None


if BuildHookInterface is not None:

    class CustomBuildHook(BuildHookInterface):
        def initialize(self, version: str, build_data: dict[str, Any]) -> None:
            generate_project(Path(self.root))


if __name__ == "__main__":
    main()
