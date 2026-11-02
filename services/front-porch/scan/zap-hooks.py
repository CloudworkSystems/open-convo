# ZAP hooks for scan/zap-scan.mjs. They only talk to the scan target that
# zap-scan.mjs checked and passed in FRONT_PORCH_BASE.
import json
import os

BASE = os.environ['FRONT_PORCH_BASE']

# The recorded MCP exchange. /mcp isn't in openapi.json, so these requests put
# it in ZAP's site tree, and the active scan then attacks it like any path.
MCP_EXCHANGE = [
    {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
     'params': {'protocolVersion': '2025-06-18', 'capabilities': {},
                'clientInfo': {'name': 'zap-scan', 'version': '1'}}},
    {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
    {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call',
     'params': {'name': 'faq', 'arguments': {'q': 'privacy'}}},
]


def _request(body):
    host = BASE.split('://', 1)[1]
    text = json.dumps(body)
    return ('POST ' + BASE + '/mcp HTTP/1.1\r\n'
            'Host: ' + host + '\r\n'
            'Content-Type: application/json\r\n'
            'Accept: application/json, text/event-stream\r\n'
            'Content-Length: ' + str(len(text.encode('utf-8'))) + '\r\n'
            '\r\n' + text)


def zap_started(zap, target):
    for body in MCP_EXCHANGE:
        zap.core.send_request(request=_request(body), followredirects=False)


def zap_pre_shutdown(zap):
    # The list of URLs ZAP reached, which zap-scan.mjs checks against every path.
    with open('/zap/wrk/urls.txt', 'w') as f:
        f.write('\n'.join(zap.core.urls()) + '\n')
