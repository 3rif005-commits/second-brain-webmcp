"""Filter AST + operator matrix + SQL compilation for M3 (Notion-style
databases). See `ast.py` (the filter/sort/pagination request shapes) and
`operators.py` (the property-type x filter-operator matrix and per-operator
SQL generation). Both are pure, DB-free Python — Task 12 builds the
compiler/query-builder on top of them.
"""
from __future__ import annotations
