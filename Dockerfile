# The API image. It would be three lines if it were not for PMD: the analyzer is a Java program, so
# the image carries a JRE it never uses for anything else. Everything else here is uv doing its job.
FROM python:3.13-slim

ARG PMD_VERSION=7.7.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends default-jre-headless curl unzip ca-certificates \
 && curl -fsSL -o /tmp/pmd.zip \
      "https://github.com/pmd/pmd/releases/download/pmd_releases%2F${PMD_VERSION}/pmd-dist-${PMD_VERSION}-bin.zip" \
 && unzip -q /tmp/pmd.zip -d /opt \
 && ln -s "/opt/pmd-bin-${PMD_VERSION}/bin/pmd" /usr/local/bin/pmd \
 && rm -rf /tmp/pmd.zip /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /usr/local/bin/uv

WORKDIR /app

# Dependencies first: they change far less often than the code, so this layer survives most builds.
COPY pyproject.toml uv.lock ./
COPY src/smith/__init__.py src/smith/__init__.py
RUN uv sync --frozen --no-dev

COPY alembic.ini ./
COPY src/ src/
COPY rules/ rules/
COPY catalog/ catalog/
COPY scripts/ scripts/

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH="/app/src" \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# The schema is the image's job to apply, not the operator's: a container that starts against an
# empty database and serves 500s is worse than one that takes two seconds longer to come up.
CMD ["sh", "-c", "alembic upgrade head && uvicorn smith.main:app --host 0.0.0.0 --port 8000"]
