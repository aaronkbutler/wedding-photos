#!/usr/bin/env python3
"""Exercise the live Drive upload path with generated, disposable media.

Requires the album to be connected and uploads already open. This script never
changes that setting. Generated items are hidden in a finally block; originals
remain in Drive for inspection. No credentials or signed media URLs are printed.
Run with --run; add --large for a valid MP4 padded beyond Cloud Run's 32 MiB
fixed-response boundary. The optional video fixture requires ffmpeg.
"""
import argparse
import hashlib
import json
from pathlib import Path
import secrets
import shutil
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib


BASE = 'https://wedding-photos-backend-908592617843.us-central1.run.app'
PROJECT = 'wedding-490801'
GCLOUD = shutil.which('gcloud') or '/Users/aaronkbutler/Desktop/google-cloud-sdk/bin/gcloud'


class CheckFailed(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = urllib.request.build_opener(NoRedirect())


def require(condition, message):
    if not condition:
        raise CheckFailed(message)


def secret(name):
    result = subprocess.run([GCLOUD, 'secrets', 'versions', 'access', 'latest',
                             '--secret=' + name, '--project=' + PROJECT, '--quiet'],
                            capture_output=True, text=True)
    require(result.returncode == 0, 'Could not access the required app secret.')
    return result.stdout.strip()


def request(path, data=None, headers=None, method=None):
    url = path if path.startswith('https://') else BASE + path
    target = urllib.parse.urlsplit(url)
    require(target.scheme == 'https' and target.netloc == urllib.parse.urlsplit(BASE).netloc,
            'Refusing a request outside the configured backend.')
    request_headers = dict(headers or {})
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        request_headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with HTTP.open(req, timeout=180) as response:
            return response.status, response.read(), response.headers
    except urllib.error.HTTPError as response:
        return response.code, response.read(), response.headers
    except (urllib.error.URLError, TimeoutError, OSError):
        raise CheckFailed('A live request failed at the network layer.') from None


def api(path, data=None, headers=None, method=None, expected=200):
    status, body, response_headers = request(path, data, headers, method)
    try:
        value = json.loads(body)
    except (ValueError, UnicodeError):
        raise CheckFailed('API returned a non-JSON response (HTTP %s).' % status) from None
    error = value.get('error', {}).get('code', 'unexpected_status')
    require(status == expected, 'API check failed: HTTP %s (%s).' % (status, error))
    return value, response_headers


def png_fixture():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    width, height = 128, 128
    rows = b''.join(b'\0' + bytes(channel for x in range(width)
                                    for channel in (122 + x // 2, 92 + y // 2, 97))
                    for y in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def video_fixture():
    ffmpeg = shutil.which('ffmpeg')
    require(bool(ffmpeg), 'The optional video fixture requires ffmpeg.')
    with tempfile.TemporaryDirectory(prefix='wedding-photos-test-') as folder:
        path = Path(folder) / 'synthetic.mp4'
        result = subprocess.run([ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error',
                                 '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
                                 '-t', '1', '-c:v', 'mpeg4', '-q:v', '4',
                                 '-movflags', '+faststart', str(path)], capture_output=True)
        require(result.returncode == 0, 'ffmpeg could not generate the synthetic video.')
        data = path.read_bytes()
    # A legal MP4 free-space atom preserves playback while testing large streaming
    # without recording or uploading any personal media.
    target_size = 34 * 1024 * 1024
    padding_size = target_size - len(data)
    require(padding_size >= 8, 'Generated video exceeded the expected fixture size.')
    return data + struct.pack('>I4s', padding_size, b'free') + bytes(padding_size - 8)


def find_item(upload_id, guest):
    cursor = None
    for _ in range(100):
        query = '?limit=48' + ('&cursor=' + urllib.parse.quote(cursor, safe='') if cursor else '')
        page, _ = api('/api/gallery' + query, headers=guest)
        for item in page['items']:
            if item['id'] == upload_id:
                return item
        cursor = page.get('nextCursor')
        if not cursor:
            return None
    raise CheckFailed('Gallery pagination exceeded the test limit.')


def run(large=False):
    # Generate fixtures before touching the live album.
    fixtures = [('png', 'image/png', png_fixture())]
    if large:
        fixtures.append(('mp4', 'video/mp4', video_fixture()))
    event_key = secret('wedding-photos-event-key')
    uploader, _ = api('/api/guest/session', {'eventKey': event_key})
    viewer, _ = api('/api/guest/session', {'eventKey': event_key})
    guest = {'Authorization': 'Bearer ' + uploader['token']}
    second_guest = {'Authorization': 'Bearer ' + viewer['token']}
    _, owner_headers = api('/api/admin/session', {'adminKey': secret('wedding-photos-admin-key')},
                          {'Origin': BASE})
    owner = {'Cookie': owner_headers['Set-Cookie'].split(';')[0], 'Origin': BASE}
    status, _ = api('/api/admin/status', headers=owner)
    require(status['connected'] and status['uploadsOpen'],
            'Connect Google Drive and open uploads before running the test.')
    created = []
    results = []
    cleanup_errors = 0
    try:
        for extension, mime, data in fixtures:
            label = 'synthetic-' + extension
            metadata = {'name': 'wedding-photos-integration-' + secrets.token_hex(6) + '.' + extension,
                        'mimeType': mime, 'size': len(data), 'guestName': 'Album setup test',
                        'caption': 'Generated test media; hidden after verification.',
                        'uploadKey': secrets.token_urlsafe(24)}
            upload, _ = api('/api/uploads', metadata, guest)
            row = {'id': upload['id'], 'headers': {**guest, 'X-Upload-Token': upload['uploadToken']},
                   'complete': False, 'hidden': False}
            created.append(row)
            path = '/api/uploads/' + row['id']
            offset = 0
            duplicate_checked = False
            while offset < len(data):
                end = min(offset + upload['chunkBytes'], len(data))
                headers = {**row['headers'], 'Content-Type': 'application/octet-stream',
                           'Content-Range': 'bytes %s-%s/%s' % (offset, end - 1, len(data))}
                progress, _ = api(path, data[offset:end], headers, 'PUT')
                require(progress['offset'] == end, 'Uploaded chunk returned an incorrect saved offset.')
                row['complete'] = progress['complete']
                if not duplicate_checked:
                    duplicate, _ = api(path, data[offset:end], headers, 'PUT')
                    require(duplicate['offset'] == end and duplicate['complete'] == progress['complete'],
                            'Replayed chunk changed the saved offset or completion state.')
                    duplicate_checked = True
                offset = end
            progress, _ = api(path, headers=row['headers'])
            require(progress['complete'] and progress['offset'] == len(data), 'Upload did not complete.')
            row['complete'] = True
            repeated, _ = api('/api/uploads', metadata, guest)
            require(repeated['id'] == row['id'] and repeated['complete'],
                    'Retrying upload creation did not return the same completed file.')
            item = find_item(row['id'], second_guest)
            require(item is not None, 'The second guest cannot see the completed upload.')
            require(item['size'] == len(data) and item['name'] == metadata['name'],
                    'Shared gallery metadata differs from the uploaded file.')
            code, saved, download_headers = request(item['downloadUrl'])
            require(code == 200 and hashlib.sha256(saved).digest() == hashlib.sha256(data).digest(),
                    'Downloaded original differs from the uploaded bytes.')
            require('attachment' in download_headers.get('Content-Disposition', ''),
                    'Original download did not include its download disposition.')
            range_end = min(1023, len(data) - 1)
            code, partial, range_headers = request(item['mediaUrl'], headers={'Range': 'bytes=0-%s' % range_end})
            require(code == 206 and partial == data[:range_end + 1], 'Media byte-range playback check failed.')
            require(range_headers.get('Content-Range') == 'bytes 0-%s/%s' % (range_end, len(data)),
                    'Media response returned an incorrect byte range.')
            preview = 'not_checked'
            if extension == 'png':
                for attempt in range(6):
                    code, image, thumbnail_headers = request(item['thumbnailUrl'])
                    if code == 200:
                        require(bool(image) and thumbnail_headers.get('Content-Type', '').startswith('image/'),
                                'Thumbnail response is not an image.')
                        preview = 'passed'
                        break
                    require(code == 404, 'Thumbnail request failed (HTTP %s).' % code)
                    preview = 'pending'
                    if attempt < 5:
                        time.sleep(2)
            api('/api/admin/media/' + row['id'], {'hidden': True}, owner)
            row['hidden'] = True
            require(find_item(row['id'], second_guest) is None, 'Hidden test media remains in the guest gallery.')
            require(request(item['mediaUrl'])[0] == 404 and request(item['downloadUrl'])[0] == 404,
                    'Previously signed links still expose the hidden test media.')
            result = {'fixture': label, 'bytes': len(data), 'upload': 'passed', 'duplicateChunk': 'passed',
                      'idempotentCreate': 'passed', 'secondGuestGallery': 'passed',
                      'downloadHash': 'passed', 'mediaRange': 'passed', 'thumbnail': preview,
                      'hiddenRevocation': 'passed'}
            results.append(result)
            print(json.dumps(result), flush=True)
    finally:
        for row in created:
            if row['hidden']:
                continue
            try:
                if not row['complete']:
                    progress, _ = api('/api/uploads/' + row['id'], headers=row['headers'])
                    row['complete'] = progress['complete']
                if row['complete']:
                    api('/api/admin/media/' + row['id'], {'hidden': True}, owner)
                else:
                    api('/api/uploads/' + row['id'], headers=row['headers'], method='DELETE')
            except CheckFailed:
                cleanup_errors += 1
        print(json.dumps({'cleanup': 'passed' if not cleanup_errors else 'needs_attention',
                          'generatedRecords': len(created), 'cleanupErrors': cleanup_errors}), flush=True)
    require(cleanup_errors == 0, 'Some generated test records need owner cleanup.')
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='Run against the already-open live album.')
    parser.add_argument('--large', action='store_true', help='Also test a valid 34 MiB synthetic MP4.')
    args = parser.parse_args()
    if not args.run:
        parser.error('Specify --run to write generated test files to the connected Drive.')
    try:
        run(large=args.large)
    except CheckFailed as error:
        print(json.dumps({'result': 'failed', 'reason': str(error)}))
        raise SystemExit(1) from None
    except Exception as error:
        # Third-party exceptions can contain signed URLs; print only the class.
        print(json.dumps({'result': 'failed', 'reason': 'Unexpected ' + type(error).__name__}))
        raise SystemExit(1) from None
