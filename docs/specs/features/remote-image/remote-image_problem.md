# Problem statement

## Context

The user runs pi on a remote server through SSH. Screenshots originate on the local computer. Terms are defined in the [domain glossary](domain-glossary.md).

## Observed problem

Pasting an image into pi over SSH does not make the local image available to the remote pi process. In the user's test, pi ignored the image paste instead of inserting a local path.

## Affected audience

Users who work with pi through SSH and need to provide images from their local computer.

## Evidence

- On September 8, 2026, the user tested image paste into pi through SSH and reported that the paste did nothing.
- The inspected pi implementation, `dist/modes/interactive/interactive-mode.js`, uses `handleClipboardPaste` to read the clipboard in the pi process environment, write an image into `os.tmpdir()`, and insert that file's path into the editor. A remote pi process does not run this operation on the local computer.
- The package's [vision documentation](../../../extensions/vision.md) defines `describe_image` with a required `image_path`. Its loader reads a file from the filesystem available to the tool.

## Impact

The user cannot provide a local screenshot through image paste alone. Separate file transfer and path handling interrupt the interaction with the remote agent.

## Current state

Local pi can create a temporary image file from its clipboard. This does not establish that such a local file exists when only remote pi is running. Even when another local application creates a file, inserting its local path does not transfer its contents through SSH.

## Desired state

The user can provide local images to remote pi without manual file copying or path correction. Setup and daily use are simple. Ideally, the extension package and a small amount of configuration are sufficient, without separately managed applications or manual tunnel startup.

## Problem boundary

The problem covers images supplied by the user from the local computer to remote pi. Sending images from the remote server back to the local computer is outside this problem.

## Open questions

None that block understanding of the problem.
