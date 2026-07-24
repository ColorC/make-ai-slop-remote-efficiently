#!/usr/bin/env python3
"""Build and stage a LOFA Android candidate without touching the live OTA release."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


LOFA_ROOT = Path(__file__).resolve().parents[2]
APP_ROOT = LOFA_ROOT / "app"
ANDROID_ROOT = APP_ROOT / "android"
OMNI_ROOT = LOFA_ROOT.parent / "omnicompany"
CANDIDATE_ROOT = OMNI_ROOT / "data" / "android" / "candidates"
RELEASE_ROOT = OMNI_ROOT / "data" / "android" / "releases"


def _run(command: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _apksigner() -> Path | None:
    sdk = Path(os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME") or LOFA_ROOT / "tools" / "android-sdk")
    build_tools = sdk / "build-tools"
    if not build_tools.is_dir():
        return None
    filename = "apksigner.bat" if os.name == "nt" else "apksigner"
    matches = sorted(build_tools.glob(f"*/{filename}"), reverse=True)
    return matches[0] if matches else None


def _certificate_digest(apk: Path) -> str:
    signer = _apksigner()
    if signer is None:
        raise RuntimeError("apksigner is unavailable; signature compatibility cannot be verified")
    completed = subprocess.run(
        [str(signer), "verify", "--print-certs", str(apk)],
        cwd=ANDROID_ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    for line in completed.stdout.splitlines():
        if "Signer #1 certificate SHA-256 digest:" in line:
            return line.split(":", 1)[1].strip().lower()
    raise RuntimeError(f"certificate digest missing for {apk}")


def build_candidate(version_code: int, version_name: str, *, sync_web: bool) -> Path:
    if version_code <= 0 or not version_name.strip():
        raise ValueError("positive version code and non-empty version name are required")
    env = os.environ.copy()
    env["LOFA_VERSION_CODE"] = str(version_code)
    env["LOFA_VERSION_NAME"] = version_name.strip()
    if sync_web:
        npx = "npx.cmd" if os.name == "nt" else "npx"
        _run([npx, "cap", "sync", "android"], cwd=APP_ROOT, env=env)
    gradle = str(ANDROID_ROOT / "gradlew.bat") if os.name == "nt" else str(ANDROID_ROOT / "gradlew")
    _run(
        [gradle, ":app:testDebugUnitTest", ":app:lintRelease", ":app:assembleRelease", "--console=plain", "--no-daemon"],
        cwd=ANDROID_ROOT,
        env=env,
    )
    source = ANDROID_ROOT / "app" / "build" / "outputs" / "apk" / "release" / "app-release.apk"
    if not source.is_file():
        raise RuntimeError(f"release APK was not produced: {source}")
    CANDIDATE_ROOT.mkdir(parents=True, exist_ok=True)
    candidate = CANDIDATE_ROOT / f"lofa-{version_name}-vc{version_code}.apk"
    shutil.copy2(source, candidate)
    digest = _sha256(candidate)
    certificate = _certificate_digest(candidate)
    live_apk = RELEASE_ROOT / "lofa-latest.apk"
    if live_apk.is_file():
        live_certificate = _certificate_digest(live_apk)
        if live_certificate != certificate:
            candidate.unlink(missing_ok=True)
            raise RuntimeError("candidate signature differs from the installed-release lineage")
    manifest = {
        "kind": "lofa.android.candidate",
        "versionCode": version_code,
        "versionName": version_name,
        "sha256": digest,
        "certificateSha256": certificate,
        "size": candidate.stat().st_size,
        "filename": candidate.name,
        "buildType": "release",
        "debuggable": False,
        "liveReleaseChanged": False,
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    manifest_path = candidate.with_suffix(".manifest.json")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(manifest_path, flush=True)
    return manifest_path


def offer_candidate(manifest_path: Path) -> Path:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    candidate = manifest_path.with_name(str(manifest["filename"]))
    if not candidate.is_file() or _sha256(candidate) != manifest.get("sha256"):
        raise RuntimeError("candidate APK is missing or its checksum changed")
    if manifest.get("buildType") != "release" or manifest.get("debuggable") is not False:
        raise RuntimeError("only a non-debuggable release candidate may be offered")
    RELEASE_ROOT.mkdir(parents=True, exist_ok=True)
    destination = RELEASE_ROOT / "lofa-latest.apk"
    temporary_apk = RELEASE_ROOT / "lofa-latest.apk.tmp"
    shutil.copy2(candidate, temporary_apk)
    temporary_apk.replace(destination)
    live_manifest = {
        "versionCode": manifest["versionCode"],
        "versionName": manifest["versionName"],
        "sha256": manifest["sha256"],
        "certificateSha256": manifest["certificateSha256"],
        "size": manifest["size"],
        "filename": "lofa-latest.apk",
        "buildType": "release",
        "debuggable": False,
        "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "installEnqueued": False,
    }
    temporary_manifest = RELEASE_ROOT / "manifest.json.tmp"
    temporary_manifest.write_text(json.dumps(live_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary_manifest.replace(RELEASE_ROOT / "manifest.json")
    print(RELEASE_ROOT / "manifest.json", flush=True)
    return RELEASE_ROOT / "manifest.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build", help="build and stage a candidate only")
    build.add_argument("--version-code", type=int, required=True)
    build.add_argument("--version-name", required=True)
    build.add_argument("--skip-web-sync", action="store_true")
    offer = subparsers.add_parser("offer", help="copy an already verified candidate to the OTA endpoint")
    offer.add_argument("manifest", type=Path)
    args = parser.parse_args()
    if args.command == "build":
        build_candidate(args.version_code, args.version_name, sync_web=not args.skip_web_sync)
    else:
        offer_candidate(args.manifest.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
