# Rumik TTS overlay + Vaani post-call relay packaging.
#
# Build from the repository root so the Docker context can reach both the
# Rumik overlay files and the Vaani relay task files:
#
#   docker build -f rumik-overlay-local/Dockerfile \
#     -t local/dograh-api:rumik-v1-p41-groq-retry .
#
# BASE_IMAGE defaults to the image currently running as dograh-local-api-1
# (local/dograh-api:rumik-v1-p41). Override with --build-arg if needed.
#
# --no-deps is REQUIRED: Dograh vendors its own pipecat fork (tagged v1.1.0)
# but setuptools_scm cannot read the submodule tags, so the installed
# pipecat-ai reports 0.0.0.dev0. pipecat-rumik declares pipecat-ai>=1.0.0,<2,
# so a normal install would either fail resolution or pull upstream pipecat
# from PyPI straight over Dograh's fork and break the box.
# Its other three deps (aiohttp, certifi, websockets) are already in the image.
ARG BASE_IMAGE=local/dograh-api:rumik-v1-p41
FROM ${BASE_IMAGE}

# The base image runs as `dograh`, but /opt/venv is root-owned.
USER root
RUN pip install --no-cache-dir --no-deps pipecat-rumik==0.1.4

# pipecat-rumik 0.1.4 imports the old `_NotGiven` sentinel name. Dograh's
# current pipecat fork exports `NotGiven`; alias it rather than pinning pipecat
# backwards. Fail the build if the upstream import line ever changes.
RUN python -c "from pathlib import Path; p = Path('/opt/venv/lib/python3.13/site-packages/pipecat_rumik/settings.py'); s = p.read_text(); old = 'from pipecat.services.settings import NOT_GIVEN, TTSSettings, _NotGiven'; new = 'from pipecat.services.settings import NOT_GIVEN, NotGiven as _NotGiven, TTSSettings'; assert old in s, 'unexpected pipecat-rumik settings import'; p.write_text(s.replace(old, new))"

# Rumik overlay files
COPY --chown=dograh:dograh rumik-overlay-local/registry.py        /app/api/services/configuration/registry.py
COPY --chown=dograh:dograh rumik-overlay-local/check_validity.py  /app/api/services/configuration/check_validity.py
COPY --chown=dograh:dograh rumik-overlay-local/service_factory.py /app/api/services/pipecat/service_factory.py
COPY --chown=dograh:dograh rumik-overlay-local/hindi_speech_normalizer.py /app/api/services/workflow/hindi_speech_normalizer.py
COPY --chown=dograh:dograh rumik-overlay-local/reasoning_output_guard.py /app/api/services/workflow/reasoning_output_guard.py

# Vaani post-call relay (required by vaani_relay.py; absent from base image)
COPY --chown=dograh:dograh dograh/api/tasks/relay_retry.py /app/api/tasks/relay_retry.py
COPY --chown=dograh:dograh dograh/api/tasks/vaani_relay.py /app/api/tasks/vaani_relay.py

# Restore the base image's runtime user.
USER dograh
