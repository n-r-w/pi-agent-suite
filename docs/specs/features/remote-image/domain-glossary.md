# Domain glossary

- Local computer: The user's computer that holds the source image and runs the SSH client.
- Remote server: The machine that runs pi and its tools.
- Local path: A file path in the local computer's filesystem.
- Server path: A file path in the remote server's filesystem.
- Local helper: A program on the local computer that supports image transfer without a local pi process.
- Remote image extension: The pi extension on the remote server that requests an image and inserts its server path into the editor.
- Image transfer port: The loopback TCP port used for image requests on the local computer and remote server.
- SSH target: The destination passed to OpenSSH, expressed as a host, `user@host`, or an SSH configuration alias.
