"""
pynect - type_inspector.py
Python-side module introspection utility.

Called by TypeGenerator via the embedded Python runtime:
  result_json = pynect_runtime.inspect_module('pandas')

Returns a JSON-serializable dict matching RawModuleInspection in TypeGenerator.ts.
"""

from __future__ import annotations

import inspect
import json
import importlib
import sys
import re
import types
import typing
from typing import Any, Dict, List, Optional, Tuple, get_type_hints

# helpers

_SKIP_NAMES = frozenset({
    '__builtins__', '__cached__', '__loader__', '__spec__',
    '__path__', '__package__', '__initializing__',
})

_SKIP_DUNDER = frozenset({
    '__new__', '__del__', '__class__', '__dict__', '__weakref__',
    '__module__', '__slots__', '__abstractmethods__',
})


def _get_annotation(annotation: Any) -> str:
    """Convert an annotation object to a string."""
    if annotation is inspect.Parameter.empty:
        return 'Any'
    if annotation is type(None):
        return 'None'
    if isinstance(annotation, str):
        return annotation
    if hasattr(annotation, '__name__'):
        return annotation.__name__
    if hasattr(annotation, '__origin__'):
        # Generic alias (List[str], Dict[str, int], ...)
        return _stringify_generic(annotation)
    return str(annotation).replace('typing.', '')


def _stringify_generic(tp: Any) -> str:
    """Stringify a typing generic alias."""
    origin = getattr(tp, '__origin__', None)
    args   = getattr(tp, '__args__', ())

    if origin is None:
        return str(tp)

    origin_name = getattr(origin, '__name__', None) or str(origin)

    # typing.Union[X, Y] -> 'Union[X, Y]'
    if origin is typing.Union:
        parts = [_get_annotation(a) for a in args]
        return f"Union[{', '.join(parts)}]"

    # typing.Optional[X]  is Union[X, None]
    if len(args) == 2 and type(None) in args:
        non_none = [a for a in args if a is not type(None)][0]
        return f"Optional[{_get_annotation(non_none)}]"

    if args:
        args_str = ', '.join(_get_annotation(a) for a in args)
        return f"{origin_name}[{args_str}]"

    return origin_name


def _get_type_hints_safe(obj: Any) -> Dict[str, Any]:
    try:
        return get_type_hints(obj) or {}
    except Exception:
        return {}


def _param_kind_name(kind: inspect.Parameter.kind) -> str:
    return {
        inspect.Parameter.POSITIONAL_ONLY:            'positional_only',
        inspect.Parameter.POSITIONAL_OR_KEYWORD:      'positional_or_keyword',
        inspect.Parameter.VAR_POSITIONAL:              'var_positional',
        inspect.Parameter.KEYWORD_ONLY:               'keyword_only',
        inspect.Parameter.VAR_KEYWORD:                'var_keyword',
    }.get(kind, 'positional_or_keyword')


# Inspect functions / methods

def _inspect_callable(obj: Any, name: str) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        'name':           name,
        'qual_name':      getattr(obj, '__qualname__', name),
        'docstring':      inspect.getdoc(obj) or '',
        'parameters':     [],
        'return_type':    'Any',
        'is_method':      inspect.ismethod(obj),
        'is_class_method': isinstance(
            inspect.getattr_static(obj, '__func__', None) or obj,
            classmethod),
        'is_static_method': isinstance(obj, staticmethod),
        'is_coroutine':   inspect.iscoroutinefunction(obj),
        'is_generator':   inspect.isgeneratorfunction(obj),
        'exported':       bool(getattr(obj, '__pynect_export__', False)),
        'excluded':       bool(getattr(obj, '__pynect_exclude__', False)),
        'fully_annotated': False,
    }

    try:
        sig  = inspect.signature(obj)
        hints = _get_type_hints_safe(obj)

        params = []
        for pname, param in sig.parameters.items():
            annotation = hints.get(pname) or param.annotation
            ann_str    = _get_annotation(annotation)
            has_def    = param.default is not inspect.Parameter.empty
            params.append({
                'name':       pname,
                'type':       ann_str,
                'annotation': ann_str,
                'optional':   has_def or param.kind in (
                    inspect.Parameter.VAR_POSITIONAL,
                    inspect.Parameter.VAR_KEYWORD,
                ),
                'has_default': has_def,
                'default':    repr(param.default) if has_def else None,
                'kind':       _param_kind_name(param.kind),
            })

        result['parameters'] = params

        ret_ann = hints.get('return') or sig.return_annotation
        result['return_type'] = _get_annotation(ret_ann)
        result['fully_annotated'] = (
            sig.return_annotation is not inspect.Signature.empty
            and all(
                parameter.annotation is not inspect.Parameter.empty
                for parameter in sig.parameters.values()
                if parameter.name not in {'self', 'cls'}
            )
        )

    except (ValueError, TypeError):
        pass

    return result


