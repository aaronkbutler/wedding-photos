#!/usr/bin/env python3
"""Idempotently provision the agreed wedding photo infrastructure. Never prints secrets."""
import json
import secrets
import subprocess
import time

PROJECT = "wedding-490801"
REGION = "us-central1"
ACCOUNT = f"wedding-photos@{PROJECT}.iam.gserviceaccount.com"

def run(*args, data=None, optional=False):
    for attempt in range(4):
        result = subprocess.run(["gcloud", *args, f"--project={PROJECT}", "--quiet"],
                                input=data, text=True, capture_output=True)
        if result.returncode and "concurrent policy changes" in result.stderr and attempt < 3:
            time.sleep(2 ** attempt)
            continue
        break
    if result.returncode and not optional:
        raise RuntimeError(result.stderr.strip())
    return result

def exists(*args):
    result = run(*args, optional=True)
    if result.returncode == 0:
        return True
    if "NOT_FOUND" in result.stderr or "not found" in result.stderr.lower():
        return False
    raise RuntimeError(result.stderr.strip())

run("services", "enable", "firestore.googleapis.com", "secretmanager.googleapis.com",
    "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com", "drive.googleapis.com")
databases = json.loads(run("firestore", "databases", "list", "--format=json").stdout)
if not databases:
    run("firestore", "databases", "create", "--database=(default)", f"--location={REGION}", "--type=firestore-native")
elif not any(d["name"].endswith("/(default)") for d in databases):
    raise RuntimeError("Project has a non-default database. Review free database eligibility before provisioning.")
if not exists("iam", "service-accounts", "describe", ACCOUNT):
    run("iam", "service-accounts", "create", "wedding-photos", "--display-name=Wedding Photos")
run("projects", "add-iam-policy-binding", PROJECT,
    f"--member=serviceAccount:{ACCOUNT}", "--role=roles/datastore.user", "--condition=None", "--format=none")

initial = {
    "wedding-photos-admin-key": lambda: secrets.token_urlsafe(40),
    "wedding-photos-signing-key": lambda: secrets.token_urlsafe(48),
    "wedding-photos-event-key": lambda: secrets.token_urlsafe(24),
    "wedding-photos-oauth": lambda: "{}",
    "wedding-photos-drive-refresh": None,
}
for name, generate in initial.items():
    if not exists("secrets", "describe", name):
        run("secrets", "create", name, "--replication-policy=automatic")
    versions = json.loads(run("secrets", "versions", "list", name, "--filter=state:ENABLED", "--format=json").stdout)
    if not versions and generate:
        run("secrets", "versions", "add", name, "--data-file=-", data=generate())
    run("secrets", "add-iam-policy-binding", name, f"--member=serviceAccount:{ACCOUNT}",
        "--role=roles/secretmanager.secretAccessor", "--format=none")
    if name == "wedding-photos-drive-refresh":
        run("secrets", "add-iam-policy-binding", name, f"--member=serviceAccount:{ACCOUNT}",
            "--role=roles/secretmanager.secretVersionAdder", "--format=none")

if not exists("artifacts", "repositories", "describe", "wedding-photos", f"--location={REGION}"):
    run("artifacts", "repositories", "create", "wedding-photos", f"--location={REGION}",
        "--repository-format=docker", "--description=Wedding photo application images")
print(json.dumps({"project": PROJECT, "region": REGION, "serviceAccount": ACCOUNT,
                  "status": "provisioned", "secrets": list(initial)}, indent=2))
