# The playground sandbox: Node and its standard library, and ffmpeg, which the
# runner uses to turn frames into a video. The host's playground tool runs it
# with no network, a read-only root, a tmpfs for output, no capabilities, and an
# unprivileged user; see src/playground-tool.ts.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY runner.mjs /runner.mjs

USER 65534:65534
ENTRYPOINT ["node", "/runner.mjs"]