# Inspect classes

def _inspect_class(cls: type) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        'name':         cls.__name__,
        'qual_name':    getattr(cls, '__qualname__', cls.__name__),
        'docstring':    inspect.getdoc(cls) or '',
        'bases':        [b.__name__ for b in cls.__bases__ if b is not object],
        'members':      [],
        'methods':      [],
        'properties':   [],
        'class_methods': [],
        'static_methods': [],
        'exported':       bool(getattr(cls, '__pynect_export__', False)),
        'excluded':       bool(getattr(cls, '__pynect_exclude__', False)),
        'fully_annotated': bool(getattr(cls, '__annotations__', {})),
    }

    hints = _get_type_hints_safe(cls)

    for mname in dir(cls):
        if mname in _SKIP_DUNDER:
            continue
        if mname.startswith('__') and mname.endswith('__'):
            if mname not in ('__init__', '__len__', '__str__', '__repr__',
                             '__iter__', '__getitem__', '__setitem__',
                             '__contains__', '__enter__', '__exit__'):
                continue

        try:
            raw_attr = inspect.getattr_static(cls, mname)
        except AttributeError:
            continue

        if isinstance(raw_attr, staticmethod):
            inner = raw_attr.__func__
            result['static_methods'].append(_inspect_callable(inner, mname))

        elif isinstance(raw_attr, classmethod):
            inner = raw_attr.__func__
            r = _inspect_callable(inner, mname)
            r['is_class_method'] = True
            result['class_methods'].append(r)

        elif isinstance(raw_attr, property):
            ann = hints.get(mname) or raw_attr.fget and getattr(raw_attr.fget, '__annotations__', {}).get('return', 'Any')
            result['properties'].append({
                'name':      mname,
                'type':      _get_annotation(ann) if ann else 'Any',
                'read_only': raw_attr.fset is None,
                'docstring': inspect.getdoc(raw_attr) or '',
                'fully_annotated': ann is not None and ann != 'Any',
                'exported': bool(getattr(raw_attr.fget, '__pynect_export__', False)),
                'excluded': bool(getattr(raw_attr.fget, '__pynect_exclude__', False)),
            })

        elif callable(raw_attr) or inspect.isfunction(raw_attr):
            result['methods'].append(_inspect_callable(raw_attr, mname))

        else:
            ann = hints.get(mname, 'Any')
            result['members'].append({
                'name':      mname,
                'type':      _get_annotation(ann),
                'read_only': False,
                'docstring': '',
                'fully_annotated': mname in hints,
                'exported': False,
                'excluded': False,
            })

    return result


# Main entry point

def inspect_module(module_name: str) -> Dict[str, Any]:
    """
    Inspect a Python module and return a dict matching RawModuleInspection.
    """
    result: Dict[str, Any] = {
        'name':       module_name,
        'file':       None,
        'docstring':  '',
        'version':    None,
        'functions':  [],
        'classes':    [],
        'constants':  [],
        'submodules': [],
    }

    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:
        result['error'] = f'ImportError: {exc}'
        return result
    except Exception as exc:
        result['error'] = f'{type(exc).__name__}: {exc}'
        return result

    result['file']     = getattr(module, '__file__', None)
    result['docstring'] = inspect.getdoc(module) or ''
    result['version']  = getattr(module, '__version__', None) or getattr(module, 'VERSION', None)

    for name in dir(module):
        if name in _SKIP_NAMES:
            continue
        if name.startswith('__'):
            continue

        try:
            obj = getattr(module, name)
        except AttributeError:
            continue

        # Sub-module
        if isinstance(obj, types.ModuleType):
            result['submodules'].append(name)

        # Class
        elif inspect.isclass(obj):
            result['classes'].append(_inspect_class(obj))

        # Function / builtin
        elif callable(obj) or inspect.isbuiltin(obj):
            result['functions'].append(_inspect_callable(obj, name))

        # Constant / value
        else:
            ann_type = type(obj).__name__
            result['constants'].append({
                'name':      name,
                'type':      ann_type,
                'read_only': True,
                'docstring': '',
                'fully_annotated': name in getattr(module, '__annotations__', {}),
                'exported': bool(getattr(obj, '__pynect_export__', False)),
                'excluded': bool(getattr(obj, '__pynect_exclude__', False)),
            })

    return result


def inspect_module_json(module_name: str) -> str:
    """Return inspect_module result as a JSON string."""
    return json.dumps(inspect_module(module_name), default=str)


# Direct execution for debugging

if __name__ == '__main__':
    import sys as _sys
    if len(_sys.argv) >= 4 and _sys.argv[1] == '--file':
        from ast_inspector import inspect_file_json

        print(inspect_file_json(_sys.argv[2], _sys.argv[3]))
    else:
        mod = _sys.argv[1] if len(_sys.argv) > 1 else 'os'
        print(inspect_module_json(mod))
