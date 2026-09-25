"""Owner oracle; records admission calls, not an authentication implementation."""
OWNER = True
CALLS = []


def is_owner_dashboard_request(request):
    CALLS.append(request)
    return OWNER
