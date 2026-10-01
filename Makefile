# make ci runs what the CI workflow runs
SHELL := /bin/bash
ENVS  := dev staging prod
ENV   ?= prod
PORT  ?= 8083
TF    ?= terraform

.PHONY: setup provision check-provision lint test bundle package verify-package serve ingest ci tf-check

setup:
	npm ci

# render + validate all three environments
provision:
	npm run --silent render

# fails if dist/ was edited by hand or is stale
check-provision:
	npm run --silent render -- --check

lint:
	npm run --silent typecheck

# connector tests launch the bundle
test: bundle
	npm test

bundle:
	npm run --silent bundle

# plugin, extension and .mcpb per environment
package: provision bundle
	rm -rf build && mkdir -p build
	for e in $(ENVS); do \
	  for kind in claude-plugin gemini-extension claude-desktop-extension; do \
	    mkdir -p build/$$e/$$kind/server build/$$e/$$kind/directory; \
	    cp -r dist/$$e/$$kind/. build/$$e/$$kind/; \
	    cp bundle/server.mjs build/$$e/$$kind/server/index.mjs; \
	    cp data/directory/*.json build/$$e/$$kind/directory/; \
	  done; \
	done
	for e in $(ENVS); do \
	  npx --yes @anthropic-ai/mcpb@2 validate build/$$e/claude-desktop-extension/manifest.json && \
	  npx --yes @anthropic-ai/mcpb@2 pack build/$$e/claude-desktop-extension build/$$e/meridian-usage-$$e.mcpb || exit 1; \
	done
	@echo "packaged -> build/<env>/{claude-plugin,gemini-extension,claude-desktop-extension,*.mcpb}"

verify-package: package
	for e in $(ENVS); do claude plugin validate build/$$e/claude-plugin; done

# make serve ENV=dev PORT=8081, db is var/<env>.sqlite
serve:
	MERIDIAN_ENV=$(ENV) npm run --silent serve -- --port $(PORT)

ingest:
	MERIDIAN_ENV=$(ENV) npm run --silent ingest

# same output through terraform, diffed against dist/
tf-check:
	cd terraform && $(TF) init -backend=false -input=false >/dev/null && $(TF) validate
	rm -rf build/tf-out && mkdir -p build
	cd terraform && $(TF) apply -auto-approve -input=false -state=../build/tf.tfstate -var out_dir=$(CURDIR)/build/tf-out >/dev/null
	diff -r build/tf-out dist && echo "terraform render == dist/"

ci: lint check-provision test
