CURRENT_VERSION = $(shell jq -r '.version' ./package.json 2>/dev/null || echo "0.0.0")

.PHONY: bump-patch bump-minor bump-major bump-version set-version update-all-configs version-sync show-versions release-next-steps

bump-patch:
	@$(MAKE) bump-version BUMP_TYPE=patch

bump-minor:
	@$(MAKE) bump-version BUMP_TYPE=minor

bump-major:
	@$(MAKE) bump-version BUMP_TYPE=major

bump-version:
	@if [ -z "$(BUMP_TYPE)" ]; then \
		echo "Error: don't call 'make bump-version' directly."; \
		echo ""; \
		echo "Use one of these commands instead:"; \
		echo "  make bump-patch  - increment patch version (1.1.9 -> 1.1.10)"; \
		echo "  make bump-minor  - increment minor version (1.1.9 -> 1.2.0)"; \
		echo "  make bump-major  - increment major version (1.1.9 -> 2.0.0)"; \
		echo ""; \
		exit 1; \
	fi
	@echo "Current version: $(CURRENT_VERSION)"
	@set -e; \
	NEW_VERSION=$$(pnpm version "$(BUMP_TYPE)" --no-git-tag-version | sed 's/^v//'); \
	if [ -z "$$NEW_VERSION" ]; then \
		echo "Error: pnpm did not return a new version."; \
		exit 1; \
	fi; \
	echo "New version: $$NEW_VERSION"; \
	$(MAKE) update-all-configs VERSION=$$NEW_VERSION; \
	$(MAKE) release-next-steps VERSION=$$NEW_VERSION

update-all-configs:
	@echo "Updating all configs to version: '$(VERSION)'"
	@if [ -z "$(VERSION)" ]; then \
		echo "Error: VERSION is empty."; \
		exit 1; \
	fi
	@jq --arg v "$(VERSION)" '.version = $$v' ./package.json > ./package.json.tmp && mv ./package.json.tmp ./package.json
	@jq --arg v "$(VERSION)" '.version = $$v' ./jsr.json > ./jsr.json.tmp && mv ./jsr.json.tmp ./jsr.json
	@jq --arg v "$(VERSION)" '.version = $$v' ./deno.json > ./deno.json.tmp && mv ./deno.json.tmp ./deno.json

set-version:
	@read -p "Enter version (e.g., 1.2.3): " version; \
	$(MAKE) update-all-configs VERSION=$$version; \
	$(MAKE) release-next-steps VERSION=$$version

version-sync:
	@echo "Syncing versions across config files..."
	@$(MAKE) update-all-configs VERSION=$(CURRENT_VERSION)
	@echo "All configs now at version $(CURRENT_VERSION)"
	@$(MAKE) release-next-steps VERSION=$(CURRENT_VERSION)

show-versions:
	@echo "=== Current Versions ==="
	@echo "package.json: $$(jq -r '.version' ./package.json)"
	@echo "jsr.json:     $$(jq -r '.version // "not set"' ./jsr.json)"
	@echo "deno.json:    $$(jq -r '.version // "not set"' ./deno.json)"

release-next-steps:
	@if [ -z "$(VERSION)" ]; then \
		echo "Error: VERSION is empty."; \
		exit 1; \
	fi
	@echo ""
	@echo "Updated manifests for v$(VERSION)."
	@echo "Manual version changes are release overrides."
	@echo "Normal releases happen automatically when reviewed PRs merge to main."
	@echo "Override next steps:"
	@echo "  1. Open a PR with package.json, jsr.json, and deno.json."
	@echo "  2. Merge the PR to main after review and CI."
	@echo "  3. If you need an immediate manual publish, create annotated tag v$(VERSION) on the merged main commit and push it."
	@echo "  4. Let .github/workflows/publish.yml publish npm, publish JSR, and create GitHub Release notes."
