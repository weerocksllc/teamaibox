FROM python@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /opt/teamaibox/ocr-worker
COPY services/ocr-worker/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --requirement requirements.txt \
    && groupadd --gid 10001 teamaibox \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin teamaibox
COPY services/ocr-worker/server.py ./server.py
COPY services/ocr-worker/server_hardened.py ./server_hardened.py
COPY services/ocr-worker/download_model.py ./download_model.py
COPY services/ocr-worker/download_layout_model.py ./download_layout_model.py
COPY services/ocr-worker/layout_onnx.py ./layout_onnx.py
COPY services/ocr-worker/otsl.py ./otsl.py
COPY services/ocr-worker/test_server.py ./test_server.py
COPY services/ocr-worker/test_server_hardened.py ./test_server_hardened.py
COPY services/ocr-worker/test_download_layout_model.py ./test_download_layout_model.py
COPY services/ocr-worker/test_layout_onnx.py ./test_layout_onnx.py
COPY services/ocr-worker/test_otsl.py ./test_otsl.py
RUN python -m unittest -v test_server.py test_server_hardened.py test_download_layout_model.py test_layout_onnx.py test_otsl.py \
    && rm ./test_server.py ./test_server_hardened.py ./test_download_layout_model.py ./test_layout_onnx.py ./test_otsl.py

USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=180s --retries=30 \
  CMD ["python", "-c", "import json,urllib.request; v=json.load(urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=2)); raise SystemExit(0 if v.get('accepting') else 1)"]
ENTRYPOINT ["python", "-m", "uvicorn", "server_hardened:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
