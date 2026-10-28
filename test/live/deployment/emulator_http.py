"""HTTP transport confined to a synthetic emulator on IPv4 loopback; no redirects."""
import http.client
import json
from urllib.parse import urlsplit


def read(endpoint, method, path, body=None, token='synthetic-emulator-token'):
    url = urlsplit(endpoint)
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or url.port is None
            or url.username or url.password or url.path or url.query or url.fragment):
        raise ValueError('Expected an explicit loopback HTTP emulator endpoint')
    if not path.startswith('/') or path.startswith('//'):
        raise ValueError('Expected an emulator API path')
    connection = http.client.HTTPConnection('127.0.0.1', url.port, timeout=10)
    try:
        connection.request(method, path, body=None if body is None else json.dumps(body).encode(),
                           headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
        response = connection.getresponse()
        data = response.read()
        if response.status >= 400:
            raise RuntimeError(f'{method} {path}: {response.status}: {data.decode()}')
        return data
    finally:
        connection.close()


def request(endpoint, method, path, body=None, token='synthetic-emulator-token'):
    data = read(endpoint, method, path, body, token)
    return json.loads(data) if data else {}
