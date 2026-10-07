#!/usr/bin/env python3
"""Read-only live integration checks; credentials and invitation URLs stay out of output."""
import json
import subprocess
import urllib.error
import urllib.request

BASE = 'https://wedding-photos-backend-908592617843.us-central1.run.app'
def secret(name):
    return subprocess.run(['gcloud', 'secrets', 'versions', 'access', 'latest', '--secret=' + name,
        '--project=wedding-490801', '--quiet'], capture_output=True, text=True, check=True).stdout.strip()
def request(path, data=None, headers=None):
    h = {'Content-Type': 'application/json', **(headers or {})}
    req = urllib.request.Request(BASE + path, data=json.dumps(data).encode() if data is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.load(response), response.headers
    except urllib.error.HTTPError as e:
        return e.code, json.load(e), e.headers

assert request('/api/config')[0] == 200
assert request('/api/gallery')[0] == 401
assert request('/api/admin/status')[0] == 401
code, session, _ = request('/api/guest/session', {'eventKey': secret('wedding-photos-event-key')})
assert code == 200
code, gallery, _ = request('/api/gallery', headers={'Authorization': 'Bearer ' + session['token']})
assert code == 200 and isinstance(gallery['items'], list)
code, _, headers = request('/api/admin/session', {'adminKey': secret('wedding-photos-admin-key')}, {'Origin': BASE})
assert code == 200
code, owner, _ = request('/api/admin/status', headers={'Cookie': headers['Set-Cookie'].split(';')[0]})
assert code == 200
print(json.dumps({'health': 'passed', 'guestAccess': 'passed', 'ownerAccess': 'passed',
    'firestoreGallery': 'passed', 'oauthConfigured': owner['oauthConfigured'],
    'driveConnected': owner['connected'], 'uploadsOpen': owner['uploadsOpen']}, indent=2))
