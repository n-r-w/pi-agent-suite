# Publishing

This project publishes the pi package from `pi-package/` to npm as `pi-agent-suite`.

Publishing is done by GitHub Actions when a GitHub Release is published. Do not run `npm publish` locally.

The local release check runs the full test suite, including the runtime integration check. The GitHub publish workflow runs unit-level tests, type checking, formatting checks, and npm package checks before publishing.

## One-time npm setup

Configure npm Trusted Publisher for the package `pi-agent-suite`.

Use these values in npm package settings:

- Publisher: `GitHub Actions`
- Organization or user: `n-r-w`
- Repository: `pi-agent-suite`
- Workflow filename: `npm-publish.yml`
- Environment name: empty

Use the recommended publishing access option:

- `Require two-factor authentication and disallow tokens (recommended)`

No GitHub Actions secret is required. The workflow uses OIDC trusted publishing through `npm publish`. Npm automatically generates provenance for public packages published through Trusted Publisher.

The workflow must not configure npm token authentication. It removes any temporary npm user config and unsets `NODE_AUTH_TOKEN` before publishing so npm uses OIDC trusted publishing.

## Pi dependency updates

Check the pinned and latest published versions of all Pi development packages:

```bash
make pi-versions
```

Update all Pi development packages to one explicit version:

```bash
make pi-update PI_VERSION=0.80.6
```

The update target checks that all four packages provide the requested version, writes exact versions to root `package.json` and `bun.lock`, reinstalls `pi-package/` nested dependencies so `pi-package/node_modules/` matches the root versions, runs `bun run verify`, and prints the version of the repository-local Pi executable.

Review the upstream Pi changes and the resulting repository diff before committing. The target does not update the globally installed Pi.

After the repository passes its checks, update the global Pi installation separately when needed:

```bash
npm install -g @earendil-works/pi-coding-agent@0.80.6
pi --version
```

Restart running Pi processes after updating the global installation.

## Release flow

Choose the release type:

```bash
make release-patch
```

or:

```bash
make release-minor
make release-major
```

The command runs validation, repository audit, and both consumer installation checks before changing the version. Only after all checks pass does it run `npm version` in `pi-package/`. A failed check leaves the version unchanged. Package staging and archives stay in system temporary directories; release checks do not write `pi-package/README.md`.

Print the remaining manual steps:

```bash
make release-next-steps
```

Commit release files:

```bash
VERSION=$(node -p "require('./pi-package/package.json').version")
git add package.json pi-package/package.json README.md .github/workflows/npm-publish.yml Makefile docs/PUBLISHING.md
git commit -m "Release v$VERSION"
```

Create and push the tag:

```bash
make release-tag
```

Create a GitHub Release for the pushed tag:

```bash
make release-github
```

The target runs `gh release create` for the version in `pi-package/package.json` and generates the release notes. Publishing the GitHub Release starts `.github/workflows/npm-publish.yml`, which publishes the npm package.

## Validation commands

Run the release validation without changing the version:

```bash
make release-check
```

This runs:

- `bun run verify`
- `make audit`, using the package's tracked npm lockfile
- Both consumer installation checks, each using an actual npm archive and an isolated Pi package-loading check

The publish workflow runs `bun run verify:ci` because the runtime integration test depends on local pi CLI behavior and is covered by `make release-check` before the release commit. Before checking and publishing the npm package, the workflow copies the root `README.md` into `pi-package/`.

## Consumer installation checks

Run registry-dependent checks without the deterministic test suite:

```bash
bun run release:consumers
```

Run one scenario with `bun scripts/release-consumers.ts SCN-02` or `bun scripts/release-consumers.ts SCN-03`.

- SCN-02 installs the candidate archive in a clean npm consumer.
- SCN-03 uses `test/fixtures/mcp-upgrade-consumer/package.json` and its lockfile to install `pi-agent-suite@2.8.0`. It checks that installed and locked `qs` is `6.15.3` and that the baseline audit identifies a reported `qs` advisory. It then installs the candidate without deleting the lockfile or running a repair command.

Both scenarios use `npm install <archive> --prefix <consumer> --legacy-peer-deps`, matching Pi's npm package manager policy. Pi supplies host APIs, so these consumers do not install host peer dependencies. Each scenario runs `npm audit --omit=dev --audit-level=low` at the consumer root and requires exit code 0. The installed dependency tree must exclude SDK v1, Express, body-parser, and qs. The repository-local Pi CLI must load the installed package with `--no-session --no-extensions --offline -p -e <installed-package>` in temporary project and agent directories. No prompt or provider request is used.

The checks report scenario IDs and audit summaries. Temporary state is removed on success and failure. Registry or audit-service errors block release preparation; do not weaken the audit threshold. A dependency's `package-lock.json` does not constrain consumer installs, so a passing repository audit cannot replace these checks.

The upgrade fixture has no override or direct `qs` dependency. Its lockfile retains the historical vulnerable version. When rebuilding this baseline, preserve the published `2.8.0` manifest and verify the installed version and advisory before accepting a replacement fixture.

The development tree can still contain SDK v1 through the optional `@google/genai` peer used by Pi. Root overrides remain applicable to that locked host tree; this is separate from the published package's mandatory production dependencies.

## Version and tag rule

The GitHub Release tag must match `pi-package/package.json` exactly.

Example:

- `pi-package/package.json` version: `0.1.1`
- Git tag: `v0.1.1`

The workflow fails when the tag and package version do not match.

## After publishing

Check the published npm version:

```bash
npm view pi-agent-suite version
```

Users can install or update with:

```bash
pi install npm:pi-agent-suite
pi update
```

## Common failures

### Version already exists on npm

Npm does not allow publishing the same version twice. Bump `pi-package/package.json` to a new version and publish a new GitHub Release.

### Trusted Publisher error

Check npm package settings:

- repository owner is `n-r-w`;
- repository is `pi-agent-suite`;
- workflow filename is `npm-publish.yml`;
- environment name is empty.

Also check that the workflow has:

```yaml
permissions:
  contents: read
  id-token: write
```

Trusted publishing requires npm CLI `11.5.1` or newer and Node.js `22.14.0` or newer. The workflow uses Node.js `24` and its bundled npm version.

The `repository.url` field in `pi-package/package.json` must match the GitHub repository configured in npm Trusted Publisher.

### Package contents look wrong

Run:

```bash
cd pi-package
npm pack --dry-run
```

The tarball must include `package.json`, `README.md`, `extensions/**`, and `shared/**`.
