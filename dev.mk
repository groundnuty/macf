.PHONY: install check test lint build clean test-e2e

install:
	devbox run -- npm ci

check: install build lint test

build:
	devbox run -- npx tsc --noEmit

lint:
	devbox run -- npx eslint src/

test:
	devbox run -- npx vitest run

test-e2e:
	devbox run -- npx vitest run --config vitest.e2e.config.ts

clean:
	rm -rf dist coverage
