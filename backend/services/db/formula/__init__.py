"""The formula language front end: lexer -> AST -> Pratt parser.

Milestone 8a (Task 23) — parsing only. No type checking, no evaluation, no
builtins, no dependency extraction, no materialisation; those are later tasks
(spec §7.2's "one tree, three visitors" — the type checker, evaluator and
dependency extractor all consume the `ast.Node` tree this package produces).

Public surface: `parse()` and `FormulaSyntaxError` for callers that just want a
tree, plus the full AST node set and `walk()` for callers (later tasks) that
need to traverse or construct trees directly (e.g. tests, the type checker).
"""
from __future__ import annotations

from .ast import (
    AnyNode,
    Binary,
    Call,
    Conditional,
    Lambda,
    Let,
    ListLiteral,
    Literal,
    MethodCall,
    Node,
    PropertyRef,
    Unary,
    Variable,
    walk,
)
from .lexer import FormulaSyntaxError, Token, TokenKind, tokenize
from .parser import MAX_PARSE_DEPTH, parse
from .types import FType, PROPERTY_TYPE_TO_FTYPE, unify
from .typecheck import CheckResult, FormulaTypeError, FUNCTION_SIGNATURES, check
from .deps import (
    FormulaCycleError,
    Graph,
    PropertyDef,
    build_graph,
    max_reference_depth,
    referenced_properties,
    topological_order,
)
from .values import EMPTY, FValue, Page, Person, is_empty, stringify, truthy, as_number
from .evaluator import EvalContext, FormulaEvalError, evaluate, make_now
from . import functions as functions

__all__ = [
    "parse",
    "tokenize",
    "walk",
    "FormulaSyntaxError",
    "MAX_PARSE_DEPTH",
    "Token",
    "TokenKind",
    "Node",
    "AnyNode",
    "Literal",
    "ListLiteral",
    "PropertyRef",
    "Variable",
    "Unary",
    "Binary",
    "Conditional",
    "Call",
    "MethodCall",
    "Lambda",
    "Let",
    # Milestone 8b (Task 24): type system, type checker, dependency graph.
    "FType",
    "PROPERTY_TYPE_TO_FTYPE",
    "unify",
    "check",
    "CheckResult",
    "FormulaTypeError",
    "FUNCTION_SIGNATURES",
    "referenced_properties",
    "build_graph",
    "topological_order",
    "max_reference_depth",
    "FormulaCycleError",
    "Graph",
    "PropertyDef",
    # Milestone 8c (Task 25): value representation, evaluator, builtins.
    "EMPTY",
    "FValue",
    "Page",
    "Person",
    "is_empty",
    "truthy",
    "as_number",
    "stringify",
    "EvalContext",
    "FormulaEvalError",
    "evaluate",
    "make_now",
    "functions",
]
