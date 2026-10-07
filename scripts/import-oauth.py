#!/usr/bin/env python3
"""Import a downloaded Google web OAuth client JSON directly into Secret Manager."""
import argparse
import json
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("client_json", type=Path)
args = parser.parse_args()
client = json.loads(args.client_json.read_text()).get("web", {})
if not client.get("client_id") or not client.get("client_secret"):
    raise SystemExit("Expected a downloaded web OAuth client JSON file.")
payload = json.dumps({"clientId": client["client_id"], "clientSecret": client["client_secret"]})
result = subprocess.run(["gcloud", "secrets", "versions", "add", "wedding-photos-oauth",
                         "--project=wedding-490801", "--data-file=-", "--quiet"],
                        input=payload, text=True, capture_output=True)
if result.returncode:
    raise SystemExit("Secret upload failed; no credential values were printed. " + result.stderr)
print("OAuth configuration stored in Secret Manager. The app will pick it up on its next configuration refresh.")
