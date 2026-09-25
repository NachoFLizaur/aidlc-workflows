import json
from dataclasses import dataclass
from types import SimpleNamespace


@dataclass
class AppRoute:
    method: str
    path: str
    handler: object


def json_response(body, *, status=200, headers=None):
    return SimpleNamespace(status=status, text=json.dumps(body), headers=headers or {})


web = SimpleNamespace(json_response=json_response)
