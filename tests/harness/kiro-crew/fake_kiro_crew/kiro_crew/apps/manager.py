"""Enabled-state oracle with an ordered call record."""
ENABLED = True
CALLS = []


def is_app_enabled(name):
    CALLS.append(name)
    return ENABLED
