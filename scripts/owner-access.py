#!/usr/bin/env python3
"""Write a private owner handoff file and Wix snippet without printing access keys."""
import html
import os
from pathlib import Path
import subprocess
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
def value(*args):
    result = subprocess.run(['gcloud', *args, '--project=wedding-490801', '--quiet'], capture_output=True, text=True, check=True)
    return result.stdout.strip()

base = 'https://wedding-photos-backend-908592617843.us-central1.run.app'
key = value('secrets', 'versions', 'access', 'latest', '--secret=wedding-photos-admin-key')
event = value('secrets', 'versions', 'access', 'latest', '--secret=wedding-photos-event-key')
owner = base + '/admin#key=' + quote(key, safe='')
guest = 'https://aaronkbutler.github.io/wedding-photos/#event=' + quote(event, safe='')
local = ROOT / '.local'
local.mkdir(mode=0o700, exist_ok=True)
page = local / 'owner-access.html'
page.write_text('<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Private wedding album access</title><style>body{font:18px/1.7 Georgia;max-width:650px;margin:80px auto;padding:20px;background:#fffaf8;color:#33272a}a{color:#7a5c61}</style><h1>Your wedding album</h1><p>This file contains your private owner sign-in link. Keep it on your computer.</p><p><a rel="noreferrer" href="' + html.escape(owner, quote=True) + '">Open owner controls</a></p><p><a rel="noreferrer" href="' + html.escape(guest, quote=True) + '">Open guest album</a></p>', encoding='utf-8')
os.chmod(page, 0o600)
embed = local / 'wix-embed.txt'
embed.write_text('Paste this complete URL into Wix\'s Embed a site element:\n\n' + guest + '\n\nOptional HTML embed:\n\n<iframe src="' + html.escape(guest, quote=True) + '" title="Raquel and Aaron wedding photo album" width="100%" height="1100" style="border:0" allow="fullscreen" referrerpolicy="no-referrer"></iframe>\n', encoding='utf-8')
os.chmod(embed, 0o600)
print('Private owner handoff: ' + str(page))
print('Wix embed instructions: ' + str(embed))
