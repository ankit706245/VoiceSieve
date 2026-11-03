"""Hindi small-number speech normalizer for pre-TTS text.

Replaces standalone small numerals in Hindi time contexts with Hindi words
so the voice renders them in Hindi (e.g. "1 baje" -> "ek baje") instead of
English ("one baje"). Rumik receives no language hint from the current
pipecat-rumik payload, so digit form is pronounced English-side.

Scope is deliberately narrow (time contexts only):
- Units covered: baje/bajey (o'clock), ghanta/ghante (hour/duration).
- Numbers covered: 1-31 only. Years (2019), prices (lakh/crore), phone
  numbers, model names (JCB 3DX), decimals (1.5) and larger runs are
  byte-identical by construction.
- Already-Hindi text ("ek baje") and Devanagari digits pass through
  untouched.

Pure standard library: no pipecat import required for the core function,
so this module is unit-testable without service dependencies. The
``HindiNumberSpeechFilter`` wrapper below adapts it to pipecat's
``BaseTextFilter`` interface for ``text_filters=[...]`` wiring; the pipecat
import is optional at module load so tests run anywhere.
"""

from __future__ import annotations

import re

try:
    from pipecat.utils.text.base_text_filter import BaseTextFilter
except Exception:  # pragma: no cover - test-time fallback, live image has pipecat
    BaseTextFilter = object  # type: ignore[assignment,misc]

_HINDI_WORDS_1_31 = {
    1: "ek", 2: "do", 3: "teen", 4: "chaar", 5: "paanch", 6: "cheh",
    7: "saat", 8: "aath", 9: "nau", 10: "das", 11: "gyarah", 12: "barah",
    13: "terah", 14: "chaudah", 15: "pandrah", 16: "solah", 17: "satrah",
    18: "atharah", 19: "unnees", 20: "bees", 21: "ikkees", 22: "bais",
    23: "teis", 24: "chaubees", 25: "pachees", 26: "chhabbees",
    27: "sattaees", 28: "atthaees", 29: "untees", 30: "tees", 31: "ikattis",
}

# Standalone 1-2 digit token immediately followed by a Hindi time unit.
# Guards: no adjacent digits/dots (protects decimals, years, long runs),
# unit must be a whole word (protects words merely containing these letters).
_TIME_RE = re.compile(
    r"(?<![\d.])(\d{1,2})(?![\d.])(\s*)(baje|bajey|ghanta|ghante)\b",
    re.IGNORECASE,
)


def hindi_number_speech_filter(text: str) -> str:
    """Replace small numerals in Hindi time contexts with Hindi words."""
    if not text or not any(ch.isdigit() for ch in text):
        return text

    def _repl(match: re.Match) -> str:
        number = int(match.group(1))
        word = _HINDI_WORDS_1_31.get(number)
        if word is None:
            return match.group(0)
        return word + match.group(2) + match.group(3)

    return _TIME_RE.sub(_repl, text)


class HindiNumberSpeechFilter(BaseTextFilter):
    """pipecat ``text_filters`` adapter for :func:`hindi_number_speech_filter`."""

    async def filter(self, text: str) -> str:  # noqa: D102
        return hindi_number_speech_filter(text)
