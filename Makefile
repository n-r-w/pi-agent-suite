PACKAGE_DIR := pi-package
PACKAGE_NAME := pi-agent-suite
VERSION := $(shell node -p "require('./$(PACKAGE_DIR)/package.json').version")
TAG := v$(VERSION)
PI_PACKAGES := \
	@earendil-works/pi-agent-core \
	@earendil-works/pi-ai \
	@earendil-works/pi-coding-agent \
	@earendil-works/pi-tui

.PHONY: pi-versions pi-update release-check release-patch release-minor release-major release-tag release-github release-next-steps

# Reports the pinned and latest published version of every Pi development package.
pi-versions:
	@set -e; for package in $(PI_PACKAGES); do \
		current=$$(node -p "require('./package.json').devDependencies['$$package']"); \
		latest=$$(npm view "$$package" version); \
		printf '%s: current=%s latest=%s\n' "$$package" "$$current" "$$latest"; \
	done

# Updates every Pi development package to one explicit version and validates the repository.
pi-update:
	@test -n "$(PI_VERSION)" || { \
		echo "Usage: make pi-update PI_VERSION=0.80.6"; \
		exit 1; \
	}
	@set -e; for package in $(PI_PACKAGES); do \
		actual=$$(npm view "$$package@$(PI_VERSION)" version); \
		test "$$actual" = "$(PI_VERSION)" || { \
			echo "Package $$package does not provide version $(PI_VERSION)"; \
			exit 1; \
		}; \
	done
	bun add --dev --exact $(addsuffix @$(PI_VERSION),$(PI_PACKAGES))
	bun run verify
	./node_modules/.bin/pi --version

release-check:
	bun run release:check

release-patch:
	bun run release:prepare:patch

release-minor:
	bun run release:prepare:minor

release-major:
	bun run release:prepare:major

release-tag:
	git tag $(TAG)
	git push origin $(TAG)

release-github:
	gh release create $(TAG) --repo n-r-w/pi-agent-suite --title "$(TAG)" --generate-notes

release-next-steps:
	@echo "Version: $(VERSION)"
	@echo "Tag: $(TAG)"
	@echo ""
	@echo "Commit release files:"
	@echo "  git add package.json $(PACKAGE_DIR)/package.json README.md .github/workflows/npm-publish.yml Makefile docs/PUBLISHING.md"
	@echo "  git commit -m \"Release $(TAG)\""
	@echo ""
	@echo "Create and push tag:"
	@echo "  make release-tag"
	@echo ""
	@echo "Create GitHub Release and publish $(PACKAGE_NAME) to npm:"
	@echo "  make release-github"

verify:
	bun run verify
