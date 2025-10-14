# Get current version from package.json or jsr.json
CURRENT_VERSION = $(shell jq -r '.version' package.json 2>/dev/null || echo "0.0.0")

.PHONY: bump-patch bump-minor bump-major version-sync

# Semantic version bumping
bump-patch:
	@$(MAKE) bump-version BUMP_TYPE=patch

bump-minor:
	@$(MAKE) bump-version BUMP_TYPE=minor

bump-major:
	@$(MAKE) bump-version BUMP_TYPE=major

# Internal target for version bumping
bump-version:
	@if [ -z "$(BUMP_TYPE)" ]; then \
		echo "❌ Error: Don't call 'make bump-version' directly!"; \
		echo ""; \
		echo "Use one of these commands instead:"; \
		echo "  make bump-patch  - Increment patch version (1.1.9 → 1.1.10)"; \
		echo "  make bump-minor  - Increment minor version (1.1.9 → 1.2.0)"; \
		echo "  make bump-major  - Increment major version (1.1.9 → 2.0.0)"; \
		echo ""; \
		exit 1; \
	fi
	@echo "Current version: $(CURRENT_VERSION)"
	@npm version $(BUMP_TYPE) --no-git-tag-version >/dev/null; \
	NEW_VERSION=$$(jq -r '.version' package.json); \
	echo "New version: $$NEW_VERSION"; \
	$(MAKE) update-all-configs VERSION=$$NEW_VERSION; \
	$(MAKE) commit-version VERSION=$$NEW_VERSION

# Update all config files with the same version
update-all-configs:
	@echo "Updating all configs to version: '$(VERSION)'"
	@if [ -z "$(VERSION)" ]; then \
		echo "❌ Error: VERSION is empty!"; \
		exit 1; \
	fi
	@# Update package.json (npm already did this, but just in case)
	@jq --arg v "$(VERSION)" '.version = $$v' package.json > package.json.tmp && mv package.json.tmp package.json
	@# Update jsr.json
	@jq --arg v "$(VERSION)" '.version = $$v' jsr.json > jsr.json.tmp && mv jsr.json.tmp jsr.json
	@# Update deno.json
	@jq --arg v "$(VERSION)" '.version = $$v' deno.json > deno.json.tmp && mv deno.json.tmp deno.json

# Commit the version changes
commit-version:
	@echo "Committing version $(VERSION)"
	@git add package.json jsr.json deno.json
	@git commit -m "Bump version to $(VERSION)"
	@git tag v$(VERSION)
	@echo "Created tag v$(VERSION)"
	@echo "Push with: git push origin main && git push origin v$(VERSION)"

# Manual version setting
set-version:
	@read -p "Enter version (e.g., 1.2.3): " version; \
	$(MAKE) update-all-configs VERSION=$$version; \
	$(MAKE) commit-version VERSION=$$version

# Sync versions if they're out of sync
version-sync:
	@echo "Syncing versions across config files..."
	@$(MAKE) update-all-configs VERSION=$(CURRENT_VERSION)
	@echo "All configs now at version $(CURRENT_VERSION)"

# Show current versions in all files
show-versions:
	@echo "=== Current Versions ==="
	@echo "package.json: $$(jq -r '.version' package.json)"
	@echo "jsr.json:     $$(jq -r '.version // "not set"' jsr.json)"
	@echo "deno.json:    $$(jq -r '.version // "not set"' deno.json)"
