PACKAGE_DIR := pi-package
PACKAGE_NAME := pi-agent-suite
VERSION := $(shell node -p "require('./$(PACKAGE_DIR)/package.json').version")
TAG := v$(VERSION)

.PHONY: release-check release-patch release-minor release-major release-tag release-next-steps

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

release-next-steps:
	@echo "Version: $(VERSION)"
	@echo "Tag: $(TAG)"
	@echo ""
	@echo "Commit release files:"
	@echo "  git add package.json $(PACKAGE_DIR)/package.json README.md $(PACKAGE_DIR)/README.md .github/workflows/npm-publish.yml Makefile docs/PUBLISHING.md"
	@echo "  git commit -m \"Release $(TAG)\""
	@echo ""
	@echo "Create and push tag:"
	@echo "  make release-tag"
	@echo ""
	@echo "Then create GitHub Release for $(TAG). The GitHub Actions workflow will publish $(PACKAGE_NAME) to npm."
