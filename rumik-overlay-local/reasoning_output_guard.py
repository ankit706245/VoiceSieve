"""Detect and remove LLM internal-monologue leaks from spoken output.

Small reasoning models occasionally answer with their planning text instead of a
caller-facing sentence, for example::

    The user is a seller who has provided the machine details.
    I need to confirm the phone number before proceeding.
    Wait, let me check the flow.

This module classifies those utterances deterministically. The pre-TTS path uses
:func:`strip_reasoning_output` so a leak is never synthesized. The pipeline
guard in ``reasoning_output_guard_processor`` additionally stops the rest of a
response once a leak is detected, so a later bullet or sentence cannot slip
through.

The detector is intentionally conservative about caller-facing language. A
sentence that mentions the caller in the second person ("I need to verify your
number") is treated as speech, not as private reasoning. Third-person narration
("The user is..."), planning verbs without a listener ("Let me check the
flow"), and ``<think>`` blocks are treated as leaks.

Pure standard library so the classifier is testable without service
dependencies. The optional pipecat import keeps the text-filter adapter usable
in unit tests that do not install pipecat.
"""

from __future__ import annotations

import logging
import re

try:
    from pipecat.utils.text.base_text_filter import BaseTextFilter
except Exception:  # pragma: no cover - test-time fallback, live image has pipecat
    BaseTextFilter = object  # type: ignore[assignment,misc]

__all__ = [
    "ReasoningOutputTextFilter",
    "contains_reasoning_leak",
    "find_reasoning_offset",
    "looks_like_reasoning",
    "strip_reasoning_output",
]

logger = logging.getLogger(__name__)

_BLOCK_TAGS = (
    "think",
    "thinking",
    "analysis",
    "reasoning",
    "scratchpad",
    "reflection",
    "internal",
)

_ROLE_PREFIX_RE = re.compile(
    r"^\s*(?:\[?(?:assistant|bot|ai|system)\]?\s*[:：\-]\s*)+",
    re.IGNORECASE,
)

# Sentence boundaries. A period between digits is a decimal, not a boundary.
_SENTENCE_BOUNDARY_RE = re.compile(r".*?(?:(?<!\d)[.!?।](?!\d)|\n)", re.DOTALL)

# Third-person narration and explicit references to internal material are
# never caller-facing, regardless of the rest of the sentence.
_ALWAYS_REASONING_PATTERNS = [
    re.compile(
        r"^the\s+(?:user|caller|customer|buyer|seller|client)\s+"
        r"(?:is|was|has|had|will|would|may|might|could|should|"
        r"said|says|wants|needs|provided|asked|seems|appears|mentioned|"
        r"just|already|also|now|currently|probably|likely|expects|intends|"
        r"stated|confirmed|answered|responded|gave|shared|told|replied|"
        r"requested|isn't|isnt|doesn't|doesnt|didn't|didnt)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^the\s+(?:user|caller|customer|buyer|seller|client)'s\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^they\s+(?:also|have|has|are|were|will|would|may|might|could|"
        r"want|wants|need|needs|mentioned|provided|said|says|seem|seems|"
        r"appear|appears|expect|expects|intend|intends|stated|confirmed|"
        r"answered|responded|gave|shared|told|replied|requested)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^(?:the|this)\s+(?:conversation|transcript|context|workflow|node|"
        r"prompt|schema|system prompt|last turn|previous turn|flow)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^(?:based on|looking at|given|per)\s+(?:the|this|that|what|their|"
        r"his|her)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^(?:the|this)\s+(?:means|suggests|indicates)\s+(?:that|the)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^so,?\s+the\s+(?:user|caller|customer)\s+(?:is|has|wants|needs)\b",
        re.IGNORECASE,
    ),
]

# First-person planning is suspicious unless the sentence addresses the caller
# ("I need to verify your number") or asks a question.
_PLANNING_PATTERNS = [
    re.compile(
        r"^(?:let me|let's|let us)\s+(?:think|see what|check\s+(?:the|this)\s+"
        r"(?:context|conversation|transcript|prompt|workflow|node|schema|flow|"
        r"list)|review|analy[sz]e|re-?read|consider|figure|look at\s+(?:the|"
        r"this)\s+(?:context|conversation|transcript|prompt|workflow|node)|"
        r"verify|confirm|make sure|understand|decide|determine|process this|"
        r"handle this|use the tool|call the tool)",
        re.IGNORECASE,
    ),
    re.compile(
        r"^(?:let me|let's|let us)\b.*\b(?:the|this)\s+(?:user|caller|customer|"
        r"transcript|context|workflow|node|schema|flow)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^i\s+(?:still\s+|also\s+|now\s+|then\s+)?(?:need|should|must|"
        r"have|will|'ll|want)\s+to\s+(?:ask|find out|figure out|understand|"
        r"analy[sz]e|review|parse|extract|update|record|store|confirm|verify|"
        r"clarify|decide|determine|remember|make sure|note|acknowledge|"
        r"address|mention|respond|reply|continue|proceed|check\s+(?:the|this)\s+"
        r"(?:context|conversation|transcript|prompt|workflow|node|schema|flow)|"
        r"look at\s+(?:the|this)\s+(?:context|conversation|transcript|prompt|"
        r"workflow|node)|use the tool|call the tool)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^(?:i\s+still\s+need|i\s+also\s+need|i\s+now\s+need|now\s+i\s+"
        r"(?:need|should|must|will)|next,?\s+i|first,?\s+i)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^wait,?\s+(?:let me|let's|i\b|we\b|the\s+(?:user|caller|customer))\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^(?:okay,?\s+so|actually,?)\s+(?:i|we|the\s+(?:user|caller|customer))\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^so,?\s+(?:i|we)\s+(?:need|should|must|will)\b",
        re.IGNORECASE,
    ),
]

