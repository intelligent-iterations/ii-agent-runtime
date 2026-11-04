"""Synthetic Responses fixture for testing upstream executor routing, never a live provider."""
import http.server
import json
import os
import shlex
import subprocess
import threading
from pathlib import Path


def prove_tool_routing(binary, home, worker, marker):
    positive = worker / 'positive-control'
    positive.write_text('worker-readable')
    positive.chmod(0o644)
    git = worker / '.git'
    git.mkdir(mode=0o700)
    os.chown(git, 65534, 65534)
    git_marker = git / 'protected'
    git_marker.write_text('synthetic-git-state')
    os.chown(git_marker, 65534, 65534)
    result_path = worker / 'probe-result.json'
    source = '\n'.join([
        'import json,os,pathlib',
        f'p=pathlib.Path({str(marker)!r})',
        'result={"uid":os.getuid(),"privateReadable":os.access(p,os.R_OK)}',
        f'result["positiveRead"]=pathlib.Path({str(positive)!r}).read_text()=="worker-readable"',
        'try:',
        f' pathlib.Path({str(git_marker)!r}).write_text("unauthorized")',
        ' result["gitWriteDenied"]=False',
        'except PermissionError: result["gitWriteDenied"]=True',
        f'pathlib.Path({str(result_path)!r}).write_text(json.dumps(result))',
        'print(json.dumps(result))',
    ])
    calls = []
    failures = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            try:
                size = int(self.headers.get('Content-Length', '0'))
                assert 0 < size <= 1048576, 'fixture request size invalid'
                request = json.loads(self.rfile.read(size))
                calls.append(request)
                assert len(calls) <= 2, 'unexpected extra fixture request'
                identity = 'fixture-response-' + str(len(calls))
                events = [{'type': 'response.created', 'response': {'id': identity}}]
                if len(calls) == 1:
                    # Fixture tool names are taken from the actual upstream schema.
                    tools = request.get('tools', [])
                    flattened = []
                    for tool in tools:
                        flattened.extend(tool.get('tools', []) if tool.get('type') == 'namespace' else [tool])
                    assert any(t.get('name') == 'exec_command' for t in flattened), 'exec_command unavailable'
                    events.append({'type': 'response.output_item.done', 'item': {
                        'type': 'function_call', 'call_id': 'fixture-call', 'name': 'exec_command',
                        'arguments': json.dumps({'cmd': 'python3 -c ' + shlex.quote(source),
                                                 'login': False, 'yield_time_ms': 10000})}})
                else:
                    events.append({'type': 'response.output_item.done', 'item': {
                        'type': 'message', 'id': 'fixture-message', 'role': 'assistant',
                        'content': [{'type': 'output_text', 'text': 'fixture complete'}]}})
                events.append({'type': 'response.completed', 'response': {'id': identity, 'usage': {
                    'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0}}})
                body = ''.join('data: ' + json.dumps(event) + '\n\n' for event in events).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as error:
                failures.append(str(error))
                self.send_error(500)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    with (home / 'config.toml').open('a') as config:
        config.write('\nmodel_provider = "fixture"\nmodel = "fixture-model"\n'
                     '[model_providers.fixture]\nname = "Synthetic fixture"\n'
                     f'base_url = "http://127.0.0.1:{server.server_port}/v1"\n'
                     'wire_api = "responses"\nrequires_openai_auth = false\n'
                     'supports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n'
                     '[features]\nhooks = false\nshell_snapshot = false\n'
                     '[permissions.ii-workshop.filesystem]\n":minimal" = "read"\n'
                     + json.dumps(str(git)) + ' = "deny"\n'
                     '[permissions.ii-workshop.filesystem.":workspace_roots"]\n"." = "write"\n'
                     '[permissions.ii-workshop.network]\nenabled = false\n')
    try:
        completed = subprocess.run([binary, '--no-daemon', '--ask-for-approval', 'never', 'exec',
            '--json', '--ephemeral', '--skip-git-repo-check', '-c', 'default_permissions="ii-workshop"',
            '--cd', str(worker), 'Run the synthetic executor fixture.'],
            cwd=worker, env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(home), 'CODEX_HOME': str(home)},
            capture_output=True, text=True, timeout=60)
        assert not failures, 'fixture error: ' + json.dumps(failures)
        assert completed.returncode == 0, 'Codex fixture failed: ' + completed.stderr[-4000:] + completed.stdout[-4000:]
        assert len(calls) == 2, 'fixture did not exercise a command result'
        result = json.loads(result_path.read_text())
        assert result == {'uid': 65534, 'privateReadable': False, 'positiveRead': True, 'gitWriteDenied': True}, 'tool boundary failed: ' + json.dumps(result)
        assert git_marker.read_text() == 'synthetic-git-state', 'Git metadata changed'
        assert result_path.stat().st_uid == 65534, 'result not owned by executor'
        return {'syntheticResponses': len(calls), **result}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
