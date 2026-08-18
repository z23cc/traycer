traycer_local_path := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

SHELL := /bin/bash

GIT_ROOT := $(shell git rev-parse --show-toplevel)

.DEFAULT_GOAL := build

# ---------------------------------------------------------------------------
# Developer stack
#
# Runs the desktop dev shell (Vite HMR) against the in-repo local host.
# Pass VERSION= to download an official signed host instead.
#
#   make dev-desktop                 # in-repo @traycer/host + HMR desktop
#   make dev-desktop VERSION=1.2.3   # official host release + HMR desktop
#   make dev-host                    # in-repo host only
#   make host-stop                   # stop an official-dev host service
#   make host-clean                  # deregister + remove an official-dev host
#
# The CLI verifies the downloaded host against the signing public key committed
# in clients/traycer-cli/src/config.ts, so no key setup is needed. The dev host
# installs under the isolated `dev` slot (`~/.traycer/host/dev`, service label
# `ai.traycer.host.dev`), so it never touches a production Traycer install.
# Ctrl-C deregisters it; ~/.traycer user data (credentials, config) is preserved.
# ---------------------------------------------------------------------------

CLI := bun clients/traycer-cli/src/index.ts

dev-desktop:
	@bun run dev-desktop -- $(if $(strip $(VERSION)),--release $(VERSION),) $(ARGS)

# Local host from this repo (no GitHub Releases binary, no Traycer JWT).
# Writes ~/.traycer/host/dev[-runs/<slot>]/pid.json for Desktop discovery.
dev-host:
	@bun host/src/index.ts

# Stop the dev host service (leaves it installed).
host-stop:
	@$(CLI) host stop

# Deregister + remove the dev host install (keeps ~/.traycer user data).
host-clean:
	@$(CLI) host uninstall --all

# ---------------------------------------------------------------------------
# Quality gates
# ---------------------------------------------------------------------------

install:
	@bun install

lint:
	@bun run lint

format:
	@bun run format

test:
	@bun run test

test-affected:
	@bun run test:affected

test-project:
	@bun run test:project $(ARGS)

workspace-checks:
	@scripts/pre_commit_workspace_checks.sh

pre-commit-checks:
	@pre-commit run --all-files

build:
	@bun install
	@bun run build

compile:
	@bun install
	@bun run compile

all: pre-commit-checks
	@echo "Done"

.PHONY: dev-desktop host-stop host-clean \
	install lint format test test-affected test-project workspace-checks \
	pre-commit-checks build compile all
