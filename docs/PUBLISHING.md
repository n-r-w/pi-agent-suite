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

The update target checks that all four packages provide the requested version, writes exact versions to `package.json` and `bun.lock`, runs `bun run verify`, and prints the version of the repository-local Pi executable.

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

The command updates `pi-package/package.json`, runs validation, temporarily copies `README.md` into `pi-package/`, checks the npm tarball, and removes the temporary copy.

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
- `npm pack --dry-run` inside `pi-package/`

The publish workflow runs `bun run verify:ci` because the runtime integration test depends on local pi CLI behavior and is covered by `make release-check` before the release commit. Before checking and publishing the npm package, the workflow copies the root `README.md` into `pi-package/`.

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
