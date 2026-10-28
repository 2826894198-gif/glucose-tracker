FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt requirements.lock.txt ./
RUN pip install --no-cache-dir -r requirements.lock.txt
COPY app.py ./
RUN useradd --create-home --uid 10001 appuser
USER appuser
EXPOSE 8080
CMD ["python", "app.py"]
