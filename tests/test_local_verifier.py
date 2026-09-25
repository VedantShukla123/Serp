"""Retired: the conservative local mock verifier was removed from the product.

ProofGate runs real integrations only — without credentials every service
entrypoint raises RuntimeError instead of fabricating verdicts.
See tests/test_verifier_logic.py for the current verifier-logic coverage.
"""
