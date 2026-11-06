FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir numpy==2.* scikit-learn==1.* \
 && useradd -r -u 10001 trainer && mkdir -p /data && chown trainer /data
COPY *.py ./
USER trainer
ENV DATA_DIR=/data PORT=8787 TRAIN_HOUR=3 PYTHONUNBUFFERED=1
EXPOSE 8787
VOLUME /data
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=4)"
CMD ["python", "server.py"]
