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

The command updates `pi-package/package.json`, syncs `README.md` to `pi-package/README.md`, runs validation, and checks the npm tarball.

Print the remaining manual steps:

```bash
make release-next-steps
```

Commit release files:

```bash
VERSION=$(node -p "require('./pi-package/package.json').version")
git add package.json pi-package/package.json README.md pi-package/README.md .github/workflows/npm-publish.yml Makefile docs/PUBLISHING.md
git commit -m "Release v$VERSION"
```

Create and push the tag:

```bash
make release-tag
```

Create a GitHub Release for the pushed tag `vX.Y.Z`. Publishing the GitHub Release starts `.github/workflows/npm-publish.yml`, which publishes the npm package.

## Validation commands

Run the release validation without changing the version:

```bash
make release-check
```

This runs:

- `bun run verify`
- `npm pack --dry-run` inside `pi-package/`

The publish workflow runs `bun run verify:ci` because the runtime integration test depends on local pi CLI behavior and is covered by `make release-check` before the release commit.

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

Trusted publishing requires npm CLI `11.5.1` or newer and Node.js `22.14.0` or newer. The workflow uses Node.js `24` and updates npm before publishing.

### Package contents look wrong

Run:

```bash
cd pi-package
npm pack --dry-run
```

The tarball must include `package.json`, `README.md`, `extensions/**`, and `shared/**`.
