FROM node:22-alpine
# Runtime deps only. python3 and py3-pip are needed at RUN TIME by
# garmin_sync.py, so they stay in the image; make and g++ exist solely to
# compile better-sqlite3 and are installed and removed inside the npm ci layer
# below. See that block for why they can't simply be `apk del`'d afterwards.
# GNU tar is for exercise_library.js's installSnapshot: busybox tar has no
# --wildcards, so it could only unpack the whole RepDB archive.
RUN apk add --no-cache python3 py3-pip tar

# Alpine ships no zoneinfo, so without tzdata the TZ below is silently ignored
# and the container stays on UTC. That matters here more than in most images:
# EVERY date in this app means the LOCAL calendar day (see CLAUDE.md's data
# model rules), and while the frontend supplies dateKey() on every write, the
# server-side fallbacks do not — db.isoDateStr() backs addHistory,
# addBodyWeight, createInjury and createPregnancyMilestone, and
# garmin_sync.py's fetch_sleep_summary calls datetime.now().date(). On UTC,
# any of those firing after 19:00 local writes TOMORROW's date.
#
# Set here rather than only in compose because OMV owns and regenerates
# workout-tracker.yml — a compose-only fix is one GUI save away from being
# silently reverted. docker-compose.yml carries the same value for local runs.
RUN apk add --no-cache tzdata
ENV TZ=America/Chicago

WORKDIR /app

# The lockfile must be copied WITH package.json, before the install. It used to
# arrive only with the `COPY . .` below — after `npm install` had already run —
# so every rebuild silently floated express and better-sqlite3 to whatever was
# newest that day. With no CI and rebuild-to-deploy as the only deployment
# mechanism, that put a bad minor release straight into production with nothing
# recording what changed. `npm ci` also fails loudly if the two ever disagree.
COPY package.json package-lock.json ./
# --omit=dev keeps jsdom out of the runtime image: its only consumers are
# testing/verify_prs.js and testing/verify_metrics.js, both excluded by
# .dockerignore, so it was being compiled on a Pi 4 for nothing.
#
# The toolchain is installed and deleted IN THIS ONE LAYER, which is the whole
# point — Docker layers are additive, so an `apk del make g++` in any later RUN
# reclaims nothing at all: the bytes stay in the earlier layer and the image
# only grows by the deletion record. --virtual .build-deps is what makes the
# one-liner readable; it tags the set so apk can drop exactly it, leaving the
# python3/py3-pip from the base layer alone.
#
# This matters more here than in most images because rebuild-to-deploy is the
# only deployment mechanism: every `--build` orphans the previous image on the
# Pi's 59 GB SD card, so image size is multiplied by the whole dangling set
# rather than paid once. Caching is unchanged — the layer is still keyed on
# package.json/package-lock.json copied above.
RUN apk add --no-cache --virtual .build-deps make g++ \
 && npm ci --omit=dev \
 && apk del .build-deps

# Python deps for Garmin sync, pinned in requirements.txt (see its header).
# Copied on its own, before COPY . ., so this layer stays cached until a pin
# changes, the same way the npm layer is keyed on the lockfile.
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
