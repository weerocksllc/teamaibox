# PaddleOCR-VL worker

This deployment runs the exact PaddleOCR-VL 1.5 BF16 model on a managed ARM64
DGX Spark through NVIDIA's pinned ARM64 vLLM image. A non-GPU adapter converts
bounded image/PDF input into page requests, invokes the model's text-spotting
task, validates its real geometry, and exposes the platform `/layout-parsing`
contract. It never manufactures coordinates when spotting output is malformed.

The adapter image variable must identify the exact locally built ARM64 image;
the GPU image is fixed by registry digest. The adapter is published only on the
selected LAN address and receives no object-store
credentials. Team AI Box downloads a short-lived `compute:ocr` reference,
sends the bounded bytes to this worker, validates its bounded response, and
stores the derived result in the protected object service.

Paddle's published SM120 offline pipeline image was inspected as `linux/amd64`
and fails with `exec format error` on Spark. Therefore this deployment is an
honest experimental text-spotting path, not a claim that the publisher's full
page-layout pipeline is running. Full PP-DocLayoutV2 integration and its ARM64
runtime remain a certification prerequisite.

This component remains Experimental until the exact images, embedded model
artifacts, quality corpus, cold/warm benchmarks, resource envelope, coexistence,
restart, cancellation, disconnection, and soak evidence have all passed.
