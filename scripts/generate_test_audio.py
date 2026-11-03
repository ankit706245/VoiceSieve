#!/usr/bin/env python3
"""Generate WebRTC caller fixtures through the Rumik silk TTS API.

The WebRTC test sends 16 kHz, mono, 16-bit PCM WAV files. Rumik returns 24 kHz
WAV audio, so each clip is resampled before it is written to disk.

Usage:
    python scripts/generate_test_audio.py
    python scripts/generate_test_audio.py --all --force
    python scripts/generate_test_audio.py --only q1_hindi q2_hinglish --force
    python scripts/generate_test_audio.py --output-dir /tmp/user_inputs

The default output directory is /tmp/user_inputs, which is where
test_webrtc_live.py looks for its caller audio.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = Path("/tmp/user_inputs")
RUMIK_URL = "https://silk-api.rumik.ai/v1/tts"
RUMIK_HOST = "silk-api.rumik.ai"
TARGET_RATE = 16000
TARGET_CHANNELS = 1
TARGET_WIDTH = 2

# Rumik sits behind Cloudflare, which rejects non-browser user agents.
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
)

DEFAULT_DESCRIPTION = (
    "a warm 30s indian english voice, smooth timbre, natural conversational "
    "pacing, like a friendly receptionist"
)

# Ordered fixtures for the seven WebRTC scenarios. q1/q2 are the two clips
# called out by the test, but generating all six keeps a fresh /tmp from
# failing later at q3 through q6.
CLIPS: dict[str, dict[str, str]] = {
    "q1_hindi": {
        "language": "hindi",
        "text": (
            "नमस्ते, मैं आपके प्रोडक्ट के बारे में जानना चाहता हूँ। "
            "यह कैसे काम करता है?"
        ),
    },
    "q2_hinglish": {
        "language": "hinglish",
        "text": (
            "Haan ji, aapka product kaise kaam karta hai? "
            "Aur iski price kitni hai?"
        ),
    },
    "q3_business": {
        "language": "hindi",
        "text": (
            "मुझे अपने बिज़नेस के लिए यह प्रोडक्ट चाहिए। "
            "आप मुझे थोड़ी और जानकारी दे सकते हैं?"
        ),
    },
    "q4_interrupt": {
        "language": "hindi",
        "text": "रुकिए, मुझे एक बात साफ़ करनी है।",
    },
    "q5_callback": {
        "language": "hinglish",
        "text": "Theek hai, mujhe baad mein callback karwa dijiye.",
    },
    "q6_end": {
        "language": "hinglish",
        "text": "Theek hai, dhanyavaad. Phir milte hain.",
    },
}


class RumikTTSError(RuntimeError):
    """Raised when Rumik cannot synthesize a fixture."""


def load_env() -> None:
    """Load repo .env without overriding variables already in the shell."""
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip().strip("'").strip('"')


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi  # type: ignore[import-not-found]

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    for candidate in (
        "/etc/ssl/cert.pem",
        "/usr/local/etc/openssl/cert.pem",
        "/opt/homebrew/etc/openssl/cert.pem",
    ):
        if Path(candidate).exists():
            try:
                return ssl.create_default_context(cafile=candidate)
            except Exception:
                pass
    return ssl.create_default_context()


def _rms(raw_pcm: bytes) -> int:
    try:
        import audioop  # type: ignore[import-not-found]

        return int(audioop.rms(raw_pcm, 2))
    except Exception:
        import array

        samples = array.array("h")
        samples.frombytes(raw_pcm)
        if not samples:
            return 0
        return int((sum(sample * sample for sample in samples) / len(samples)) ** 0.5)


def _validate_wav(path: Path) -> dict[str, int]:
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        rate = wav.getframerate()
        frames = wav.getnframes()
        raw = wav.readframes(frames)
    if channels != TARGET_CHANNELS:
        raise RumikTTSError(f"{path}: expected mono, got {channels} channels")
    if width != TARGET_WIDTH:
        raise RumikTTSError(f"{path}: expected 16-bit PCM, got {width * 8}-bit")
    if rate != TARGET_RATE:
        raise RumikTTSError(f"{path}: expected {TARGET_RATE} Hz, got {rate} Hz")
    if frames <= 0:
        raise RumikTTSError(f"{path}: WAV has no audio frames")
    return {
        "channels": channels,
        "sample_width": width,
        "sample_rate": rate,
        "frames": frames,
        "duration_ms": int(round(frames * 1000 / rate)),
        "rms": _rms(raw),
    }


def _fixture_is_ready(path: Path) -> bool:
    try:
        info = _validate_wav(path)
    except Exception:
        return False
    return info["duration_ms"] >= 500 and info["rms"] >= 50


def _resample_with_afconvert(source: Path, destination: Path) -> bool:
    afconvert = shutil.which("afconvert")
    if not afconvert:
        return False
    completed = subprocess.run(
        [
            afconvert,
            "-f",
            "WAVE",
            "-c",
            str(TARGET_CHANNELS),
            "-d",
            f"LEI16@{TARGET_RATE}",
            str(source),
            str(destination),
        ],
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        print(
            f"afconvert failed: {completed.stderr.strip() or completed.stdout.strip()}",
            file=sys.stderr,
        )
        return False
    return True


def _resample_in_python(source: Path, destination: Path) -> None:
    """Fallback linear resampler for machines without afconvert."""
    import array

    with wave.open(str(source), "rb") as wav:
        rate = wav.getframerate()
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        raw = wav.readframes(wav.getnframes())
    if channels != 1 or width != 2:
        raise RumikTTSError("Python fallback only supports mono 16-bit PCM")

    samples = array.array("h")
    samples.frombytes(raw)
    ratio = rate / TARGET_RATE
    output_len = int(len(samples) / ratio)
    output = array.array("h", [0]) * output_len
    last = len(samples) - 1
    for index in range(output_len):
        position = index * ratio
        left = int(position)
        fraction = position - left
        right = min(left + 1, last)
        output[index] = int(samples[left] + (samples[right] - samples[left]) * fraction)

    with wave.open(str(destination), "wb") as wav:
        wav.setnchannels(TARGET_CHANNELS)
        wav.setsampwidth(TARGET_WIDTH)
        wav.setframerate(TARGET_RATE)
        wav.writeframes(output.tobytes())


def _convert_to_target(source: Path, destination: Path) -> None:
    with wave.open(str(source), "rb") as wav:
        rate = wav.getframerate()
        channels = wav.getnchannels()
        width = wav.getsampwidth()
    if channels == TARGET_CHANNELS and width == TARGET_WIDTH and rate == TARGET_RATE:
        shutil.copyfile(source, destination)
        return
    if _resample_with_afconvert(source, destination):
        return
    _resample_in_python(source, destination)


def _post_rumik(payload: dict, api_key: str, timeout: int = 120) -> bytes:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": BROWSER_UA,
        "Accept": "audio/wav",
    }
    last_error = ""
    for attempt in range(1, 4):
        request = urllib.request.Request(
            RUMIK_URL, data=body, headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(
                request, timeout=timeout, context=_ssl_context()
            ) as response:
                if response.status != 200:
                    last_error = f"HTTP {response.status}: {response.read()[:300]!r}"
                else:
                    audio = response.read()
                    if not audio.startswith(b"RIFF"):
                        last_error = f"non-WAV response: {audio[:80]!r}"
                    else:
                        return audio
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
            last_error = f"HTTP {exc.code}: {detail}"
            if exc.code not in (408, 425, 429, 500, 502, 503, 504):
                break
        except urllib.error.URLError as exc:
            last_error = f"network error: {exc.reason}"

        if attempt < 3:
            delay = 2 ** attempt
            print(f"Rumik request failed ({last_error}); retrying in {delay}s")
            time.sleep(delay)

    raise RumikTTSError(f"Rumik TTS failed: {last_error}")


def generate_clip(name: str, output_dir: Path, force: bool = False) -> Path:
    if name not in CLIPS:
        raise KeyError(f"Unknown clip {name!r}; choose from {', '.join(CLIPS)}")

    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / f"{name}.wav"
    if destination.exists() and not force and _fixture_is_ready(destination):
        print(f"{name}: exists and is valid, skipping (use --force to regenerate)")
        return destination

    load_env()
    api_key = os.environ.get("RUMIK_API_KEY", "").strip()
    if not api_key:
        raise RumikTTSError(
            "RUMIK_API_KEY is missing. Add it to .env or export it in the shell."
        )

    model = os.environ.get("RUMIK_MODEL", "mulberry").strip() or "mulberry"
    voice = os.environ.get("RUMIK_VOICE", "ira").strip() or "ira"
    description = os.environ.get("RUMIK_DESCRIPTION", DEFAULT_DESCRIPTION)

    payload: dict[str, object] = {
        "model": model,
        "text": CLIPS[name]["text"],
    }
    if model == "mulberry":
        payload["description"] = description
        payload["speaker"] = voice
    payload["temperature"] = 0.6
    payload["top_p"] = 0.95
    payload["top_k"] = 50

    print(f"{name}: synthesizing via Rumik ({model}/{voice})...")
    raw_wav = _post_rumik(payload, api_key)

    with tempfile.TemporaryDirectory(dir=str(output_dir)) as temp_dir:
        raw_path = Path(temp_dir) / "rumik-24k.wav"
        converted_path = Path(temp_dir) / "rumik-16k.wav"
        raw_path.write_bytes(raw_wav)
        try:
            _convert_to_target(raw_path, converted_path)
            info = _validate_wav(converted_path)
        except Exception as exc:
            raise RumikTTSError(f"{name}: invalid Rumik WAV: {exc}") from exc

        temporary_output = output_dir / f".{name}.wav.tmp"
        shutil.copyfile(converted_path, temporary_output)
        os.replace(temporary_output, destination)

    info = _validate_wav(destination)
    print(
        f"{name}: wrote {destination} "
        f"({info['duration_ms'] / 1000:.2f}s, {info['sample_rate']} Hz mono, rms={info['rms']})"
    )
    return destination


def ensure_test_audio(
    clip_names: list[str] | tuple[str, ...] | None = None,
    output_dir: Path | str = DEFAULT_OUTPUT_DIR,
    force: bool = False,
) -> dict[str, Path]:
    """Ensure all requested fixtures exist and are 16 kHz mono WAV files.

    Called by test_webrtc_live.py before any WebRTC signaling starts. Missing or
    malformed clips are regenerated through Rumik.
    """
    names = list(clip_names) if clip_names is not None else list(CLIPS)
    target_dir = Path(output_dir)
    return {name: generate_clip(name, target_dir, force=force) for name in names}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "clips",
        nargs="*",
        help="clip names to generate (default: q1_hindi q2_hinglish)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="generate all six scenario clips",
    )
    parser.add_argument(
        "--only",
        nargs="+",
        metavar="CLIP",
        help="generate only these clips",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"destination directory (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="regenerate even when a valid fixture already exists",
    )
    args = parser.parse_args()

    if args.clips and args.only:
        parser.error("use either positional clips or --only, not both")
    names = args.only or args.clips or (
        list(CLIPS) if args.all else ["q1_hindi", "q2_hinglish"]
    )
    try:
        ensure_test_audio(names, output_dir=args.output_dir, force=args.force)
    except (RumikTTSError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"done: {len(names)} fixture(s) in {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
