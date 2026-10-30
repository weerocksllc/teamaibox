# HunyuanOCR Provider Adapter

This container exposes the appliance-local docs-farm `hunyuanocr` worker through the Team AI Box external Provider contract. It uses TLS 1.3 and bearer authentication, accepts bounded PDF/PNG/JPEG/WebP bytes, keeps one inference active, maps Markdown-only output without inventing geometry, and removes its exact docs-farm input, output, and task state before returning.

The adapter must use host networking only because its sole cleartext dependency is the same-host loopback endpoint `http://127.0.0.1:9200`. It requires no host-installed language packages and runs as UID/GID 65532 with a read-only root filesystem in the deployment manifest.