# Broad planning openers that are only suspicious at the start of a response.
# A second-person listener ("Let me check that for you") makes them speech.
_WEAK_START_RE = re.compile(
    r"^(?:i\s+(?:need|should|must|have)\s+to|we\s+(?:need|should|must)\s+to)\b",
    re.IGNORECASE,
)

_SECOND_PERSON_RE = re.compile(
    r"\b(?:you|your|yours|yourself|aap|aapka|aapki|aapke|tum|tumhara|"
    r"tumhari|tumhe)\b",
    re.IGNORECASE,
)

_BULLET_RE = re.compile(r"^\s*(?:[-*•>]+|\d+[.)])\s*")


def _remove_reasoning_blocks(text: str) -> str:
    """Remove ``<think>``-style blocks, including an unclosed final block."""
    for tag in _BLOCK_TAGS:
        paired = re.compile(
            rf"<{tag}\b[^>]*>.*?</{tag}\s*>", re.IGNORECASE | re.DOTALL
        )
        text = paired.sub("", text)
        unclosed = re.compile(rf"<{tag}\b[^>]*>.*\Z", re.IGNORECASE | re.DOTALL)
        text = unclosed.sub("", text)
        text = re.compile(rf"</?{tag}\b[^>]*>", re.IGNORECASE).sub("", text)
    return text


def _strip_role_prefix(text: str) -> str:
    return _ROLE_PREFIX_RE.sub("", text, count=1)


def _candidate(sentence: str) -> str:
    candidate = _strip_role_prefix(sentence).strip()
    candidate = _BULLET_RE.sub("", candidate).strip()
    return candidate


def _has_second_person(sentence: str) -> bool:
    return bool(_SECOND_PERSON_RE.search(sentence)) or "?" in sentence


def _is_reasoning_sentence(sentence: str, *, at_start: bool) -> bool:
    candidate = _candidate(sentence)
    if not candidate:
        return False

    for pattern in _ALWAYS_REASONING_PATTERNS:
        if pattern.search(candidate):
            return True

    second_person = _has_second_person(candidate)
    for pattern in _PLANNING_PATTERNS:
        if pattern.search(candidate):
            return not second_person

    if at_start and _WEAK_START_RE.search(candidate):
        # "Let me check that for you" and "I need to verify your number" are
        # caller-facing offers. Everything else at the start is planning.
        return not second_person

    return False


def _iter_sentences(text: str):
    offset = 0
    length = len(text)
    while offset < length:
        match = _SENTENCE_BOUNDARY_RE.match(text, offset)
        if not match or match.end() <= offset:
            break
        yield text[offset : match.end()], offset
        offset = match.end()
    if offset < length:
        yield text[offset:], offset


def find_reasoning_offset(text: str) -> int:
    """Return the character offset of the first reasoning sentence, or ``-1``."""
    if not text:
        return -1
    cleaned = _strip_role_prefix(_remove_reasoning_blocks(text))
    first_content = True
    for sentence, offset in _iter_sentences(cleaned):
        candidate = _candidate(sentence)
        if not candidate:
            continue
        if _is_reasoning_sentence(sentence, at_start=first_content):
            return offset
        first_content = False
    return -1


def contains_reasoning_leak(text: str) -> bool:
    """Whether ``text`` contains any internal-monologue sentence."""
    return find_reasoning_offset(text) >= 0


def looks_like_reasoning(text: str) -> bool:
    """Whether the response begins with internal monologue."""
    return find_reasoning_offset(text) == 0


def strip_reasoning_output(text: str) -> str:
    """Return only the caller-facing prefix of ``text``.

    ``<think>``-style blocks and role prefixes are removed first. If the first
    remaining sentence is reasoning, the whole response is suppressed. If a
    later sentence leaks, everything from that sentence onward is dropped. This
    avoids speaking the tail of a half-written plan or its bullet list.
    """
    if not text:
        return text

    cleaned = _strip_role_prefix(_remove_reasoning_blocks(text))
    if not cleaned.strip():
        return ""

    offset = find_reasoning_offset(cleaned)
    if offset < 0:
        return cleaned.rstrip()
    return cleaned[:offset].rstrip()


class ReasoningOutputTextFilter(BaseTextFilter):
    """pipecat ``text_filters`` adapter for :func:`strip_reasoning_output`."""

    def __init__(self) -> None:
        self._suppressed = 0

    async def filter(self, text: str) -> str:  # noqa: D102
        cleaned = strip_reasoning_output(text)
        if cleaned != text:
            self._suppressed += 1
            logger.warning(
                "[reasoning-guard] suppressed pre-TTS output "
                "(chars_in=%d chars_out=%d suppressed_total=%d)",
                len(text),
                len(cleaned),
                self._suppressed,
            )
        return cleaned
